// Race regression test: an async heuristic verdict must never dislike the
// track that started playing after the condemned one.
// Repro: clear caches (slow verdict), play an unlisted-AI artist, switch to a
// real artist mid-evaluation, assert the real track is untouched.
import { chromium } from 'playwright-core';

const AI_ARTIST = 'UCztTAdXjMiUzypSNQJrsb9Q'; // Soul Blues Icons (unlisted, heuristic-caught)
const REAL_ARTIST = 'UChf_r1xObvlYS_ezGw_POQw'; // Verdena

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];

// Clear verdict + MB caches via an extension page so the verdict is slow.
const popup = await ctx.newPage();
await popup.goto('chrome-extension://mencheefijnkgchbolphcngpkbphooom/popup.html');
await popup.evaluate("chrome.storage.local.remove(['verdictCache','mbCache'])");
await popup.close();

const page = ctx.pages().find((p) => p.url().startsWith('https://music.youtube.com'));
if (!page) { console.error('no ytm tab'); process.exit(2); }
page.on('console', (m) => { if (m.text().includes('[ytm-aiban]')) console.log('CONSOLE:', m.text()); });

const play = async (channelId) => {
  await page.goto(`https://music.youtube.com/channel/${channelId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.locator('ytmusic-immersive-header-renderer ytmusic-play-button-renderer, ytmusic-immersive-header-renderer yt-button-shape button').first().click();
};

console.log('--- playing AI artist (verdict in flight)…');
await play(AI_ARTIST);
await page.waitForTimeout(800); // verdict needs ~2s (cleared caches); switch before it lands

console.log('--- switching to REAL artist mid-evaluation…');
await play(REAL_ARTIST);

for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => ({
    title: document.querySelector('ytmusic-player-bar .title')?.textContent?.trim(),
    artist: document.querySelector('ytmusic-player-bar .byline a[href^="channel/"]')?.textContent?.trim(),
    likeStatus: document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status'),
    paused: document.querySelector('video')?.paused,
  }));
  console.log(`t+${(i + 1) * 2}s:`, JSON.stringify(info));
}
await browser.close();
