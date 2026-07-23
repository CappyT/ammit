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

const CONFIDENCE_RANK = { confirmed: 2, suspected: 1 };
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
  const confidence = a.disclosure && a.disclosure !== 'none' ? 'confirmed' : 'suspected';
  add({ name: a.name, channelId: a.youtube || null, spotifyId: a.spotify || null, confidence, source: 'soul-over-ai' });
}

// --- surasshu blocktube backup (YouTube only) ---
const sur = JSON.parse(readFileSync(src('surasshu.json'), 'utf8'));
let lastComment = null;
for (const line of sur.filterData.channelId) {
  if (typeof line !== 'string' || !line.trim()) continue;
  if (line.startsWith('//')) { lastComment = line; continue; }
  const id = line.match(/UC[\w-]{22}/)?.[0];
  if (!id) continue;
  add({ name: lastComment?.match(/\(([^)]+)\)/)?.[1] ?? null, channelId: id, confidence: 'suspected', source: 'surasshu' });
  lastComment = null;
}

// --- cevval ublock list (YouTube only) ---
const cev = readFileSync(src('cevval.txt'), 'utf8');
for (const id of new Set(cev.match(/UC[\w-]{22}/g) ?? [])) {
  add({ channelId: id, confidence: 'suspected', source: 'cevval' });
}

const spotifyIdsSoFar = () => new Set([...merged.values()].map((e) => e.spotifyId).filter(Boolean));

// --- cennoxx (Spotify id + name) — before eye-wave so its named entries win the dedup ---
const cennoxKnown = spotifyIdsSoFar();
const cen = readFileSync(src('cennoxx.csv'), 'utf8');
for (const line of cen.split('\n').slice(1)) {
  const m = line.trim().match(/^(.*),([a-zA-Z0-9]{22})$/);
  if (!m || cennoxKnown.has(m[2])) continue;
  add({ name: m[1].trim() || null, spotifyId: m[2], confidence: 'suspected', source: 'cennoxx' });
}

// --- eye-wave (Spotify only) — dedup against Spotify ids already merged in ---
const knownSpotify = spotifyIdsSoFar();
const eye = readFileSync(src('eyewave.txt'), 'utf8');
for (const id of new Set(eye.match(/artist\/([a-zA-Z0-9]{22})/g)?.map((m) => m.split('/')[1]) ?? [])) {
  if (knownSpotify.has(id)) continue;
  add({ spotifyId: id, confidence: 'suspected', source: 'eye-wave' });
}

const artists = [...merged.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
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
