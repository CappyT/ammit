// E2E test on Firefox: temp-install the extension via geckodriver (plain
// WebDriver over HTTP, no client deps), open YT Music in the persistent
// .firefox-profile, play a blocklisted artist and watch the extension skip it.
//
// Requires a running geckodriver (default http://127.0.0.1:4444). The session
// is left open at the end (and its id cached next to the profile) so the
// browser stays up for manual poking and re-runs reuse it.
//
// Usage: node tools/firefox-e2e.mjs [channelId]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GD = process.env.GECKODRIVER_URL ?? 'http://127.0.0.1:4444';
const ARTIST = process.argv[2] ?? 'UCHrCbrMLpRzCYfYoBXkwfvg';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.firefox-profile');
const EXT = path.join(ROOT, 'extension');
const SESSION_FILE = path.join(PROFILE, '.wd-session');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, p, body) {
  const res = await fetch(GD + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json();
  if (j.value?.error) throw new Error(`${p}: ${j.value.error} — ${j.value.message}`);
  return j.value;
}

let sid;
const exec = (script, args = []) =>
  wd('POST', `/session/${sid}/execute/sync`, { script, args });

async function clickFirst(selectors) {
  for (const sel of selectors) {
    try {
      const el = await wd('POST', `/session/${sid}/element`, { using: 'css selector', value: sel });
      await wd('POST', `/session/${sid}/element/${el['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
      return sel;
    } catch { /* try next */ }
  }
  return null;
}

// --- session: reuse a live cached one, else create ---
fs.mkdirSync(PROFILE, { recursive: true });
if (fs.existsSync(SESSION_FILE)) {
  sid = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  try { await exec('return 1'); console.log('reusing session', sid); } catch { sid = null; }
}
if (!sid) {
  const v = await wd('POST', '/session', {
    capabilities: { alwaysMatch: {
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-profile', PROFILE] },
    } },
  });
  sid = v.sessionId;
  fs.writeFileSync(SESSION_FILE, sid);
  console.log('new session', sid);
}

// Temporary install (survives until the browser closes; idempotent on re-run).
await wd('POST', `/session/${sid}/moz/addon/install`, { path: EXT, temporary: true });
console.log('extension installed (temporary)');

await wd('POST', `/session/${sid}/url`, { url: 'https://music.youtube.com/' });

// --- login gate: SAPISID cookie is JS-readable only when signed in ---
let signedIn = false;
for (let i = 0; i < 100; i++) {
  signedIn = await exec('return document.cookie.includes("SAPISID")');
  if (signedIn) break;
  if (i === 0) console.log('>>> not signed in — log into YT Music in the Firefox window, I will wait (5 min max)');
  await sleep(3000);
}
if (!signedIn) { console.error('timed out waiting for login'); process.exit(2); }
console.log('signed in ✔');

// --- content script alive? (widget root is mounted at injection time) ---
await sleep(3000);
const widget = await exec('return !!document.getElementById("ammit-widget")');
console.log('content script widget mounted:', widget);

// --- play a blocklisted artist and watch what the extension does ---
await wd('POST', `/session/${sid}/url`, { url: `https://music.youtube.com/channel/${ARTIST}` });
await sleep(4000);
const clicked = await clickFirst([
  'ytmusic-immersive-header-renderer ytmusic-play-button-renderer',
  'ytmusic-immersive-header-renderer yt-button-shape button',
  'ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer',
]);
console.log(clicked ? `clicked play (${clicked})` : 'no play button found');

for (let i = 0; i < 10; i++) {
  await sleep(2000);
  const info = await exec(`return {
    title: document.querySelector('ytmusic-player-bar .title')?.textContent?.trim(),
    artist: document.querySelector('ytmusic-player-bar .byline a[href^="channel/"]')?.textContent?.trim(),
    likeStatus: document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status'),
    paused: document.querySelector('video')?.paused,
    widgetShown: document.getElementById('ammit-widget')?.style.display,
  }`);
  console.log(`t+${(i + 1) * 2}s:`, JSON.stringify(info));
}
console.log('done — browser left open for manual checks (popup, review list)');
