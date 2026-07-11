// Verify the Spotify skip guard: nuke() with a target that is NOT the current
// now-playing must not skip (the trackId-null late-verdict wrong-target case).
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith('https://open.spotify.com'));
if (!page) { console.error('no spotify tab'); process.exit(2); }

// Make sure something is playing.
const nowArtist = () => page.evaluate(() =>
  document.querySelector('[data-testid=now-playing-widget] a[href*="/artist/"]')?.textContent?.trim() ?? null);
let playing = await nowArtist();
if (!playing) {
  await page.goto('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.locator('[data-testid=action-bar-row] button[data-testid=play-button]').first().click().catch(() => {});
  await page.waitForTimeout(3000);
  playing = await nowArtist();
}
console.log('now playing:', playing);

const session = await ctx.newCDPSession(page);
const contexts = [];
session.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
await session.send('Runtime.enable');
await page.waitForTimeout(400);
let world = null;
for (const c of contexts) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: 'typeof nuke === "function" && typeof getCurrent === "function"',
    contextId: c.id, returnByValue: true,
  }).catch(() => ({ result: {} }));
  if (result.value === true) { world = c.id; break; }
}
if (!world) { console.error('content-script world not found'); process.exit(1); }

const run = (expr) => session.send('Runtime.evaluate', { expression: expr, contextId: world, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

const before = await run('getCurrent()?.artists?.map(a=>a.name).join(",")');
// Stale target: an artist that is NOT currently playing, trackId null (the bug case).
await run('nuke([{name:"ZZZ_NOT_PLAYING_ARTIST", spotifyId:"0000000000000000000000", ban:false}], null)');
await page.waitForTimeout(1500);
const after = await run('getCurrent()?.artists?.map(a=>a.name).join(",")');

console.log('track before:', before);
console.log('track after :', after);
console.log(before === after ? 'PASS — stale nuke did NOT skip the innocent track' : 'FAIL — track changed (wrongly skipped)');
await browser.close();
