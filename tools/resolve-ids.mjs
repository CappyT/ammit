// Resolve missing platform ids for named blocklist entries:
//  - channelId  via keyless YT Music InnerTube artist search
//  - spotifyId  via the anonymous open.spotify.com embed token + /v1/search
// Exact normalized-name matches only — a fuzzy hit would block an innocent artist.
// Hits and definitive misses (null) checkpoint to sources/resolved.json every
// ~100 lookups so runs are resumable; transient errors are not recorded and get
// retried on the next run. build-blocklist.mjs consumes the file when present.
// Usage: node tools/resolve-ids.mjs [--limit N] [--platform yt|sp|both]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'sources', 'resolved.json');

const argAt = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const LIMIT = Number(argAt('--limit') ?? Infinity);
const PLATFORM = argAt('--platform') ?? 'both';

const norm = (s) => (s || '').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE = Number(argAt('--throttle') ?? 175);

// Maps (not plain objects) so hostile-looking artist names like "constructor"
// or "__proto__" can't collide with Object.prototype.
const store = { yt: new Map(), sp: new Map() };
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  for (const side of ['yt', 'sp']) for (const [k, v] of Object.entries(prev[side] ?? {})) store[side].set(k, v);
}
let sinceSave = 0;
const save = () => {
  const out = { yt: Object.fromEntries(store.yt), sp: Object.fromEntries(store.sp), meta: { updatedAt: new Date().toISOString() } };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  sinceSave = 0;
};
const record = (side, name, id) => { store[side].set(name, id); if (++sinceSave >= 100) save(); };
process.on('SIGINT', () => { save(); console.log('\ninterrupted — checkpoint saved'); process.exit(130); });

const bl = JSON.parse(readFileSync(join(root, 'extension/data/blocklist.json'), 'utf8'));
const pending = (side, has) =>
  [...new Set(bl.artists.filter((a) => a.name && !a[has]).map((a) => norm(a.name)).filter(Boolean))]
    .filter((n) => !store[side].has(n)).slice(0, LIMIT);

async function fetchBackoff(url, opts) {
  for (let attempt = 0; ; attempt++) {
    // abort tarpitted sockets — YT stalls connections when rate-limiting
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }).catch(() => null);
    // 403 from InnerTube is anti-abuse throttling, not authorization — back off too
    if (res && res.status !== 429 && res.status !== 403 && res.status < 500) return res;
    if (attempt >= 5) return res;
    await sleep(1000 * 2 ** attempt);
  }
}

// --- YouTube Music (InnerTube, keyless) ---
const YT_CTX = {
  context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260701.03.00', hl: 'en', gl: 'US' } },
  params: 'EgWKAQIgAWoKEAkQChADEAQQBQ==', // artists-only search filter
};
async function ytLookup(name) {
  const res = await fetchBackoff('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...YT_CTX, query: name }),
  });
  if (!res?.ok) throw new Error(`yt http ${res?.status ?? 'ERR'}`);
  let hit = null;
  (function walk(o) { // first exact-name artist result in ranking order
    if (hit || !o || typeof o !== 'object') return;
    const r = o.musicResponsiveListItemRenderer;
    if (r) {
      const title = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
      const ep = r.navigationEndpoint?.browseEndpoint;
      const isArtist = ep?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST';
      if (isArtist && ep.browseId?.startsWith('UC') && norm(title) === name) { hit = ep.browseId; return; }
    }
    for (const v of Object.values(o)) walk(v);
  })(await res.json());
  return hit;
}

// --- Spotify (anonymous embed token) ---
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
let spToken = null;
async function refreshSpToken() {
  const res = await fetchBackoff('https://open.spotify.com/embed/artist/4PbKVheWA7ToOxOrqqzjol', { headers: { 'User-Agent': UA } });
  const m = res?.ok ? (await res.text()).match(/"accessToken":"([^"]+)"/) : null;
  if (!m) throw new Error(`sp embed token unavailable (http ${res?.status ?? 'ERR'})`);
  spToken = m[1];
}
async function spLookup(name, retried = false) {
  if (!spToken) await refreshSpToken();
  const res = await fetchBackoff(`https://api.spotify.com/v1/search?type=artist&q=${encodeURIComponent(name)}&limit=5`, {
    headers: { Authorization: `Bearer ${spToken}` },
  });
  if (res?.status === 401 && !retried) { spToken = null; return spLookup(name, true); }
  if (!res?.ok) throw new Error(`sp http ${res?.status ?? 'ERR'}`);
  const items = (await res.json()).artists?.items ?? [];
  return items.find((a) => norm(a.name) === name)?.id ?? null;
}

// Launches are spaced THROTTLE ms apart per platform; a small in-flight window
// keeps request latency from dominating wall time.
async function run(side, lookup, names) {
  console.log(`${side}: ${names.length} names to resolve`);
  let hits = 0, misses = 0, errors = 0, streak = 0, aborted = false;
  const inflight = new Set();
  for (const name of names) {
    if (aborted) break;
    while (inflight.size >= 4) await Promise.race(inflight);
    const p = (async () => {
      try {
        const id = await lookup(name);
        record(side, name, id);
        id ? hits++ : misses++;
        streak = 0;
        if (Number.isFinite(LIMIT)) console.log(`${side} ${JSON.stringify(name)} -> ${id}`);
      } catch (e) {
        errors++;
        console.error(`${side} ${JSON.stringify(name)}: ${e.message}`);
        if (++streak >= 10) aborted = true;
      }
      const done = hits + misses + errors;
      if (done % 500 === 0) console.log(`${side}: ${done}/${names.length} (${hits} hits)`);
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    await sleep(THROTTLE);
  }
  await Promise.all(inflight);
  if (aborted) console.error(`${side}: 10 consecutive errors — aborted early`);
  console.log(`${side}: done — ${hits} resolved, ${misses} missed, ${errors} errors (of ${names.length})`);
}

const jobs = [];
if (PLATFORM !== 'sp') jobs.push(run('yt', ytLookup, pending('yt', 'channelId')));
if (PLATFORM !== 'yt') jobs.push(run('sp', spLookup, pending('sp', 'spotifyId')));
await Promise.all(jobs);
save();
