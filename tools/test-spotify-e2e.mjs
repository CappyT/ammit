// E2E for Spotify: play a blocklisted AI artist and observe the content script
// skip + ban it via the main-world bridge. Reports console logs, banned state,
// and reads the artistban set back to confirm.
// Usage: node tools/test-spotify-e2e.mjs <artistId>
import { chromium } from 'playwright-core';

const artistId = process.argv[2] ?? '0YIEJNJUCsjzeWwj8Xh2LD'; // Xania Monet

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://open.spotify.com'));
if (!page) { console.error('no spotify tab'); process.exit(2); }

let token = null;
page.on('request', (req) => { const a = req.headers()['authorization']; if (a?.startsWith('Bearer ') && !token) token = a.slice(7); });
page.on('console', (m) => { const t = m.text(); if (t.includes('ytm-aiban')) console.log('CONSOLE:', t); });

await page.goto(`https://open.spotify.com/artist/${artistId}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// Click the first track row's play so the AI artist actually plays (the big
// artist play button can hand a free account an unrelated radio track).
const row = page.locator('[data-testid=track-list] [data-testid=tracklist-row], [data-testid=track-list] [role=row]').first();
try {
  await row.hover();
  await row.locator('button[data-testid=play-button], button[aria-label*=Riproduci], button[aria-label*=Play]').first().click({ timeout: 4000 });
  console.log('clicked first track play');
} catch {
  await page.locator('[data-testid=action-bar-row] button[data-testid=play-button]').first().click().catch(() => {});
  console.log('fell back to artist play button');
}

for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => {
    const w = document.querySelector('[data-testid=now-playing-widget]');
    const link = w?.querySelector('a[href*="/artist/"]');
    return {
      artist: link?.textContent?.trim(),
      artistId: link?.getAttribute('href')?.match(/\/artist\/([a-zA-Z0-9]+)/)?.[1],
      aria: w?.getAttribute('aria-label')?.slice(0, 70),
    };
  });
  console.log(`t+${(i + 1) * 2}s:`, JSON.stringify(info));
}

// Read back the artistban set.
if (token) {
  const username = await page.evaluate(() => Object.keys(localStorage).find((k) => k.includes(':') && !k.startsWith('anonymous:'))?.split(':')[0] ?? null);
  const read = await fetch('https://spclient.wg.spotify.com/collection/v2/paging', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, set: 'artistban', paginationToken: null, limit: 50 }),
  });
  if (read.ok) {
    const items = (await read.json()).items ?? [];
    console.log(`ARTISTBAN SET: ${items.length} artists; target ${artistId} present:`, items.some((it) => it.uri?.endsWith(artistId)));
  }
}
await browser.close();
