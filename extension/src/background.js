const SEED_URL = chrome.runtime.getURL('data/blocklist.json');
const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SYNC_ALARM = 'ammit-sync';
const MB_UA = 'ammit/0.4 (https://github.com/CappyT/ammit; AI-music blocklist extension)';

// Refresh the bundled blocklist on every install/update so rebuilds of
// data/blocklist.json land in storage. User data (whitelist, userBlocklist)
// lives in separate keys and is never touched here.
chrome.runtime.onInstalled.addListener(async () => {
  const seed = await (await fetch(SEED_URL)).json();
  const existing = await chrome.storage.local.get(['whitelist', 'userBlocklist', 'enabled', 'installId']);
  await chrome.storage.local.set({
    blocklist: seed,
    whitelist: existing.whitelist ?? { channelIds: [], names: [], spotifyIds: [] },
    userBlocklist: existing.userBlocklist ?? { artists: [] },
    enabled: existing.enabled ?? true,
    // Anonymous random id for community reporting (rate limiting + vote dedup
    // server-side); carries no user data and never changes after install.
    installId: existing.installId ?? crypto.randomUUID(),
  });
  console.log('[ammit] seeded blocklist:', seed.stats);
  installMbUaRule();
  scheduleSync();
  scheduleFlush();
});

chrome.runtime.onStartup.addListener(() => {
  installMbUaRule();
  scheduleSync();
  scheduleFlush();
  maybeSync();
});

// --- MusicBrainz User-Agent (fix #7) ---
// fetch() cannot set User-Agent in MV3 (forbidden header), and MusicBrainz
// throttles requests without a descriptive UA. A declarativeNetRequest rule
// rewrites it for musicbrainz.org requests.
function installMbUaRule() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'user-agent', operation: 'set', value: MB_UA }],
      },
      condition: { urlFilter: '||musicbrainz.org/', resourceTypes: ['xmlhttprequest'] },
    }],
  }).catch((e) => console.warn('[ammit] DNR rule failed:', e));
}

// --- MusicBrainz presence lookup (fix #6: strictly serialized) ---
// Cross-origin, so it must run here. Cached forever by normalized name. All
// lookups run through one promise chain so they are spaced ≥1.2s apart even
// when many fire concurrently from multiple tabs.
let mbChain = Promise.resolve();
function mbLookup(name) {
  const result = mbChain.then(() => mbLookupNow(name));
  mbChain = result.catch(() => {}); // keep the chain alive on failure
  return result;
}

let mbLast = 0;
async function mbLookupNow(name) {
  const key = (name ?? '').trim().toLowerCase();
  if (!key) return null;
  const { mbCache = {} } = await chrome.storage.local.get('mbCache');
  if (key in mbCache) return mbCache[key]; // deduped: earlier queued call cached it

  const wait = mbLast + 1200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  mbLast = Date.now();

  try {
    const url = `https://musicbrainz.org/ws/2/artist?query=artist:${encodeURIComponent(JSON.stringify(name))}&fmt=json&limit=3`;
    const res = await fetch(url);
    if (!res.ok) return null; // don't cache failures
    const j = await res.json();
    const present = (j.artists ?? []).some((a) => a.score >= 90 && a.name.toLowerCase() === key);
    const store = (await chrome.storage.local.get('mbCache')).mbCache ?? {};
    store[key] = present;
    await chrome.storage.local.set({ mbCache: store });
    return present;
  } catch {
    return null;
  }
}

// --- verdict cache (fix #8: single serialized writer) ---
// Content scripts (YT + Spotify tabs) post their heuristic verdicts here so the
// read-modify-write of the shared verdictCache never interleaves across contexts.
let verdictChain = Promise.resolve();
function cacheVerdict(key, entry) {
  const result = verdictChain.then(async () => {
    const { verdictCache = {} } = await chrome.storage.local.get('verdictCache');
    verdictCache[key] = entry;
    await chrome.storage.local.set({ verdictCache });
  });
  verdictChain = result.catch(() => {});
  return result;
}

// --- Community reporting (docs/crowdsourcing-v2.md) ---
// POST to the configured report API; the server replies with CORS headers so
// no host permission is needed. No-op until the user sets a reportUrl.

// Server-driven dials (PoW difficulty, sampling): GET <base>/v1/config,
// cached 10 minutes. The server can tighten anti-abuse without an extension
// release. Fail-open with safe defaults when unreachable.
async function backendConfig(reportUrl) {
  const base = reportUrl.replace(/\/v1\/reports.*$/, '');
  const { backendCfg } = await chrome.storage.local.get('backendCfg');
  if (backendCfg?.base === base && Date.now() - backendCfg.ts < 600e3) return backendCfg;
  try {
    const res = await fetch(base + '/v1/config');
    const j = await res.json();
    const cfg = {
      base,
      bits: j.pow?.bits ?? 16,
      ttlSec: j.pow?.ttlSec ?? 300,
      sampling: j.sampling ?? 1,
      ts: Date.now(),
    };
    await chrome.storage.local.set({ backendCfg: cfg });
    return cfg;
  } catch {
    return { base, bits: 16, sampling: 1, ts: 0 };
  }
}

const leadingZeroBits = (bytes) => {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
};

// Stateless hashcash the server requires on every report:
// sha256(installId|artistId|ts|nonce) with >= bits leading zero bits.
async function mintPow(installId, artistId, bits) {
  const ts = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  for (let nonce = 0; ; nonce++) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${installId}|${artistId}|${ts}|${nonce}`));
    if (leadingZeroBits(new Uint8Array(digest)) >= bits) return `${ts}:${nonce}`;
  }
}

// Deterministic sampling: hash(installId) in [0,1) — stable per install, so
// the server can shrink report volume fleet-wide via /v1/config.
async function samplingSlot(installId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installId));
  return new DataView(digest).getUint32(0) / 2 ** 32;
}

// Reporting is strictly OPT-IN (contribute must be explicitly true) and
// BATCHED: Block/Not-AI clicks only queue locally; a periodic alarm flushes
// the queue — one config fetch and one PoW per queued report per flush, no
// network chatter on user actions.
const FLUSH_ALARM = 'ammit-report-flush';
const FLUSH_PERIOD_MIN = 60;
const MAX_ATTEMPTS = 5;

async function enqueueReport(payload) {
  const { contribute, reportUrl } = await chrome.storage.local.get(['contribute', 'reportUrl']);
  if (contribute !== true || !reportUrl) return { ok: false, reason: 'reporting disabled (opt-in)' };
  if (!payload?.artistId) return { ok: false, reason: 'no artist id' }; // name-only: server would reject
  const { reportQueue = [] } = await chrome.storage.local.get('reportQueue');
  const key = (p) => `${p.platform}:${p.artistId}:${p.action}`;
  if (!reportQueue.some((q) => key(q.payload) === key(payload))) {
    reportQueue.push({ payload, attempts: 0, ts: Date.now() });
    await chrome.storage.local.set({ reportQueue });
  }
  return { ok: true, queued: reportQueue.length };
}

async function flushReports() {
  const { contribute, reportUrl, installId, reportQueue = [] } =
    await chrome.storage.local.get(['contribute', 'reportUrl', 'installId', 'reportQueue']);
  if (contribute !== true || !reportUrl || reportQueue.length === 0) return { ok: true, flushed: 0 };

  const cfg = await backendConfig(reportUrl);
  // Sampled-out installs drop their queue entirely (deterministic per install,
  // served by the server via /v1/config to shrink fleet-wide volume).
  if ((await samplingSlot(installId)) >= cfg.sampling) {
    await chrome.storage.local.set({ reportQueue: [] });
    return { ok: true, flushed: 0, sampledOut: true };
  }

  const remaining = [];
  let flushed = 0;
  for (const item of reportQueue) {
    try {
      const pow = await mintPow(installId, item.payload.artistId, cfg.bits);
      const res = await fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ammit-Pow': pow },
        body: JSON.stringify({ ...item.payload, installId, extVersion: chrome.runtime.getManifest().version }),
      });
      if (res.ok) { flushed++; continue; }
      if (res.status === 400) continue; // malformed will never succeed — drop
      throw new Error(`http ${res.status}`);
    } catch {
      if (++item.attempts < MAX_ATTEMPTS) remaining.push(item);
    }
  }
  await chrome.storage.local.set({ reportQueue: remaining });
  console.log('[ammit] report flush:', flushed, 'sent,', remaining.length, 'kept');
  return { ok: true, flushed, kept: remaining.length };
}

function scheduleFlush() {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MIN, delayInMinutes: 1 });
}

// --- Remote blocklist sync (fix #4: periodic, not only on startup) ---
async function syncBlocklist() {
  const { syncUrl } = await chrome.storage.local.get('syncUrl');
  if (!syncUrl) return { ok: false, reason: 'no syncUrl configured' };
  try {
    const res = await fetch(syncUrl, { cache: 'no-cache' });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const list = await res.json();
    if (!Array.isArray(list.artists)) return { ok: false, reason: 'bad format' };
    await chrome.storage.local.set({ blocklist: list, lastSync: Date.now() });
    return { ok: true, count: list.artists.length };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

async function maybeSync() {
  const { lastSync = 0, syncUrl } = await chrome.storage.local.get(['lastSync', 'syncUrl']);
  if (syncUrl && Date.now() - lastSync > SYNC_MAX_AGE_MS) syncBlocklist();
}

function scheduleSync() {
  // A periodic alarm keeps a long-lived browser session refreshing (onStartup
  // alone never fires again once the browser stays open past the staleness age).
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 360 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) maybeSync();
  if (alarm.name === FLUSH_ALARM) flushReports();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'mb-lookup') {
    mbLookup(msg.name).then(sendResponse);
    return true;
  }
  if (msg.type === 'cache-verdict') {
    cacheVerdict(msg.key, msg.entry).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'sync-now') {
    syncBlocklist().then(sendResponse);
    return true;
  }
  if (msg.type === 'submit-report') {
    enqueueReport(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === 'flush-reports') {
    flushReports().then(sendResponse);
    return true;
  }
});
