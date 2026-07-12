// Diagnose one YT Music artist: extract features (same extractor the extension
// ships) + MusicBrainz presence + score, printing every signal.
// Usage: node tools/diagnose-artist.mjs <UC-channelId>
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const channelId = process.argv[2];
if (!channelId) { console.error('usage: node tools/diagnose-artist.mjs <UC-channelId>'); process.exit(1); }

const heurSrc = readFileSync(join(root, 'extension/src/heuristics.js'), 'utf8');
const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('https://music.youtube.com'));
if (!page) { console.error('no ytm tab'); process.exit(2); }

await page.evaluate(`(() => { ${heurSrc}; window.__ammit = ammit; })()`);
const f = await page.evaluate((id) => window.__ammit.extractFeatures(id), channelId);

// MusicBrainz node-side with a proper UA + 90-score exact-name match (same as background).
const mbRes = await fetch(
  `https://musicbrainz.org/ws/2/artist?query=artist:${encodeURIComponent(JSON.stringify(f.name))}&fmt=json&limit=5`,
  { headers: { 'User-Agent': 'ammit-diag/0.1 (cappy95@gmail.com)' } },
);
const mbJson = mbRes.ok ? await mbRes.json() : { artists: [] };
const mbHits = (mbJson.artists ?? []).map((a) => `${a.name}(${a.score})`).slice(0, 5);
f.mbPresent = (mbJson.artists ?? []).some((a) => a.score >= 90 && a.name.toLowerCase() === (f.name ?? '').toLowerCase());

const score = eval(`(() => { globalThis.document = {documentElement:{innerHTML:''}}; ${heurSrc}; return ammit.scoreFeatures; })()`)(f);

console.log('FEATURES:', JSON.stringify(f, null, 1));
console.log('MB query hits:', mbHits.join(', ') || '(none)', '| mbPresent:', f.mbPresent);
console.log('SCORE:', JSON.stringify(score));
await browser.close();
