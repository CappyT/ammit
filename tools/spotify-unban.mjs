// Remove artist(s) from the account's artistban set (test cleanup).
// Usage: node tools/spotify-unban.mjs <artistId> [<artistId>...]
import { chromium } from 'playwright-core';

const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node tools/spotify-unban.mjs <artistId>...'); process.exit(1); }

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://open.spotify.com'));
if (!page) { console.error('no spotify tab'); process.exit(2); }

let token = null;
page.on('request', (req) => {
  const a = req.headers()['authorization'];
  if (a?.startsWith('Bearer ') && !token) token = a.slice(7);
});
await page.reload({ waitUntil: 'domcontentloaded' });
for (let i = 0; i < 20 && !token; i++) await page.waitForTimeout(500);
if (!token) { console.error('no token'); process.exit(1); }

const username = await page.evaluate(() => Object.keys(localStorage).find((k) => k.includes(':') && !k.startsWith('anonymous:'))?.split(':')[0] ?? null);
// Unban = the same write endpoint with is_removed:true on each item
// (captured from the web player's "Consenti la riproduzione" action).
const res = await fetch('https://spclient.wg.spotify.com/collection/v2/write?market=from_token', {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ username, set: 'artistban', items: ids.map((id) => ({ uri: `spotify:artist:${id}`, is_removed: true })) }),
});
console.log('unban status:', res.status, res.ok ? 'OK' : (await res.text()).slice(0, 160));
await browser.close();
