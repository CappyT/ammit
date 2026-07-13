// Ammit — Spotify content script (isolated world).
// Watches the now-playing widget; when the current artist is on the blocklist,
// skips the track and bans the artist via the main-world bridge (spotify-main.js)
// so Spotify's own engine stops serving them. Free accounts have limited skips,
// but the ban is the durable mechanism.
//
// Selectors verified live on open.spotify.com (2026-07):
// - now playing:  [data-testid=now-playing-widget]
// - artist link:  [data-testid=now-playing-widget] a[href*="/artist/"]  (locale prefix, e.g. /intl-it/artist/<id>)
// - skip:         [data-testid=control-button-skip-forward]

// Probed by the background's reviveTabs() sweep: set = this isolated world is
// alive, don't reinject. A stale world (extension reloaded) is a different,
// fresh world where this marker is unset.
globalThis.__ammitAlive = true;

// Firefox only returns promises on browser.* (its chrome.* is callback-based),
// so alias it: every `await chrome.*` below then works on both browsers.
if (typeof browser !== 'undefined') globalThis.chrome = browser;

const TAG = '[ammit/spotify]';
const NS = 'ammit-spotify';

const SEL = {
  widget: '[data-testid=now-playing-widget]',
  artistLink: '[data-testid=now-playing-widget] a[href*="/artist/"]',
  coverLink: '[data-testid=now-playing-widget] [data-testid=CoverSlotCollapsed__container] a',
  skip: '[data-testid=control-button-skip-forward]',
  // "Add to Liked Songs" toggle: the only aria-checked button in the widget
  // (no data-testid; aria-label is localized — never match on it).
  saved: '[data-testid=now-playing-widget] button[aria-checked]',
};

let state = {
  enabled: true,
  aiThreshold: ammit.DEFAULT_AI_THRESHOLD,
  heuristicAuto: false, // blocklist-first: heuristic verdicts act only when opted in
  actionFull: false, // default skip-only; artist-ban is opt-in
  whitelist: { channelIds: [], names: [], spotifyIds: [] },
  bySpotifyId: new Map(),
  byName: new Map(),
  verdictCache: {},
  inflight: new Set(),
  lastKey: null,
  banned: new Set(),
};

const norm = (s) => (s || '').trim().toLowerCase();
const artistIdFrom = (href) => href?.match(/\/artist\/([a-zA-Z0-9]+)/)?.[1] ?? null;

function buildIndex(blocklist, userBlocklist) {
  state.bySpotifyId = new Map();
  state.byName = new Map();
  for (const e of [...(blocklist?.artists ?? []), ...(userBlocklist?.artists ?? [])]) {
    if (e.spotifyId) state.bySpotifyId.set(e.spotifyId, e);
    if (e.name) state.byName.set(norm(e.name), e);
  }
  console.log(TAG, 'index:', state.bySpotifyId.size, 'spotify ids,', state.byName.size, 'names');
}

function getCurrent() {
  const widget = document.querySelector(SEL.widget);
  if (!widget) return null;
  const artists = [...widget.querySelectorAll('a[href*="/artist/"]')].map((a) => ({
    spotifyId: artistIdFrom(a.getAttribute('href')),
    name: a.textContent.trim(),
  }));
  if (!artists.length) return null;
  // Per-track id from the cover link's ?uri=spotify:track:<id> when present
  // (not always — radio/autoplay contexts omit it), else album href + track
  // title. Both change per track and don't flicker within one track.
  const coverHref = document.querySelector(SEL.coverLink)?.getAttribute('href') ?? '';
  const trackId = decodeURIComponent(coverHref).match(/spotify:track:([a-zA-Z0-9]+)/)?.[1] ?? null;
  const titleEl = widget.querySelector('[data-testid=context-item-link]');
  const album = titleEl?.getAttribute('href')?.match(/\/album\/([a-zA-Z0-9]+)/)?.[1] ?? '';
  const title = titleEl?.textContent?.trim() ?? widget.getAttribute('aria-label') ?? '';
  return { artists, title, album, trackId };
}

function isWhitelisted({ spotifyId, name }) {
  return (
    (spotifyId && state.whitelist.spotifyIds?.includes(spotifyId)) ||
    state.whitelist.names.some((n) => norm(n) === norm(name))
  );
}

function matchOne({ spotifyId, name }) {
  return (spotifyId && state.bySpotifyId.get(spotifyId)) || state.byName.get(norm(name)) || null;
}

// All credited artists that are blocklisted and not whitelisted. `ban` is true
// only when the match is on the artist's real spotifyId AND the entry is
// 'confirmed' (user blocks and human-moderated crowd entries) — a name-only
// match (possibly a legitimate homonym) or a lower tier ('suspected' from the
// imported lists, 'community' auto-promoted by report thresholds) must never
// trigger a permanent ban; they only skip.
function blockedArtists(cur) {
  return cur.artists
    .filter((a) => !isWhitelisted(a) && matchOne(a))
    .map((a) => ({ ...a, ban: state.bySpotifyId.get(a.spotifyId ?? '')?.confidence === 'confirmed' }));
}

let bridgeSeq = 0;
function bridge(type, artistId) {
  return new Promise((resolve) => {
    const id = ++bridgeSeq;
    const timer = setTimeout(() => { window.removeEventListener('message', handler); resolve({ ok: false, reason: 'timeout' }); }, 8000);
    function handler(ev) {
      if (ev.source !== window || ev.data?.ns !== NS || ev.data?.dir !== 'res' || ev.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(ev.data.payload);
    }
    window.addEventListener('message', handler);
    window.postMessage({ ns: NS, dir: 'req', id, type, artistId }, '*');
  });
}

function clickSkip() {
  const btn = document.querySelector(SEL.skip);
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '104px', left: '50%', transform: 'translateX(-50%)',
    zIndex: 99999, background: '#1b1b1e', color: '#ececf0',
    border: '1px solid #2c2c30', borderLeft: '3px solid #d4a017',
    padding: '9px 13px', borderRadius: '10px', font: '13px system-ui, sans-serif',
    boxShadow: '0 6px 22px rgba(0,0,0,.5)',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function onChange() {
  if (!state.enabled) return;
  const cur = getCurrent();
  if (!cur) return;
  // Key on per-track identity so we re-fire on every track — including
  // consecutive songs by the same blocked artist (the case where a ban left
  // the next queued track playing) — but not on flicker within one track.
  // Ads have no artist link → getCurrent() null → ignored.
  const key = cur.trackId ?? `${cur.album}::${cur.title}::${cur.artists.map((a) => a.spotifyId ?? norm(a.name)).join(',')}`;
  if (key === state.lastKey) return;
  state.lastKey = key;

  const blocked = blockedArtists(cur);
  if (blocked.length) {
    refreshWidget();
    await nuke(blocked, cur.trackId);
    return;
  }

  // Unknown artists → heuristic scorer (async). Evaluate every credited artist.
  for (const a of cur.artists) {
    if (a.spotifyId && !isWhitelisted(a)) evaluateArtist(a, cur.trackId);
  }
  refreshWidget();
}

// Skip the current track and — with actionFull opted in — ban each target
// flagged `ban` (once each), so Spotify's engine stops serving them even in
// collabs. Default is skip-only. Targets: [{name, spotifyId, ban}].
async function nuke(targets, trackId) {
  const names = targets.map((a) => a.name).join(', ');
  // The user's explicit save ("Liked Songs") on this track outranks any verdict.
  if (document.querySelector(SEL.saved)?.getAttribute('aria-checked') === 'true') {
    console.log(TAG, 'nuke vetoed — track is in the user\'s Liked Songs');
    return;
  }
  const banning = state.actionFull && targets.some((t) => t.ban);
  console.log(TAG, 'BLOCKED:', names, '→ skip' + (banning ? ' + ban' : ''));
  // Skip only if the now-playing STILL credits one of these targets. This is
  // robust when trackId is null (radio/autoplay omit it) and a late async
  // heuristic verdict lands after the track already advanced — never skip an
  // innocent track just because it happens to be playing now.
  const now = getCurrent();
  const stillPlaying = !!now && now.artists.some((a) =>
    targets.some((t) => (t.spotifyId && t.spotifyId === a.spotifyId) || norm(t.name) === norm(a.name)));
  const skipped = stillPlaying ? clickSkip() : false;
  if (!stillPlaying) console.log(TAG, 'skip suppressed — target no longer playing');

  const bans = [];
  if (banning) {
    for (const a of targets) {
      if (!a.ban || !a.spotifyId) continue; // name-only match → skip only, never ban
      if (state.banned.has(a.spotifyId)) { bans.push({ name: a.name, ok: true, cached: true }); continue; }
      const r = await bridge('ban', a.spotifyId);
      if (r.ok) state.banned.add(a.spotifyId);
      bans.push({ name: a.name, ...r });
    }
  }
  console.log(TAG, 'result:', JSON.stringify({ skipped, bans }));
  const devoured = bans.length > 0 && bans.every((b) => b.ok);
  toast(chrome.i18n.getMessage(devoured ? 'toastDevoured' : skipped ? 'toastSkipped' : 'toastFailed', [names]));
}

// See content.js: cache holds FEATURES; verdicts derive from the current
// scorer + threshold at decision time. fv-mismatched/legacy entries re-extract.
const cachedVerdict = (entry) =>
  entry?.features && entry.fv === ammit.FEATURES_VERSION
    ? ammit.scoreFeatures(entry.features, state.aiThreshold)
    : null;

// Heuristic verdict acts on the artist's own (real) spotifyId → bannable.
function actOnAiVerdict(artist, res, trackId, fresh) {
  if (state.heuristicAuto) nuke([{ ...artist, ban: true }], trackId);
  else if (fresh) toast(chrome.i18n.getMessage('toastSuspect', [artist.name, String(res.score)]));
}

async function evaluateArtist(artist, trackId) {
  const cid = artist.spotifyId;
  const cached = cachedVerdict(state.verdictCache[cid]);
  if (cached) {
    if (cached.verdict === 'ai') actOnAiVerdict(artist, cached, trackId, false);
    return;
  }
  if (state.inflight.has(cid)) return;
  state.inflight.add(cid);
  try {
    const features = await bridge('features', cid);
    if (features?._err || features?.ok === false) {
      console.log(TAG, 'features failed for', artist.name, features?._err ?? features?.reason);
      return;
    }
    features.mbPresent = await chrome.runtime.sendMessage({ type: 'mb-lookup', name: features.name ?? artist.name });
    const res = ammit.scoreFeatures(features, state.aiThreshold);
    const entry = { name: features.name, platform: 'sp', features, fv: ammit.FEATURES_VERSION, ts: Date.now() };
    console.log(TAG, 'heuristic verdict:', artist.name, JSON.stringify(res));

    state.verdictCache[cid] = entry;
    // Persist through the background SW (single serialized writer).
    chrome.runtime.sendMessage({ type: 'cache-verdict', key: cid, entry });

    refreshWidget();
    if (res.verdict === 'ai') actOnAiVerdict(artist, res, trackId, true);
  } catch (e) {
    console.warn(TAG, 'heuristic failed for', artist.name, String(e));
  } finally {
    state.inflight.delete(cid);
  }
}

// --- on-page widget (src/widget.js, loaded before this file) ---
const primaryArtist = () => getCurrent()?.artists?.[0] ?? null;

function refreshWidget() {
  const cur = getCurrent();
  const p = cur?.artists?.[0] ?? null;
  let verdict = 'pending', score = null;
  if (!state.enabled) verdict = 'disabled';
  else if (cur) {
    const blocked = cur.artists.find((a) => matchOne(a) && !isWhitelisted(a));
    if (blocked) verdict = 'blocklist';
    else if (p && isWhitelisted(p)) verdict = 'whitelisted';
    else if (p?.spotifyId) {
      const res = cachedVerdict(state.verdictCache[p.spotifyId]);
      if (res) { verdict = res.verdict; score = res.score; }
    }
  }
  ammitWidget.update({ artist: p?.name ?? null, verdict, score });
}

const widgetEvidence = (p) => {
  const e = p.spotifyId ? state.verdictCache[p.spotifyId] : null;
  return e?.features ? { evidence: { fv: e.fv, features: e.features } } : {};
};

async function widgetBlock() {
  const p = primaryArtist();
  if (!p) return;
  const { userBlocklist = { artists: [] } } = await chrome.storage.local.get('userBlocklist');
  userBlocklist.artists.push({ name: p.name, channelId: null, spotifyId: p.spotifyId ?? null, confidence: 'confirmed', source: 'user' });
  await chrome.storage.local.set({ userBlocklist });
  if (p.spotifyId) {
    chrome.runtime.sendMessage({
      type: 'submit-report',
      payload: { platform: 'sp', artistId: p.spotifyId, name: p.name, action: 'report', ...widgetEvidence(p) },
    });
  }
}

async function widgetNotAi() {
  const p = primaryArtist();
  if (!p) return;
  const data = await chrome.storage.local.get(['whitelist', 'verdictCache']);
  const whitelist = { channelIds: [], names: [], spotifyIds: [], ...(data.whitelist ?? {}) };
  if (p.spotifyId && !whitelist.spotifyIds.includes(p.spotifyId)) whitelist.spotifyIds.push(p.spotifyId);
  if (p.name && !whitelist.names.includes(p.name)) whitelist.names.push(p.name);
  const verdictCache = data.verdictCache ?? {};
  const report = p.spotifyId ? { platform: 'sp', artistId: p.spotifyId, name: p.name, action: 'not_ai', ...widgetEvidence(p) } : null;
  if (p.spotifyId) delete verdictCache[p.spotifyId];
  await chrome.storage.local.set({ whitelist, verdictCache });
  if (report) chrome.runtime.sendMessage({ type: 'submit-report', payload: report });
}

async function loadState() {
  const data = await chrome.storage.local.get(['enabled', 'aiThreshold', 'heuristicAuto', 'actionFull', 'blocklist', 'userBlocklist', 'whitelist', 'verdictCache']);
  state.enabled = data.enabled ?? true;
  state.aiThreshold = data.aiThreshold ?? ammit.DEFAULT_AI_THRESHOLD;
  state.heuristicAuto = data.heuristicAuto ?? false;
  state.actionFull = data.actionFull ?? false;
  state.whitelist = { channelIds: [], names: [], spotifyIds: [], ...(data.whitelist ?? {}) };
  state.verdictCache = data.verdictCache ?? {};
  buildIndex(data.blocklist, data.userBlocklist);
  console.log(TAG, 'enabled =', state.enabled);
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.whitelist) state.whitelist = { channelIds: [], names: [], spotifyIds: [], ...changes.whitelist.newValue };
  if (changes.enabled) state.enabled = changes.enabled.newValue;
  if (changes.aiThreshold) state.aiThreshold = changes.aiThreshold.newValue ?? ammit.DEFAULT_AI_THRESHOLD;
  if (changes.heuristicAuto) state.heuristicAuto = changes.heuristicAuto.newValue ?? false;
  if (changes.actionFull) state.actionFull = changes.actionFull.newValue ?? false;
  if (changes.verdictCache) state.verdictCache = changes.verdictCache.newValue ?? {};
  if (changes.blocklist || changes.userBlocklist) {
    const data = await chrome.storage.local.get(['blocklist', 'userBlocklist']);
    buildIndex(data.blocklist, data.userBlocklist);
  }
  // Re-evaluate only on rule changes — not on our own verdictCache writes.
  if (changes.blocklist || changes.userBlocklist || changes.whitelist || changes.enabled || changes.aiThreshold || changes.heuristicAuto) {
    state.lastKey = null;
    onChange();
  }
  refreshWidget();
});

// Popup query.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'get-current') return;
  const cur = getCurrent();
  const primary = cur?.artists?.[0] ?? null;
  let verdictInfo = null;
  if (primary) {
    const blocked = cur.artists.find((a) => matchOne(a) && !isWhitelisted(a));
    if (blocked) verdictInfo = { verdict: 'blocklist' };
    else if (isWhitelisted(primary)) verdictInfo = { verdict: 'whitelisted' };
    else if (primary.spotifyId) {
      const res = cachedVerdict(state.verdictCache[primary.spotifyId]);
      if (res) verdictInfo = { verdict: res.verdict, score: res.score, reasons: res.reasons };
    }
  }
  sendResponse({ track: cur ? { title: cur.title, artists: cur.artists } : null, primary, verdictInfo });
});

function main() {
  loadState().then(() => {
    ammitWidget.init({ bottom: '96px', onBlock: widgetBlock, onNotAi: widgetNotAi });
    const observer = new MutationObserver(() => onChange());
    const wait = setInterval(() => {
      const w = document.querySelector(SEL.widget);
      if (!w) return;
      clearInterval(wait);
      // Observe the whole footer: the widget subtree is replaced on track change.
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      console.log(TAG, 'now-playing observer attached');
      onChange();
      refreshWidget();
    }, 500);
  });
}

main();
