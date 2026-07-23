// Ammit content script.
// Watches the player bar for track changes; when the current artist matches
// the blocklist (or the heuristic scorer says AI), dislikes the track and
// skips to the next one.
//
// Selectors verified live on music.youtube.com (2026-07, player bar DOM):
// - artist links:   .byline a[href^="channel/"]  (multiple for collabs)
// - dislike:        #button-shape-dislike button
// - like state:     ytmusic-like-button-renderer[like-status] = INDIFFERENT|LIKE|DISLIKE
// - next:           .next-button button
// aria-labels are localized — never match on them.
//
// The player bar has no readable track identity (videoId lives in Polymer
// props, main world only), so every action is transactional on DOM reads:
// act only on a track observed stable across two reads, and re-verify the
// track right before clicking dislike and again before skipping. Otherwise a
// mid-transition read (or an async verdict landing after a natural track
// change) would dislike the wrong, innocent song.

// Probed by the background's reviveTabs() sweep: set = this isolated world is
// alive, don't reinject. A stale world (extension reloaded) is a different,
// fresh world where this marker is unset.
globalThis.__ammitAlive = true;

// Firefox only returns promises on browser.* (its chrome.* is callback-based),
// so alias it: every `await chrome.*` below then works on both browsers.
if (typeof browser !== 'undefined') globalThis.chrome = browser;

const TAG = '[ammit]';
const STABILITY_MS = 250; // two identical reads this far apart = not mid-transition
const SKIP_DELAY_MS = 400; // let the dislike request fire before navigating away

const SEL = {
  playerBar: 'ytmusic-player-bar',
  title: 'ytmusic-player-bar .title',
  byline: 'ytmusic-player-bar .byline',
  likeRenderer: 'ytmusic-player-bar ytmusic-like-button-renderer',
  dislike: 'ytmusic-player-bar #button-shape-dislike button',
  next: 'ytmusic-player-bar .next-button button',
};

let state = {
  enabled: true,
  aiThreshold: ammit.DEFAULT_AI_THRESHOLD,
  heuristicAuto: false, // blocklist-first: heuristic verdicts act only when opted in
  actionFull: false, // default skip-only; dislike is opt-in
  whitelist: { channelIds: [], names: [] },
  byChannelId: new Map(),
  byName: new Map(),
  verdictCache: {},
  inflight: new Set(),
  lastTrackKey: null,
};

const norm = (s) => (s || '').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trackKey = (t) => `${t.artists.map((a) => a.channelId ?? a.name).join(',')}::${t.title}`;

function buildIndex(blocklist, userBlocklist) {
  state.byChannelId = new Map();
  state.byName = new Map();
  for (const entry of [...(blocklist?.artists ?? []), ...(userBlocklist?.artists ?? [])]) {
    if (entry.channelId) state.byChannelId.set(entry.channelId, entry);
    if (entry.name) state.byName.set(norm(entry.name), entry);
  }
  console.log(TAG, 'index built:', state.byChannelId.size, 'channel ids,', state.byName.size, 'names');
}

// The byline is "artists • album • year". Credited artists appear as channel
// anchors OR as plain text (labels and artists without a channel page get no
// link). Walk child nodes in byline order so unlinked names survive —
// anchor-only extraction dropped them, leaving e.g. only the featured artist
// of a collab to be classified. Stop at the first "•": album/year follow.
function parseBylineArtists(byline) {
  const artists = [];
  const pushNames = (text) => {
    for (const part of text.split(/[,&•]|\s(?:feat\.?|ft\.?|featuring)\s/i)) {
      const name = part.trim();
      if (name) artists.push({ name, channelId: null });
    }
  };
  for (const node of byline.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && node.matches('a[href^="channel/"]')) {
      artists.push({
        name: node.textContent.trim(),
        channelId: node.getAttribute('href').match(/channel\/(UC[\w-]+)/)?.[1] ?? null,
      });
      continue;
    }
    const text = node.textContent ?? '';
    const cut = text.indexOf('•');
    pushNames(cut === -1 ? text : text.slice(0, cut));
    if (cut !== -1) break;
  }
  return artists;
}

function getCurrentTrack() {
  const title = document.querySelector(SEL.title)?.textContent?.trim();
  if (!title) return null;
  const byline = document.querySelector(SEL.byline);
  return { title, artists: byline ? parseBylineArtists(byline) : [] };
}

function isWhitelisted({ name, channelId }) {
  return (
    (channelId && state.whitelist.channelIds.includes(channelId)) ||
    state.whitelist.names.some((n) => norm(n) === norm(name))
  );
}

function matchBlocklist({ name, channelId }) {
  return (channelId && state.byChannelId.get(channelId)) || state.byName.get(norm(name)) || null;
}

// A clearly-human artist never collabs with an AI act — axiom, so a credited
// artist we're confident is human clears the whole track: a blocklist/AI hit
// on their collaborator is a homonym or false positive. Confidence =
// whitelisted, heuristic 'human' verdict, or a MusicBrainz exact-name entry
// (the curated index AI slop is reliably absent from — the scorer's own +3
// signal, inverted). Solo tracks are out of scope: an artist never vouches
// for themselves, and neither does a blocklisted or AI-scored collaborator.
function clearlyHuman(artists) {
  if (artists.length < 2) return null;
  return artists.find((a) => {
    if (isWhitelisted(a)) return true;
    if (matchBlocklist(a)) return false;
    const entry = a.channelId ? state.verdictCache[a.channelId] : null;
    if (!entry || entry.fv !== ammit.FEATURES_VERSION) return false;
    const res = cachedVerdict(entry);
    return res?.verdict === 'human' || (entry.features?.mbPresent === true && res?.verdict !== 'ai');
  }) ?? null;
}

function verdict(track) {
  const human = clearlyHuman(track.artists);
  if (human) return { blocked: false, clearedBy: human };
  for (const artist of track.artists) {
    if (isWhitelisted(artist)) continue;
    const hit = matchBlocklist(artist);
    if (hit) return { blocked: true, artist, entry: hit };
  }
  return { blocked: false };
}

function clickDislike() {
  const renderer = document.querySelector(SEL.likeRenderer);
  if (renderer?.getAttribute('like-status') === 'DISLIKE') return true; // already disliked
  const btn = document.querySelector(SEL.dislike);
  if (!btn) {
    console.warn(TAG, 'dislike button not found');
    return false;
  }
  btn.click();
  return true;
}

function clickNext() {
  const btn = document.querySelector(SEL.next);
  if (!btn) {
    console.warn(TAG, 'next button not found');
    return false;
  }
  btn.click();
  return true;
}

function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '92px',
    right: '60px', // clear of the Ammit widget button
    zIndex: 99999,
    background: '#1b1b1e',
    color: '#ececf0',
    border: '1px solid #2c2c30',
    borderLeft: '3px solid #d4a017',
    padding: '9px 13px',
    borderRadius: '10px',
    font: '13px system-ui, sans-serif',
    boxShadow: '0 6px 22px rgba(0,0,0,.5)',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Skip (default) or dislike + delayed skip (actionFull opt-in), gated on the
// player bar still showing the condemned track. If the track changed in the
// meantime (natural end, user action, async verdict landing late), do nothing —
// never touch an innocent song.
function nuke(artistName, expectedKey) {
  const now = getCurrentTrack();
  if (!now || trackKey(now) !== expectedKey) {
    console.warn(TAG, 'nuke aborted — track changed before dislike');
    return;
  }
  // The user's explicit LIKE on this track outranks any verdict — never
  // dislike/skip a liked track (a stale verdict once disliked a liked OST song).
  if (document.querySelector(SEL.likeRenderer)?.getAttribute('like-status') === 'LIKE') {
    console.log(TAG, 'nuke vetoed — track is liked by the user');
    return;
  }
  if (!state.actionFull) {
    const skipped = clickNext();
    toast(skipped ? chrome.i18n.getMessage('toastSkipped', [artistName]) : chrome.i18n.getMessage('toastFailed'));
    return;
  }
  const disliked = clickDislike();
  setTimeout(() => {
    const after = getCurrentTrack();
    if (!after || trackKey(after) !== expectedKey) {
      console.log(TAG, 'skip skipped — track already changed');
      return;
    }
    const skipped = clickNext();
    toast(disliked && skipped ? chrome.i18n.getMessage('toastDevoured', [artistName]) : chrome.i18n.getMessage('toastFailed'));
  }, SKIP_DELAY_MS);
}

let evaluating = false;
async function onPossibleTrackChange() {
  if (!state.enabled || evaluating) return;
  const t1 = getCurrentTrack();
  if (!t1) return;
  const key = trackKey(t1);
  if (key === state.lastTrackKey) return;

  evaluating = true;
  try {
    // Require a second identical read: mid-transition the title and byline
    // update at different times and a mixed read blames the wrong artist.
    await sleep(STABILITY_MS);
    const t2 = getCurrentTrack();
    if (!t2 || trackKey(t2) !== key) return; // unstable — the next mutation retries
    state.lastTrackKey = key;

    const likeStatus = document.querySelector(SEL.likeRenderer)?.getAttribute('like-status');
    console.log(TAG, 'now playing:', JSON.stringify(t2), 'like-status:', likeStatus);

    const v = verdict(t2);
    if (v.clearedBy) console.log(TAG, 'track cleared — human collaborator:', v.clearedBy.name);
    if (v.blocked) {
      console.log(TAG, 'BLOCKED artist:', v.artist.name, '→', state.actionFull ? 'dislike + skip' : 'skip');
      refreshWidget();
      nuke(v.artist.name, key);
      return;
    }

    // Unknown artists → heuristic scorer (async; nuke() re-verifies the track).
    // Every channel-linked artist is evaluated first, THEN AI verdicts act:
    // with the whole collab scored, clearlyHuman() can overrule a partner's AI
    // verdict no matter which artist happened to be evaluated first.
    (async () => {
      const verdicts = [];
      for (const a of t2.artists) {
        if (!a.channelId || isWhitelisted(a)) continue;
        const v = await evaluateArtist(a);
        if (v) verdicts.push({ artist: a, ...v });
      }
      for (const v of verdicts) {
        if (v.res.verdict === 'ai') actOnAiVerdict(v.artist, v.res, key, v.fresh);
      }
    })();
    refreshWidget();
  } finally {
    evaluating = false;
  }
}

// A cache entry holds FEATURES (facts); score and verdict are derived here from
// the current scorer + threshold, so recalibrations apply retroactively. Entries
// from older extractors (fv mismatch, or legacy score-only) are re-extracted.
const cachedVerdict = (entry) =>
  entry?.features && entry.fv === ammit.FEATURES_VERSION
    ? ammit.scoreFeatures(entry.features, state.aiThreshold)
    : null;

function actOnAiVerdict(artist, res, expectedKey, fresh) {
  // A clearly-human collaborator on the still-playing track overrules the AI
  // verdict (see clearlyHuman) — no nuke, no suspect toast.
  const now = getCurrentTrack();
  if (now && trackKey(now) === expectedKey) {
    const human = clearlyHuman(now.artists);
    if (human) {
      console.log(TAG, 'AI verdict on', artist.name, 'overruled — human collaborator:', human.name);
      return;
    }
  }
  if (state.heuristicAuto) {
    console.log(TAG, 'HEURISTIC block:', artist.name, 'score', res.score);
    nuke(artist.name, expectedKey);
  } else if (fresh) {
    // Blocklist-first default: flag once, let the user confirm from the badge/popup.
    toast(chrome.i18n.getMessage('toastSuspect', [artist.name, String(res.score)]));
  }
}

// Scores one artist (cache-first) and returns { res, fresh } — fresh = newly
// computed, not from cache — or null when no verdict is available (inflight in
// another tab, extraction failed). Deliberately does NOT act on the verdict:
// the caller acts only after the whole collab is scored.
async function evaluateArtist(artist) {
  const cid = artist.channelId;
  const cached = cachedVerdict(state.verdictCache[cid]);
  if (cached) return { res: cached, fresh: false };
  if (state.inflight.has(cid)) return null;
  state.inflight.add(cid);
  try {
    const features = await ammit.extractFeatures(cid);
    features.mbPresent = await chrome.runtime.sendMessage({
      type: 'mb-lookup',
      name: features.name ?? artist.name,
    });
    const res = ammit.scoreFeatures(features, state.aiThreshold);
    const entry = { name: features.name, platform: 'yt', features, fv: ammit.FEATURES_VERSION, ts: Date.now() };
    console.log(TAG, 'heuristic verdict:', artist.name, JSON.stringify(res));

    state.verdictCache[cid] = entry;
    // Persist through the background service worker (single serialized writer)
    // so concurrent writes from other tabs don't clobber the cache.
    chrome.runtime.sendMessage({ type: 'cache-verdict', key: cid, entry });

    refreshWidget();
    return { res, fresh: true };
  } catch (e) {
    console.warn(TAG, 'heuristic failed for', artist.name, String(e));
    return null;
  } finally {
    state.inflight.delete(cid);
  }
}

// The artist the widget/popup should surface, with its verdict. A clearly-
// human collaborator clears the whole track and is shown as the reason it
// plays; otherwise a blocklist hit on ANY credited artist wins, then a cached
// AI verdict on any of them, then the primary artist's own state — so a
// flagged featured artist is never hidden behind an innocent primary.
function displayed(track) {
  const artists = track?.artists ?? [];
  const primary = artists.find((a) => a.channelId) ?? artists[0] ?? null;
  if (!primary) return null;
  const verdictOf = (a) => (a.channelId ? cachedVerdict(state.verdictCache[a.channelId]) : null);
  const human = clearlyHuman(artists);
  if (human) {
    const res = verdictOf(human);
    return {
      artist: human,
      verdict: isWhitelisted(human) ? 'whitelisted' : 'human',
      score: res?.score ?? null,
      reasons: res?.reasons ?? null,
    };
  }
  const blocked = artists.find((a) => !isWhitelisted(a) && matchBlocklist(a));
  if (blocked) return { artist: blocked, verdict: 'blocklist', score: null, reasons: null };
  const scored = artists
    .filter((a) => !isWhitelisted(a))
    .map((a) => ({ artist: a, res: verdictOf(a) }))
    .filter((s) => s.res);
  const ai = scored.find((s) => s.res.verdict === 'ai');
  if (ai) return { artist: ai.artist, verdict: 'ai', score: ai.res.score, reasons: ai.res.reasons };
  if (isWhitelisted(primary)) return { artist: primary, verdict: 'whitelisted', score: null, reasons: null };
  const own = scored.find((s) => s.artist === primary);
  if (own) return { artist: primary, verdict: own.res.verdict, score: own.res.score, reasons: own.res.reasons };
  return { artist: primary, verdict: 'pending', score: null, reasons: null };
}

// --- on-page widget (src/widget.js, loaded before this file) ---
const primaryArtist = () => displayed(getCurrentTrack())?.artist ?? null;

function refreshWidget() {
  const d = displayed(getCurrentTrack());
  const a = d?.artist ?? null;
  ammitWidget.update({
    artist: a?.name ?? null,
    verdict: !state.enabled ? 'disabled' : d?.verdict ?? 'pending',
    score: state.enabled ? d?.score ?? null : null,
    url: !a ? null : a.channelId
      ? `https://music.youtube.com/channel/${a.channelId}`
      : `https://music.youtube.com/search?q=${encodeURIComponent(a.name)}`,
  });
}

const widgetEvidence = (p) => {
  const e = p.channelId ? state.verdictCache[p.channelId] : null;
  return e?.features ? { evidence: { fv: e.fv, features: e.features } } : {};
};

async function widgetBlock() {
  const p = primaryArtist();
  if (!p) return;
  const { userBlocklist = { artists: [] } } = await chrome.storage.local.get('userBlocklist');
  userBlocklist.artists.push({ name: p.name, channelId: p.channelId ?? null, spotifyId: null, confidence: 'confirmed', source: 'user' });
  await chrome.storage.local.set({ userBlocklist });
  if (p.channelId) {
    chrome.runtime.sendMessage({
      type: 'submit-report',
      payload: { platform: 'yt', artistId: p.channelId, name: p.name, action: 'report', ...widgetEvidence(p) },
    });
  }
}

async function widgetNotAi() {
  const p = primaryArtist();
  if (!p) return;
  const data = await chrome.storage.local.get(['whitelist', 'verdictCache']);
  const whitelist = { channelIds: [], names: [], spotifyIds: [], ...(data.whitelist ?? {}) };
  if (p.channelId && !whitelist.channelIds.includes(p.channelId)) whitelist.channelIds.push(p.channelId);
  if (p.name && !whitelist.names.includes(p.name)) whitelist.names.push(p.name);
  const verdictCache = data.verdictCache ?? {};
  const report = p.channelId ? { platform: 'yt', artistId: p.channelId, name: p.name, action: 'not_ai', ...widgetEvidence(p) } : null;
  if (p.channelId) delete verdictCache[p.channelId];
  await chrome.storage.local.set({ whitelist, verdictCache });
  if (report) chrome.runtime.sendMessage({ type: 'submit-report', payload: report });
}

async function loadState() {
  const data = await chrome.storage.local.get(['enabled', 'aiThreshold', 'heuristicAuto', 'actionFull', 'blocklist', 'userBlocklist', 'whitelist', 'verdictCache']);
  state.enabled = data.enabled ?? true;
  state.aiThreshold = data.aiThreshold ?? ammit.DEFAULT_AI_THRESHOLD;
  state.heuristicAuto = data.heuristicAuto ?? false;
  state.actionFull = data.actionFull ?? false;
  state.whitelist = data.whitelist ?? { channelIds: [], names: [] };
  state.verdictCache = data.verdictCache ?? {};
  buildIndex(data.blocklist, data.userBlocklist);
  console.log(TAG, 'enabled =', state.enabled);
}

// Popup asks for the current track + verdict via tabs.sendMessage.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'get-current') return;
  const track = getCurrentTrack();
  const d = displayed(track);
  const verdictInfo = d && d.verdict !== 'pending'
    ? { verdict: d.verdict, score: d.score, reasons: d.reasons }
    : null;
  sendResponse({ track, primary: d?.artist ?? null, verdictInfo });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.whitelist) state.whitelist = changes.whitelist.newValue;
  if (changes.enabled) state.enabled = changes.enabled.newValue;
  if (changes.aiThreshold) state.aiThreshold = changes.aiThreshold.newValue ?? ammit.DEFAULT_AI_THRESHOLD;
  if (changes.heuristicAuto) state.heuristicAuto = changes.heuristicAuto.newValue ?? false;
  if (changes.actionFull) state.actionFull = changes.actionFull.newValue ?? false;
  if (changes.verdictCache) state.verdictCache = changes.verdictCache.newValue ?? {};
  if (changes.blocklist || changes.userBlocklist) {
    const data = await chrome.storage.local.get(['blocklist', 'userBlocklist']);
    buildIndex(data.blocklist, data.userBlocklist);
  }
  // Re-evaluate the current track only when the rules changed — NOT on our own
  // verdictCache/mbCache writes, which land at racy moments (mid-transition).
  if (changes.blocklist || changes.userBlocklist || changes.whitelist || changes.enabled || changes.aiThreshold || changes.heuristicAuto) {
    state.lastTrackKey = null;
    onPossibleTrackChange();
  }
  refreshWidget();
});

function main() {
  loadState().then(() => {
    ammitWidget.init({ bottom: '84px', onBlock: widgetBlock, onNotAi: widgetNotAi });
    const observer = new MutationObserver(() => onPossibleTrackChange());
    const waitForBar = setInterval(() => {
      const bar = document.querySelector(SEL.playerBar);
      if (!bar) return;
      clearInterval(waitForBar);
      observer.observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['like-status'] });
      console.log(TAG, 'player bar observer attached');
      onPossibleTrackChange();
      refreshWidget();
    }, 500);
  });
}

main();
