// Rewrite extension/manifest.json for a single browser target. The repo
// manifest carries both background flavors for buildless local development;
// store packages must ship only their own to avoid validator warnings
// (AMO flags service_worker, chrome ignores but flags scripts).
// Restore with `git checkout extension/manifest.json` after packaging.
//
// Usage: node tools/build-manifest.mjs <chrome|firefox>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
const path = fileURLToPath(new URL('../extension/manifest.json', import.meta.url));
const m = JSON.parse(fs.readFileSync(path, 'utf8'));

if (target === 'firefox') {
  delete m.background.service_worker;
} else if (target === 'chrome') {
  delete m.background.scripts;
  delete m.browser_specific_settings;
} else {
  console.error('usage: node tools/build-manifest.mjs <chrome|firefox>');
  process.exit(1);
}

fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
console.log(`manifest.json → ${target} (v${m.version})`);
