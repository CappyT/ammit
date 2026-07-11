// Evaluate the shipped scorer against collected calibration data.
// Usage: node tools/analyze-features.mjs <features.json>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(process.argv[2] ?? join(root, 'features.json'), 'utf8'))
  // Older feature dumps predate the datedReleases field; the YT extractor follows
  // every "more" page so at runtime datedReleases ≈ totalReleases. Inject that
  // proxy so this validation matches current runtime behaviour.
  .map((r) => ({ ...r, datedReleases: r.datedReleases ?? r.totalReleases }));

// scoreFeatures is pure; the DOM-touching functions are never called here.
globalThis.document = { documentElement: { innerHTML: '' } };
const src = readFileSync(join(root, 'extension/src/heuristics.js'), 'utf8');
const ytmAiban = eval(`${src}; ytmAiban`);

const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? +v.toFixed(2) : v);
const confusion = { ai: {}, real: {} };

console.log('label | name | subs | rel | 2024+ | rate/mo | mb | desc | kw | score | verdict');
for (const r of rows) {
  const { score, verdict } = ytmAiban.scoreFeatures(r);
  confusion[r.label][verdict] = (confusion[r.label][verdict] ?? 0) + 1;
  console.log([r.label, r.name, fmt(r.subscribers), r.totalReleases, fmt(r.share2024plus),
    fmt(r.releasesPerMonth), fmt(r.mbPresent), r.hasDescription ? 'y' : 'n',
    r.aiKeyword ? 'y' : 'n', score, verdict].join(' | '));
}

console.log('\nconfusion:', JSON.stringify(confusion));
for (const feat of ['hasDescription', 'aiKeyword']) {
  const share = (label) => {
    const s = rows.filter((r) => r.label === label);
    return (s.filter((r) => r[feat]).length / s.length).toFixed(2);
  };
  console.log(`${feat}: ai=${share('ai')} real=${share('real')}`);
}
