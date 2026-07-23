// Compile sources/ lists into extension/data/blocklist.json.
// Sources:
//  - souloverai.json  (xoundbyte/soul-over-ai — name, YouTube UC id, Spotify id, disclosure)
//  - surasshu.json    (Blocktube backup — YouTube UC ids, name in preceding comment)
//  - cevval.txt       (uBlock filter list — YouTube UC ids in rules)
//  - cennoxx.csv      (CennoxX/spotify-ai-blocker — "artist,id" CSV, name + Spotify id)
//  - eyewave.txt      (eye-wave/spotify-ai-blocklist — Spotify artist URLs, one per line)
// Each entry carries whichever identifiers are known (channelId / spotifyId / name);
// the extension matches YT Music by channelId+name and Spotify by spotifyId+name.
// Usage: node tools/build-blocklist.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => join(root, 'sources', f);

// Curated-list entries are id-anchored and ship as 'confirmed' — the
// 'community' tier is reserved for crowd promotions made by the backend.
const CONFIDENCE_RANK = { confirmed: 2, community: 1 };
const norm = (s) => (s || '').trim().toLowerCase();

// Keyed by the strongest available identifier so entries for the same artist
// from different sources merge instead of duplicating.
const merged = new Map();
const keyFor = ({ channelId, spotifyId, name }) =>
  channelId ? `yt:${channelId}` : spotifyId ? `sp:${spotifyId}` : `name:${norm(name)}`;

function add({ name, channelId, spotifyId, confidence, source }) {
  if (!name && !channelId && !spotifyId) return;
  const key = keyFor({ channelId, spotifyId, name });
  const prev = merged.get(key);
  if (prev) {
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[prev.confidence]) prev.confidence = confidence;
    if (!prev.name && name) prev.name = name;
    if (!prev.spotifyId && spotifyId) prev.spotifyId = spotifyId;
    if (!prev.channelId && channelId) prev.channelId = channelId;
    if (!prev.source.includes(source)) prev.source += `,${source}`;
    return;
  }
  merged.set(key, { name: name ?? null, channelId: channelId ?? null, spotifyId: spotifyId ?? null, confidence, source });
}

// --- soul-over-ai (has both YT and Spotify ids) ---
const soa = JSON.parse(readFileSync(src('souloverai.json'), 'utf8'));
for (const a of soa) {
  if (a.removed) continue;
  add({ name: a.name, channelId: a.youtube || null, spotifyId: a.spotify || null, confidence: 'confirmed', source: 'soul-over-ai' });
}

// --- surasshu blocktube backup (YouTube only) ---
const sur = JSON.parse(readFileSync(src('surasshu.json'), 'utf8'));
let lastComment = null;
for (const line of sur.filterData.channelId) {
  if (typeof line !== 'string' || !line.trim()) continue;
  if (line.startsWith('//')) { lastComment = line; continue; }
  const id = line.match(/UC[\w-]{22}/)?.[0];
  if (!id) continue;
  add({ name: lastComment?.match(/\(([^)]+)\)/)?.[1] ?? null, channelId: id, confidence: 'confirmed', source: 'surasshu' });
  lastComment = null;
}

// --- cevval ublock list (YouTube only) ---
const cev = readFileSync(src('cevval.txt'), 'utf8');
for (const id of new Set(cev.match(/UC[\w-]{22}/g) ?? [])) {
  add({ channelId: id, confidence: 'confirmed', source: 'cevval' });
}

const spotifyIdsSoFar = () => new Set([...merged.values()].map((e) => e.spotifyId).filter(Boolean));

// --- cennoxx (Spotify id + name) — before eye-wave so its named entries win the dedup ---
const cennoxKnown = spotifyIdsSoFar();
const cen = readFileSync(src('cennoxx.csv'), 'utf8');
for (const line of cen.split('\n').slice(1)) {
  const m = line.trim().match(/^(.*),([a-zA-Z0-9]{22})$/);
  if (!m || cennoxKnown.has(m[2])) continue;
  add({ name: m[1].trim() || null, spotifyId: m[2], confidence: 'confirmed', source: 'cennoxx' });
}

// --- eye-wave (Spotify only) — dedup against Spotify ids already merged in ---
const knownSpotify = spotifyIdsSoFar();
const eye = readFileSync(src('eyewave.txt'), 'utf8');
for (const id of new Set(eye.match(/artist\/([a-zA-Z0-9]{22})/g)?.map((m) => m.split('/')[1]) ?? [])) {
  if (knownSpotify.has(id)) continue;
  add({ spotifyId: id, confidence: 'confirmed', source: 'eye-wave' });
}

// --- enrichment: fill missing ids from sources/resolved.json (tools/resolve-ids.mjs output) ---
// Regex-validate values so recorded misses (null) and odd keys never leak into ids.
try {
  const resolved = JSON.parse(readFileSync(src('resolved.json'), 'utf8'));
  for (const e of merged.values()) {
    if (!e.name) continue;
    const n = norm(e.name);
    const yt = resolved.yt?.[n], sp = resolved.sp?.[n];
    if (!e.channelId && /^UC[\w-]{22}$/.test(yt)) e.channelId = yt;
    if (!e.spotifyId && /^[a-zA-Z0-9]{22}$/.test(sp)) e.spotifyId = sp;
  }
} catch { /* no resolved.json — build proceeds unenriched */ }

// Enrichment can make an entry collide with entries keyed by the same id from
// other sources (e.g. a nameless cevval channel) — fold those together.
const fold = (into, e) => {
  if (CONFIDENCE_RANK[e.confidence] > CONFIDENCE_RANK[into.confidence]) into.confidence = e.confidence;
  if (!into.name && e.name) into.name = e.name;
  if (!into.channelId && e.channelId) into.channelId = e.channelId;
  if (!into.spotifyId && e.spotifyId) into.spotifyId = e.spotifyId;
  for (const s of e.source.split(',')) if (!into.source.includes(s)) into.source += `,${s}`;
};
const byId = new Map();
const folded = [];
for (const e of merged.values()) {
  const hits = [...new Set([byId.get(`yt:${e.channelId}`), byId.get(`sp:${e.spotifyId}`)].filter(Boolean))];
  let target = hits[0];
  if (!target) folded.push((target = e));
  else { fold(target, e); if (hits[1]) { fold(target, hits[1]); folded.splice(folded.indexOf(hits[1]), 1); } }
  if (target.channelId) byId.set(`yt:${target.channelId}`, target);
  if (target.spotifyId) byId.set(`sp:${target.spotifyId}`, target);
}

const artists = folded.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
const out = {
  version: 3,
  updated: new Date().toISOString().slice(0, 10),
  stats: {
    total: artists.length,
    confirmed: artists.filter((a) => a.confidence === 'confirmed').length,
    withChannelId: artists.filter((a) => a.channelId).length,
    withSpotifyId: artists.filter((a) => a.spotifyId).length,
  },
  artists,
};

writeFileSync(join(root, 'extension', 'data', 'blocklist.json'), JSON.stringify(out, null, 1));
console.log('blocklist.json written:', JSON.stringify(out.stats));
