// Validate the Spotify heuristic chain (pathfinder features -> MB -> scoreFeatures)
// by driving it inside the content-script isolated world over CDP. Read-only:
// calls the 'features' bridge (GET-like) and scoreFeatures, never bans.
import { chromium } from 'playwright-core';

const CASES = [
  ['ai', 'Xania Monet', '0YIEJNJUCsjzeWwj8Xh2LD'],
  ['ai', 'Aiyun', '4dSpK6RQ66rjinHJxA5P8s'],
  ['ai', 'Nick Hustles', '4y6CMS7tqBf8ubmUuP9SQI'],
  ['ai', 'Aventhis', '0a97V3mDhGyNg93Dcf9Ahj'],
  ['real', 'Radiohead', '4Z8W4fKeB5YxbusRsdQVPb'],
  ['real', 'Coldplay', '4gzpq5DPGxSnKTe4SA8HAU'],
  ['real', 'Kendrick Lamar', '2YZyLoL8N0Wb9xBt1NhZWg'],
];

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith('https://open.spotify.com'));
if (!page) { console.error('no spotify tab'); process.exit(2); }
// Ensure the player has emitted a queryArtistOverview so the hash is fresh.
await page.goto('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const session = await ctx.newCDPSession(page);
const contexts = [];
session.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
await session.send('Runtime.enable');
await page.waitForTimeout(400);

let world = null;
for (const c of contexts) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: 'typeof bridge === "function" && typeof ammit === "object"',
    contextId: c.id, returnByValue: true,
  }).catch(() => ({ result: {} }));
  if (result.value === true) { world = c.id; break; }
}
if (!world) { console.error('content-script world not found'); process.exit(1); }

const run = async (expr) =>
  (await session.send('Runtime.evaluate', { expression: expr, contextId: world, returnByValue: true, awaitPromise: true })).result.value;

let ok = 0;
for (const [label, name, id] of CASES) {
  const out = await run(`(async () => {
    const f = await bridge('features', ${JSON.stringify(id)});
    if (f._err) return { err: f._err };
    f.mbPresent = await chrome.runtime.sendMessage({ type: 'mb-lookup', name: f.name });
    const s = ammit.scoreFeatures(f);
    return { name: f.name, subs: f.subscribers, ml: f.monthlyListeners, rel: f.totalReleases, share: f.share2024plus, mb: f.mbPresent, score: s.score, verdict: s.verdict, reasons: s.reasons };
  })()`);
  if (out?.err) { console.log(`${label} ${name}: ERR ${out.err}`); continue; }
  const pass = label === 'ai' ? out.verdict === 'ai' : out.verdict === 'human';
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'} [${label}] ${out.name} score=${out.score} verdict=${out.verdict} share2024=${out.share?.toFixed?.(2)} mb=${out.mb} :: ${out.reasons.join('; ')}`);
}
console.log(`\n${ok}/${CASES.length} as expected`);
await browser.close();
