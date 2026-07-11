// Validate the Spotify artist-ban chain end-to-end (authorized by the user on
// this test account). Token is sniffed from the web player's own requests via
// CDP network events (get_access_token is TOTP-gated since ~2025, returns 403).
// Never prints the token. Usage: node tools/test-spotify-ban.mjs <artistId>
import { chromium } from 'playwright-core';

const artistId = process.argv[2];
const USERNAME = 'cappyt';
if (!artistId) { console.error('usage: node tools/test-spotify-ban.mjs <spotify-artist-id>'); process.exit(1); }

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://open.spotify.com'));
if (!page) { console.error('no spotify tab'); process.exit(2); }

let token = null;
page.on('request', (req) => {
  const auth = req.headers()['authorization'];
  if (auth?.startsWith('Bearer ') && !token) token = auth.slice(7);
});
await page.reload({ waitUntil: 'domcontentloaded' });
for (let i = 0; i < 20 && !token; i++) await page.waitForTimeout(500);
console.log('token captured:', !!token);
if (!token) process.exit(1);

const api = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', authorization: `Bearer ${token}`, ...opts.headers },
});

// Username from localStorage (same as the extension) — the public api.spotify.com
// Web API is rate-limited for web-player tokens and the player never calls it.
const user = (await page.evaluate(() =>
  Object.keys(localStorage).find((k) => k.includes(':') && !k.startsWith('anonymous:'))?.split(':')[0])) ?? USERNAME;
console.log('username:', user);

const ban = await api('https://spclient.wg.spotify.com/collection/v2/write?market=from_token', {
  method: 'POST',
  body: JSON.stringify({ username: user, set: 'artistban', items: [{ uri: `spotify:artist:${artistId}` }] }),
});
console.log('ban write:', ban.status, ban.ok ? 'OK' : (await ban.text()).slice(0, 200));

const read = await api('https://spclient.wg.spotify.com/collection/v2/paging', {
  method: 'POST',
  body: JSON.stringify({ username: user, set: 'artistban', paginationToken: null, limit: 50 }),
});
if (read.ok) {
  const items = (await read.json()).items ?? [];
  const found = items.some((it) => it.uri === `spotify:artist:${artistId}`);
  console.log(`read-back: ${items.length} banned artists, target present: ${found}`);
} else {
  console.log('read-back failed:', read.status);
}
await browser.close();
