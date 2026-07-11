const $ = (id) => document.getElementById(id);
let current = null; // { track, primary, verdictInfo }
let platform = null; // 'ytmusic' | 'spotify'

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

async function refresh() {
  const data = await chrome.storage.local.get(
    ['enabled', 'blocklist', 'userBlocklist', 'verdictCache', 'lastSync', 'syncUrl']
  );
  $('enabled').checked = data.enabled ?? true;
  const total = (data.blocklist?.artists?.length ?? 0) + (data.userBlocklist?.artists?.length ?? 0);
  const verdicts = Object.values(data.verdictCache ?? {});
  $('stats').textContent =
    `${total} blocked artists · ${verdicts.length} heuristic verdicts (${verdicts.filter((v) => v.verdict === 'ai').length} AI)`;
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

$('block').addEventListener('click', async () => {
  const p = current?.primary;
  if (!p) return;
  const { userBlocklist = { artists: [] } } = await chrome.storage.local.get('userBlocklist');
  userBlocklist.artists.push({
    name: p.name,
    channelId: p.channelId ?? null,
    spotifyId: p.spotifyId ?? null,
    confidence: 'confirmed',
    source: 'user',
  });
  await chrome.storage.local.set({ userBlocklist });
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
  if (p.channelId) delete verdictCache[p.channelId];
  await chrome.storage.local.set({ whitelist, verdictCache });
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
