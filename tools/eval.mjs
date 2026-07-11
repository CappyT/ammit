// Evaluate a JS expression in a tab over CDP (default: the YT Music tab).
// Usage: node tools/eval.mjs '<expression>' [url-prefix]   (async IIFE allowed)
import { chromium } from 'playwright-core';

const expr = process.argv[2];
const urlPrefix = process.argv[3] ?? 'https://music.youtube.com';
if (!expr) {
  console.error('usage: node tools/eval.mjs "<js expression>" [url-prefix]');
  process.exit(1);
}

const browser = await chromium.connectOverCDP('http://localhost:9222');
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().startsWith(urlPrefix));
if (!page) {
  console.error(`no ${urlPrefix} tab found. open tabs:`);
  pages.forEach((p) => console.error(' -', p.url().slice(0, 120)));
  process.exit(2);
}

try {
  const result = await page.evaluate(expr);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} finally {
  await browser.close(); // disconnects CDP only, browser stays open
}
