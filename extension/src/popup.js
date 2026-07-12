const $ = (id) => document.getElementById(id);
let current = null; // { track, primary, verdictInfo }
let platform = null; // 'ytmusic' | 'spotify'

// Entries hold features; score/verdict derive from the current scorer+threshold
// (heuristics.js is loaded by popup.html). Legacy/fv-mismatched entries → null.
const derive = (entry, threshold) =>
  entry?.features && entry.fv === ammit.FEATURES_VERSION
    ? ammit.scoreFeatures(entry.features, threshold)
    : null;

// Community report (fire-and-forget; the background no-ops unless a report URL
// is configured and contribution is enabled).
function sendReport(action, { platform, artistId, name, entry }) {
  if (!artistId) return;
  chrome.runtime.sendMessage({
    type: 'submit-report',
    payload: {
      platform, artistId, name, action,
      ...(entry?.features ? { evidence: { fv: entry.fv, features: entry.features } } : {}),
    },
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  if (tab.url.startsWith('https://music.youtube.com')) return { tab, platform: 'ytmusic' };
  if (tab.url.startsWith('https://open.spotify.com')) return { tab, platform: 'spotify' };
  return null;
}

function renderCurrent() {
  const el = $('current');
  if (!current?.track) {
    el.textContent = 'no track playing (open music.youtube.com or open.spotify.com)';
    $('block').disabled = $('whitelist').disabled = true;
    return;
  }
  const { track, primary, verdictInfo } = current;
  const v = verdictInfo?.verdict ?? 'unknown';
  el.innerHTML = '';
  const artist = document.createElement('div');
  artist.className = 'artist';
  artist.textContent = primary?.name ?? '?';
  const badge = document.createElement('span');
  badge.className = `verdict ${v}`;
  badge.textContent = v + (verdictInfo?.score != null ? ` (${verdictInfo.score})` : '');
  badge.title = (verdictInfo?.reasons ?? []).join('\n');
  artist.appendChild(badge);
  const title = document.createElement('div');
  title.className = 'muted';
  title.textContent = track.title;
  el.append(artist, title);
  $('block').disabled = !primary || v === 'blocklist';
  $('whitelist').disabled = !primary;
}

// One row per suspected artist (verdict ai/unsure at the current threshold):
// [Block] promotes to userBlocklist, [Not AI] whitelists; both clear the entry.
function renderReview(derived) {
  const rows = derived
    .filter((d) => d.res.verdict === 'ai' || d.res.verdict === 'unsure')
    .sort((a, b) => b.res.score - a.res.score)
    .slice(0, 12);
  const el = $('review');
  el.innerHTML = '';
  $('review-title').style.display = rows.length ? '' : 'none';
  for (const { key, entry, res } of rows) {
    const row = document.createElement('div');
    row.className = 'review-row';
    const badge = document.createElement('span');
    badge.className = `verdict ${res.verdict}`;
    badge.textContent = res.score;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${entry.name ?? key} ${entry.platform === 'sp' ? '(spotify)' : '(ytm)'}`;
    name.title = res.reasons.join('\n');
    const ban = document.createElement('button');
    ban.className = 'ban';
    ban.textContent = 'Block';
    ban.addEventListener('click', () => resolveReview(key, entry, true));
    const ok = document.createElement('button');
    ok.className = 'ok';
    ok.textContent = 'Not AI';
    ok.addEventListener('click', () => resolveReview(key, entry, false));
    row.append(badge, name, ban, ok);
    el.appendChild(row);
  }
}

async function resolveReview(key, entry, isAi) {
  const data = await chrome.storage.local.get(['userBlocklist', 'whitelist', 'verdictCache']);
  const verdictCache = data.verdictCache ?? {};
  delete verdictCache[key];
  if (isAi) {
    const userBlocklist = data.userBlocklist ?? { artists: [] };
    userBlocklist.artists.push({
      name: entry.name,
      channelId: entry.platform === 'yt' ? key : null,
      spotifyId: entry.platform === 'sp' ? key : null,
      confidence: 'confirmed',
      source: 'user',
    });
    await chrome.storage.local.set({ userBlocklist, verdictCache });
  } else {
    const whitelist = { channelIds: [], names: [], spotifyIds: [], ...(data.whitelist ?? {}) };
    if (entry.platform === 'yt' && !whitelist.channelIds.includes(key)) whitelist.channelIds.push(key);
    if (entry.platform === 'sp' && !whitelist.spotifyIds.includes(key)) whitelist.spotifyIds.push(key);
    if (entry.name && !whitelist.names.includes(entry.name)) whitelist.names.push(entry.name);
    await chrome.storage.local.set({ whitelist, verdictCache });
  }
  sendReport(isAi ? 'report' : 'not_ai', { platform: entry.platform, artistId: key, name: entry.name, entry });
  refresh();
}

async function refresh() {
  const data = await chrome.storage.local.get(
    ['enabled', 'aiThreshold', 'heuristicAuto', 'actionFull', 'contribute', 'reportUrl', 'blocklist', 'userBlocklist', 'verdictCache', 'lastSync', 'syncUrl']
  );
  $('enabled').checked = data.enabled ?? true;
  $('heuristic-auto').checked = data.heuristicAuto ?? false;
  $('action-full').checked = data.actionFull ?? false;
  $('contribute').checked = data.contribute ?? true;
  if (document.activeElement !== $('report-url')) $('report-url').value = data.reportUrl ?? '';
  const threshold = data.aiThreshold ?? ammit.DEFAULT_AI_THRESHOLD;
  if (document.activeElement !== $('threshold')) $('threshold').value = threshold;
  $('threshold-val').textContent = threshold;
  const total = (data.blocklist?.artists?.length ?? 0) + (data.userBlocklist?.artists?.length ?? 0);
  // Verdicts derived from cached features vs the current scorer+threshold,
  // matching what the content scripts will actually decide.
  const derived = Object.entries(data.verdictCache ?? {})
    .map(([key, entry]) => ({ key, entry, res: derive(entry, threshold) }))
    .filter((d) => d.res);
  $('stats').textContent =
    `${total} blocked artists · ${derived.length} heuristic verdicts (${derived.filter((d) => d.res.verdict === 'ai').length} AI)`;
  renderReview(derived);
  $('sync-info').textContent = data.syncUrl
    ? (data.lastSync ? `last: ${new Date(data.lastSync).toLocaleString()}` : 'never synced')
    : 'no sync url set';
  if (document.activeElement !== $('sync-url')) $('sync-url').value = data.syncUrl ?? '';

  const active = await getActiveTab();
  platform = active?.platform ?? null;
  current = null;
  if (active) {
    try {
      current = await chrome.tabs.sendMessage(active.tab.id, { type: 'get-current' });
    } catch { /* content script not loaded in this tab */ }
  }
  renderCurrent();
}

$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});

$('heuristic-auto').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ heuristicAuto: e.target.checked });
});

$('action-full').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ actionFull: e.target.checked });
});

$('contribute').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ contribute: e.target.checked });
});

$('report-url').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ reportUrl: e.target.value.trim() || null });
});

$('threshold').addEventListener('input', (e) => {
  $('threshold-val').textContent = e.target.value;
});

$('threshold').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ aiThreshold: +e.target.value });
  refresh();
});

$('block').addEventListener('click', async () => {
  const p = current?.primary;
  if (!p) return;
  const { userBlocklist = { artists: [] }, verdictCache = {} } = await chrome.storage.local.get(['userBlocklist', 'verdictCache']);
  userBlocklist.artists.push({
    name: p.name,
    channelId: p.channelId ?? null,
    spotifyId: p.spotifyId ?? null,
    confidence: 'confirmed',
    source: 'user',
  });
  await chrome.storage.local.set({ userBlocklist });
  const artistId = p.channelId ?? p.spotifyId ?? null;
  sendReport('report', { platform: p.channelId ? 'yt' : 'sp', artistId, name: p.name, entry: verdictCache[artistId] });
  refresh();
});

$('whitelist').addEventListener('click', async () => {
  const p = current?.primary;
  if (!p) return;
  const data = await chrome.storage.local.get(['whitelist', 'verdictCache']);
  const whitelist = { channelIds: [], names: [], spotifyIds: [], ...(data.whitelist ?? {}) };
  if (p.channelId && !whitelist.channelIds.includes(p.channelId)) whitelist.channelIds.push(p.channelId);
  if (p.spotifyId && !whitelist.spotifyIds.includes(p.spotifyId)) whitelist.spotifyIds.push(p.spotifyId);
  if (p.name && !whitelist.names.includes(p.name)) whitelist.names.push(p.name);
  const verdictCache = data.verdictCache ?? {};
  const artistId = p.channelId ?? p.spotifyId ?? null;
  const entry = artistId ? verdictCache[artistId] : null;
  if (p.channelId) delete verdictCache[p.channelId];
  if (p.spotifyId) delete verdictCache[p.spotifyId];
  await chrome.storage.local.set({ whitelist, verdictCache });
  sendReport('not_ai', { platform: p.channelId ? 'yt' : 'sp', artistId, name: p.name, entry });
  refresh();
});

$('sync-url').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ syncUrl: e.target.value.trim() || null });
  refresh();
});

$('sync').addEventListener('click', async () => {
  $('sync-info').textContent = 'syncing…';
  const res = await chrome.runtime.sendMessage({ type: 'sync-now' });
  $('sync-info').textContent = res?.ok ? `synced ${res.count} artists` : `failed: ${res?.reason}`;
  setTimeout(refresh, 1500);
});

refresh();
