import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().startsWith('https://music.youtube.com'));
if (!page) { console.error('no ytm tab'); process.exit(2); }

const logs = [];
page.on('console', (m) => { if (m.text().includes('[ytm-aiban]')) logs.push(m.text()); });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
console.log(logs.length ? logs.join('\n') : 'NO ytm-aiban logs captured');
await browser.close();
