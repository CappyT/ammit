// Measure Spotify pathfinder rate limits: fire N queryArtistOverview replays as
// fast as possible (read-only) and report status codes + where 429 begins.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] ?? 40);
const CONCURRENCY = Number(process.argv[3] ?? 1); // 1 = sequential, >1 = burst

const bl = JSON.parse(readFileSync(join(root, 'extension/data/blocklist.json'), 'utf8'));
const ids = bl.artists.filter((a) => a.spotifyId).slice(0, N).map((a) => a.spotifyId);

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('https://open.spotify.com'));
let token = null, hash = null, template = null;
page.on('request', (r) => { const a = r.headers()['authorization']; if (a?.startsWith('Bearer ') && !token) token = a.slice(7); });
page.on('request', (r) => { if (/pathfinder\/v2\/query/.test(r.url())) { try { const b = JSON.parse(r.postData()); if (b.operationName === 'queryArtistOverview') { hash = b.extensions.persistedQuery.sha256Hash; template = b; } } catch {} } });
await page.goto('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 20 && (!token || !hash); i++) await page.waitForTimeout(500);
if (!token || !hash) { console.error('no token/hash'); process.exit(1); }

const query = (uri) => fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...template, variables: { ...template.variables, uri } }),
}).then((r) => r.status).catch(() => 'ERR');

const t0 = Date.now();
const statuses = [];
if (CONCURRENCY <= 1) {
  for (let i = 0; i < ids.length; i++) statuses.push(await query(`spotify:artist:${ids[i]}`));
} else {
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY).map((id) => query(`spotify:artist:${id}`));
    statuses.push(...(await Promise.all(batch)));
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const counts = statuses.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
const first429 = statuses.indexOf(429);
console.log(`mode=${CONCURRENCY > 1 ? 'burst x' + CONCURRENCY : 'sequential'} n=${ids.length} elapsed=${elapsed}s (${(ids.length / elapsed).toFixed(1)} req/s)`);
console.log('status counts:', JSON.stringify(counts));
console.log('first 429 at request #:', first429 === -1 ? 'none' : first429 + 1);
console.log('sequence:', statuses.join(' '));
await browser.close();
