// Surgical guard test: call the content script's nuke() with a STALE track key
// (simulating an async verdict that lands after the track changed) while an
// innocent track plays. The guard must abort and leave the track untouched.
// Uses raw CDP to evaluate inside the extension's isolated world.
import { chromium } from 'playwright-core';

const REAL_ARTIST = 'UChf_r1xObvlYS_ezGw_POQw'; // Verdena

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith('https://music.youtube.com'));
page.on('console', (m) => { if (m.text().includes('[ammit]')) console.log('CONSOLE:', m.text()); });

await page.goto(`https://music.youtube.com/channel/${REAL_ARTIST}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('ytmusic-immersive-header-renderer ytmusic-play-button-renderer, ytmusic-immersive-header-renderer yt-button-shape button').first().click();
await page.waitForTimeout(3000); // let the track stabilize and be processed

const session = await ctx.newCDPSession(page);
const contexts = [];
session.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
await session.send('Runtime.enable');
await page.waitForTimeout(500);

const isolated = contexts.filter((c) => c.auxData?.type === 'isolated' || c.name.toLowerCase().includes('extension'));
console.log('execution contexts:', contexts.map((c) => `${c.id}:${c.name || c.auxData?.type}`).join(' | '));

let csContext = null;
for (const c of isolated) {
  const { result } = await session.send('Runtime.evaluate', { expression: 'typeof nuke', contextId: c.id, returnByValue: true });
  if (result.value === 'function') { csContext = c; break; }
}
if (!csContext) { console.error('FAIL: content script context not found'); process.exit(1); }
console.log('content-script world found:', csContext.id, csContext.name);

const evalCS = async (expression) =>
  (await session.send('Runtime.evaluate', { expression, contextId: csContext.id, returnByValue: true, awaitPromise: true })).result.value;

const before = await evalCS('JSON.stringify({t: getCurrentTrack(), like: document.querySelector(SEL.likeRenderer)?.getAttribute("like-status")})');
console.log('before:', before);

// The reported bug: verdict for a PREVIOUS (AI) track lands now.
await evalCS('nuke("TEST-STALE-VERDICT", "UCztTAdXjMiUzypSNQJrsb9Q::You\'re Perfect")');
await page.waitForTimeout(1200); // longer than SKIP_DELAY_MS

const after = await evalCS('JSON.stringify({t: getCurrentTrack(), like: document.querySelector(SEL.likeRenderer)?.getAttribute("like-status")})');
console.log('after: ', after);

const a = JSON.parse(after);
const ok = a.like === 'INDIFFERENT' && JSON.parse(before).t.title === a.t.title;
console.log(ok ? 'PASS — innocent track untouched, no skip' : 'FAIL — track was touched!');
await browser.close();
process.exit(ok ? 0 : 1);
