const SEED_URL = chrome.runtime.getURL('data/blocklist.json');
const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SYNC_ALARM = 'ytm-aiban-sync';
const MB_UA = 'ytm-aiban/0.2 (https://github.com/; AI-music blocklist extension)';

// Refresh the bundled blocklist on every install/update so rebuilds of
// data/blocklist.json land in storage. User data (whitelist, userBlocklist)
// lives in separate keys and is never touched here.
chrome.runtime.onInstalled.addListener(async () => {
  const seed = await (await fetch(SEED_URL)).json();
  const existing = await chrome.storage.local.get(['whitelist', 'userBlocklist', 'enabled']);
  await chrome.storage.local.set({
    blocklist: seed,
    whitelist: existing.whitelist ?? { channelIds: [], names: [], spotifyIds: [] },
    userBlocklist: existing.userBlocklist ?? { artists: [] },
    enabled: existing.enabled ?? true,
  });
  console.log('[ytm-aiban] seeded blocklist:', seed.stats);
  installMbUaRule();
  scheduleSync();
});

chrome.runtime.onStartup.addListener(() => {
  installMbUaRule();
  scheduleSync();
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
  }).catch((e) => console.warn('[ytm-aiban] DNR rule failed:', e));
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
});
