// E2E test: play a blocklisted artist and watch the extension dislike+skip.
import { chromium } from 'playwright-core';

const ARTIST = process.argv[2] ?? 'UCHrCbrMLpRzCYfYoBXkwfvg';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://music.youtube.com'));
if (!page) { console.error('no ytm tab'); process.exit(2); }

page.on('console', (m) => { if (m.text().includes('[ytm-aiban]')) console.log('CONSOLE:', m.text()); });

await page.goto(`https://music.youtube.com/channel/${ARTIST}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// Play from the artist header (shuffle/play button), fallback: first top song.
const headerPlay = page.locator('ytmusic-immersive-header-renderer ytmusic-play-button-renderer, ytmusic-immersive-header-renderer yt-button-shape button').first();
const firstSong = page.locator('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer').first();
if (await headerPlay.count()) {
  await headerPlay.click();
  console.log('clicked header play');
} else {
  await firstSong.hover();
  await firstSong.click();
  console.log('clicked first top song');
}

for (let i = 0; i < 8; i++) {
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
