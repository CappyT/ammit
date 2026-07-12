// Calibration data collector: extract features for confirmed-AI artists and a
// real-artist control sample, using the SAME extractor the extension ships
// (extension/src/heuristics.js, evaluated in the YT Music page over CDP).
// MusicBrainz lookups run node-side (1.15s throttle, proper User-Agent).
// Output: scratch features.json passed as argv[2] (default ./features.json).
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? join(root, 'features.json');

const heurSrc = readFileSync(join(root, 'extension/src/heuristics.js'), 'utf8');
const blocklist = JSON.parse(readFileSync(join(root, 'extension/data/blocklist.json'), 'utf8'));

const confirmed = blocklist.artists.filter((a) => a.confidence === 'confirmed' && a.channelId);
const step = Math.max(1, Math.floor(confirmed.length / 30));
const AI = confirmed.filter((_, i) => i % step === 0).slice(0, 30);

// Control sample: real artists, mixed sizes — includes small legit indie acts
// (the hard negatives for the low-subs/absence heuristics).
const CONTROLS = [
  'Radiohead', 'Kendrick Lamar', 'Caparezza', 'Verdena', 'Calcutta',
  'Colapesce Dimartino', 'IDLES', 'Fontaines D.C.', 'Big Thief', 'Alvvays',
  'Men I Trust', 'Crumb', 'Squid', 'Black Country, New Road', 'Alex G',
  'Duster', 'Horsegirl', 'Hovvdy', 'Water From Your Eyes', 'Geese',
  'Mk.gee', 'Puma Blue', 'Feng Suave', 'Peach Pit', 'Boy Pablo',
  'Still Woozy', 'Any Other', 'Post Nebbia', 'Bee Bee Sea', 'Studio Murena',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastMb = 0;
async function mbLookup(name) {
  const wait = lastMb + 1150 - Date.now();
  if (wait > 0) await sleep(wait);
  lastMb = Date.now();
  const url = `https://musicbrainz.org/ws/2/artist?query=artist:${encodeURIComponent(JSON.stringify(name))}&fmt=json&limit=3`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ammit-calibration/0.1 (cappy95@gmail.com)' } });
  if (!res.ok) return { mbPresent: null, mbScore: null };
  const j = await res.json();
  const hit = (j.artists ?? []).find(
    (a) => a.score >= 90 && a.name.toLowerCase() === name.toLowerCase()
  ) ?? (j.artists ?? [])[0];
  const present = !!hit && hit.score >= 90 && hit.name.toLowerCase() === name.toLowerCase();
  return { mbPresent: present, mbScore: hit?.score ?? 0 };
}

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://music.youtube.com'));
if (!page) { console.error('no ytm tab'); process.exit(2); }

async function inject() {
  await page.evaluate(`(() => { ${heurSrc}; window.__ammit = ammit; })()`);
}
await inject();

async function inPage(expr) {
  try {
    return await page.evaluate(expr);
  } catch (e) {
    if (String(e).includes('__ammit')) { await inject(); return page.evaluate(expr); }
    throw e;
  }
}

const rows = [];
async function collect(label, name, channelId) {
  try {
    if (!channelId) {
      channelId = await inPage(`__ammit.searchArtist(${JSON.stringify(name)})`);
      if (!channelId) { console.log(`SKIP ${name}: not found in search`); return; }
    }
    const f = await inPage(`__ammit.extractFeatures(${JSON.stringify(channelId)})`);
    const mb = await mbLookup(f.name ?? name);
    rows.push({ label, listName: name, ...f, ...mb });
    console.log(`${label} ${f.name} subs=${f.subscribers} rel=${f.totalReleases} 2024+=${f.share2024plus?.toFixed(2) ?? '-'} mb=${mb.mbPresent}`);
  } catch (e) {
    console.log(`SKIP ${name} (${channelId ?? '?'}): ${String(e).slice(0, 100)}`);
  }
  await sleep(600);
}

console.log(`collecting: ${AI.length} AI + ${CONTROLS.length} controls`);
for (const a of AI) await collect('ai', a.name ?? a.channelId, a.channelId);
for (const n of CONTROLS) await collect('real', n, null);

writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`DONE — ${rows.length} rows -> ${OUT}`);
await browser.close();
