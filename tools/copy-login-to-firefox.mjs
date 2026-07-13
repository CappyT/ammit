// Google blocks interactive login on automation-flagged Firefox ("This
// browser or app may not be secure"), so port the session instead: read the
// .youtube.com cookies from the logged-in test Chrome (CDP :9222) and inject
// them into the live geckodriver session used by firefox-e2e.mjs.
//
// WebDriver only sets cookies that domain-match the current document, so the
// Firefox tab is pointed at YT Music first. sameSite is deliberately not
// forwarded: every YTM request is same-site, and geckodriver rejects some
// combinations Chrome reports.
//
// Usage: tools/launch-browser.sh (logged in) + geckodriver running, then
//        node tools/copy-login-to-firefox.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const GD = process.env.GECKODRIVER_URL ?? 'http://127.0.0.1:4444';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sid = fs.readFileSync(path.join(ROOT, '.firefox-profile', '.wd-session'), 'utf8').trim();

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

const browser = await chromium.connectOverCDP('http://localhost:9222');
const cookies = await browser.contexts()[0].cookies(['https://music.youtube.com', 'https://www.youtube.com']);
await browser.close();
console.log(`read ${cookies.length} cookies from chrome`);

await wd('POST', `/session/${sid}/url`, { url: 'https://music.youtube.com/' });
let ok = 0;
for (const c of cookies) {
  const cookie = { name: c.name, value: c.value, path: c.path, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly };
  if (c.expires && c.expires > 0) cookie.expiry = Math.floor(c.expires);
  try { await wd('POST', `/session/${sid}/cookie`, { cookie }); ok++; }
  catch (e) { console.warn('skipped', c.name, '—', e.message.split('—')[1]?.trim() ?? e.message); }
}
console.log(`${ok}/${cookies.length} cookies set in firefox`);

await wd('POST', `/session/${sid}/url`, { url: 'https://music.youtube.com/' });
const signed = await wd('POST', `/session/${sid}/execute/sync`, {
  script: 'return document.cookie.includes("SAPISID")', args: [],
});
console.log('firefox signed in:', signed);
