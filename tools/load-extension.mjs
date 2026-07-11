// Load the unpacked extension into the running Chrome via CDP.
// Requires Chrome started with --remote-debugging-port=9222 --enable-unsafe-extension-debugging.
import { chromium } from 'playwright-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const browser = await chromium.connectOverCDP('http://localhost:9222');
try {
  const session = await browser.newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: extPath });
  console.log('extension loaded, id:', id);
} finally {
  await browser.close();
}
