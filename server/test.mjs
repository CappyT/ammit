// Self-contained e2e test for server.mjs: spawns the server against a scratch
// DB with low thresholds, exercises ingestion, caps, evidence gating,
// promotion, admin flow and the published artifact. Exits non-zero on failure.
// Run: node server/test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { authorization: 'Bearer testtoken' };

const srv = spawn(process.execPath, [join(root, 'server/server.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(mkdtempSync(join(tmpdir(), 'ammit-test-')), 'test.db'),
    ADMIN_TOKEN: 'testtoken',
    MIN_INSTALLS: '3',
    MIN_IP_BUCKETS: '3',
    MIN_AGE_HOURS: '0',
    CAP_INSTALL_DAY: '8',
    AGGREGATE_INTERVAL_MIN: '0',
    SEED_PATH: join(root, 'extension/data/blocklist.json'),
    HEURISTICS_PATH: join(root, 'extension/src/heuristics.js'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const uuid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const YT = (s) => 'UC' + s.repeat(22).slice(0, 22);
const AI_EVIDENCE = { fv: 2, features: { mbPresent: false, datedReleases: 5, share2024plus: 1, totalReleases: 12, subscribers: 100, hasDescription: false, releasesPerMonth: 2 } };
const REAL_EVIDENCE = { fv: 2, features: { ...AI_EVIDENCE.features, mbPresent: true } };

async function post(path, body, ip = '10.0.0.1', headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const report = (artistId, installN, ip, extra = {}) =>
  post('/v1/reports', { platform: 'yt', artistId, name: `Artist ${artistId.slice(-2)}`, action: 'report', evidence: AI_EVIDENCE, installId: uuid(installN), extVersion: 'test', ...extra }, ip);
const blocklist = async () => (await fetch(BASE + '/v1/blocklist.json')).json();
const aggregate = () => post('/admin/aggregate', {}, '10.9.9.9', ADMIN);

try {
  check('invalid platform → 400', (await post('/v1/reports', { platform: 'xx', artistId: YT('A'), action: 'report', installId: uuid(1) })).status === 400);
  check('bad artistId → 400', (await post('/v1/reports', { platform: 'yt', artistId: 'UCshort', action: 'report', installId: uuid(1) })).status === 400);
  check('bad installId → 400', (await post('/v1/reports', { platform: 'yt', artistId: YT('A'), action: 'report', installId: 'nope' })).status === 400);

  // promotion: 3 installs from 3 different /24s, clean AI evidence
  const A = YT('A');
  check('report → 202', (await report(A, 1, '10.0.1.1')).status === 202);
  check('duplicate → 202 (idempotent)', (await report(A, 1, '10.0.1.1')).status === 202);
  await report(A, 2, '10.0.2.1');
  await aggregate();
  check('2 installs < MIN(3) → not promoted', !(await blocklist()).artists.some((a) => a.channelId === A));
  await report(A, 3, '10.0.3.1');
  await aggregate();
  const promoted = (await blocklist()).artists.find((a) => a.channelId === A);
  check('3 installs + 3 buckets → community', promoted?.confidence === 'community');

  // ip-bucket distinctness: same /24 must not promote
  const B = YT('B');
  for (const n of [4, 5, 6]) await report(B, n, '10.7.7.' + n);
  await aggregate();
  check('3 installs 1 subnet → not promoted', !(await blocklist()).artists.some((a) => a.channelId === B));

  // brigading guard: real-artist evidence can never auto-promote
  const C = YT('C');
  for (const n of [1, 2, 3]) await report(C, n, `10.1.${n}.1`, { evidence: REAL_EVIDENCE });
  await aggregate();
  check('mb-present evidence → not promoted', !(await blocklist()).artists.some((a) => a.channelId === C));
  const queue = await (await fetch(BASE + '/admin/queue', { headers: ADMIN })).json();
  check('flagged needs-review in queue', queue.some((q) => q.artist_key === `yt:${C}` && q.needs_review === 'mb-present'));

  // not_ai contest blocks promotion
  const D = YT('D');
  for (const n of [1, 2, 3]) await report(D, n, `10.2.${n}.1`);
  for (const n of [7, 8]) await post('/v1/reports', { platform: 'yt', artistId: D, action: 'not_ai', installId: uuid(n) }, `10.3.${n}.1`);
  await aggregate();
  check('contested → not promoted', !(await blocklist()).artists.some((a) => a.channelId === D));

  // admin decide → confirmed
  const dec = await post('/admin/decide', { artistKey: `yt:${C}`, status: 'confirmed' }, '10.9.9.9', ADMIN);
  check('decide → 200', dec.status === 200 && dec.body.changed === 1);
  check('confirmed in artifact', (await blocklist()).artists.find((a) => a.channelId === C)?.confidence === 'confirmed');
  check('admin without token → 401', (await post('/admin/aggregate', {}, '10.9.9.9')).status === 401);

  // install cap
  for (let i = 0; i < 8; i++) await report(YT(String(i)), 1, '10.5.0.1');
  const metrics = await (await fetch(BASE + '/metrics')).text();
  check('cap drops counted', /ammit_dropped_cap_total [1-9]/.test(metrics));

  // caching + format
  const r1 = await fetch(BASE + '/v1/blocklist.json');
  const r2 = await fetch(BASE + '/v1/blocklist.json', { headers: { 'if-none-match': r1.headers.get('etag') } });
  check('ETag 304', r2.status === 304);
  check('cache-control set', r1.headers.get('cache-control')?.includes('max-age=3600'));
  const list = await blocklist();
  check('seed included', list.stats.total >= 3688, `total=${list.stats.total}`);
  check('artifact format compatible', list.artists.every((a) => 'name' in a && 'channelId' in a && 'spotifyId' in a && a.confidence));
} finally {
  srv.kill();
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
