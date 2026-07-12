// ammit-report-api — crowdsourced blocklist ingestion + aggregation + publish.
// Single file, zero npm dependencies (node:sqlite, Node >= 22).
// Design: docs/crowdsourcing-v2.md. Reads are meant to be served from the
// published git artifact behind a CDN; this service's own GET /v1/blocklist.json
// exists for bootstrap/testing and is cache-friendly (ETag + max-age).
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = (k, d) => process.env[k] ?? d;
const PORT = +env('PORT', 8080);
const DB_PATH = env('DB_PATH', '/data/ammit.db');
const ADMIN_TOKEN = env('ADMIN_TOKEN', '');
const HMAC_SALT = env('HMAC_SALT', 'dev-salt');
const CAP_INSTALL_DAY = +env('CAP_INSTALL_DAY', 30);
const CAP_IP_DAY = +env('CAP_IP_DAY', 60);
const MIN_INSTALLS = +env('MIN_INSTALLS', 3);
const MIN_IP_BUCKETS = +env('MIN_IP_BUCKETS', 3);
const MIN_AGE_HOURS = +env('MIN_AGE_HOURS', 48);
const NOT_AI_RATIO = +env('NOT_AI_RATIO', 0.34);
const AGGREGATE_INTERVAL_MIN = +env('AGGREGATE_INTERVAL_MIN', 60);
const SEED_PATH = env('SEED_PATH', 'extension/data/blocklist.json');
const HEURISTICS_PATH = env('HEURISTICS_PATH', 'extension/src/heuristics.js');
const IP_HEADER = env('IP_HEADER', 'cf-connecting-ip').toLowerCase();
const GIT_API_BASE = env('GIT_API_BASE', '');
const GIT_REPO = env('GIT_REPO', '');
const GIT_BRANCH = env('GIT_BRANCH', 'main');
const GIT_FILEPATH = env('GIT_FILEPATH', 'blocklist.json');
const GIT_TOKEN = env('GIT_TOKEN', '');

// --- shared scorer (same file the extension ships) ---
globalThis.document = { documentElement: { innerHTML: '' } };
const ammit = eval(`${readFileSync(HEURISTICS_PATH, 'utf8')}; ammit`);

// --- db ---
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    artist_key TEXT NOT NULL,
    name TEXT,
    action TEXT NOT NULL CHECK(action IN ('report','not_ai')),
    install_id TEXT NOT NULL,
    ip_bucket TEXT NOT NULL,
    evidence TEXT,
    ext_version TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(artist_key, install_id, action)
  );
  CREATE INDEX IF NOT EXISTS idx_reports_install ON reports(install_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reports_ip ON reports(ip_bucket, created_at);
  CREATE TABLE IF NOT EXISTS artists (
    artist_key TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    needs_review TEXT,
    first_seen INTEGER,
    promoted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

// --- metrics (in-memory counters; artist gauges come from the db) ---
const counters = { received: 0, accepted: 0, dropped_cap: 0, dropped_invalid: 0, aggregate_runs: 0, git_publishes: 0, git_errors: 0 };

// --- helpers ---
const ID_RE = { yt: /^UC[\w-]{22}$/, sp: /^[0-9A-Za-z]{22}$/ };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /24 (or ipv6 /48) bucket, HMAC'd with a weekly-rotating key: rate-limit and
// distinctness signal without ever storing a raw IP.
function ipBucket(req) {
  const ip = (req.headers[IP_HEADER] ?? req.socket.remoteAddress ?? '').trim();
  const prefix = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.');
  const week = Math.floor(Date.now() / (7 * 86400e3));
  return createHmac('sha256', `${HMAC_SALT}:${week}`).update(prefix).digest('hex').slice(0, 24);
}

// Anti-brigading gate: evidence must look like AI slop to be auto-promotable.
// Returns null when clean, else the sticky needs-review reason.
function evidenceGate(evidence) {
  if (!evidence || typeof evidence !== 'object') return 'no-evidence';
  if (evidence.fv !== ammit.FEATURES_VERSION || !evidence.features) return 'stale-evidence';
  const f = evidence.features;
  if (f.mbPresent === true) return 'mb-present';
  if ((f.subscribers ?? 0) >= 300000 || (f.monthlyListeners ?? 0) >= 300000) return 'big-audience';
  const res = ammit.scoreFeatures(f);
  if (res.verdict !== 'ai') return `scored-${res.verdict}`;
  return null;
}

function json(res, code, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extra });
  res.end(data);
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// --- ingestion ---
function handleReport(req, body, res) {
  counters.received++;
  const { platform, artistId, name, action, evidence, installId, extVersion } = body ?? {};
  const ok =
    (platform === 'yt' || platform === 'sp') &&
    typeof artistId === 'string' && ID_RE[platform].test(artistId) &&
    (action === 'report' || action === 'not_ai') &&
    typeof installId === 'string' && UUID_RE.test(installId);
  if (!ok) { counters.dropped_invalid++; return json(res, 400, { ok: false, reason: 'bad request' }); }

  const bucket = ipBucket(req);
  const dayAgo = Date.now() - 86400e3;
  const byInstall = db.prepare('SELECT COUNT(*) c FROM reports WHERE install_id = ? AND created_at > ?').get(installId, dayAgo).c;
  const byIp = db.prepare('SELECT COUNT(*) c FROM reports WHERE ip_bucket = ? AND created_at > ?').get(bucket, dayAgo).c;
  // Capped submissions still get 202 — no oracle for probing the filters.
  if (byInstall >= CAP_INSTALL_DAY || byIp >= CAP_IP_DAY) { counters.dropped_cap++; return json(res, 202, { ok: true }); }

  const key = `${platform}:${artistId}`;
  const inserted = db.prepare(
    'INSERT OR IGNORE INTO reports (artist_key, name, action, install_id, ip_bucket, evidence, ext_version, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(key, name ?? null, action, installId, bucket, evidence ? JSON.stringify(evidence) : null, extVersion ?? null, Date.now());

  if (inserted.changes > 0 && action === 'report') {
    db.prepare('INSERT OR IGNORE INTO artists (artist_key, name, first_seen) VALUES (?,?,?)').run(key, name ?? null, Date.now());
    const gate = evidenceGate(evidence);
    // needs_review is sticky-clearable: clean evidence from any reporter clears
    // a "no-evidence" flag, but hard flags (mb-present, big-audience) stick.
    const row = db.prepare('SELECT needs_review FROM artists WHERE artist_key = ?').get(key);
    if (gate && !row.needs_review) db.prepare('UPDATE artists SET needs_review = ? WHERE artist_key = ?').run(gate, key);
    if (!gate && (row.needs_review === 'no-evidence' || row.needs_review === 'stale-evidence'))
      db.prepare('UPDATE artists SET needs_review = NULL WHERE artist_key = ?').run(key);
  }
  counters.accepted++;
  json(res, 202, { ok: true });
}

// --- aggregation + publish ---
function aggregate() {
  counters.aggregate_runs++;
  const rows = db.prepare(`
    SELECT a.artist_key, a.status, a.needs_review, a.first_seen,
      (SELECT COUNT(DISTINCT install_id) FROM reports r WHERE r.artist_key = a.artist_key AND r.action = 'report') installs,
      (SELECT COUNT(DISTINCT ip_bucket) FROM reports r WHERE r.artist_key = a.artist_key AND r.action = 'report') buckets,
      (SELECT COUNT(DISTINCT install_id) FROM reports r WHERE r.artist_key = a.artist_key AND r.action = 'not_ai') notai
    FROM artists a WHERE a.status IN ('queued','community')
  `).all();
  const now = Date.now();
  for (const r of rows) {
    const contested = r.notai >= (r.installs + r.notai) * NOT_AI_RATIO;
    if (r.status === 'community' && contested) {
      db.prepare("UPDATE artists SET status = 'queued', needs_review = 'contested' WHERE artist_key = ?").run(r.artist_key);
      continue;
    }
    const eligible = r.status === 'queued' && !r.needs_review && !contested &&
      r.installs >= MIN_INSTALLS && r.buckets >= MIN_IP_BUCKETS &&
      now - r.first_seen >= MIN_AGE_HOURS * 3600e3;
    if (eligible) db.prepare("UPDATE artists SET status = 'community', promoted_at = ? WHERE artist_key = ?").run(now, r.artist_key);
  }
  return publish();
}

function publish() {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const have = new Set();
  for (const a of seed.artists) {
    if (a.channelId) have.add(`yt:${a.channelId}`);
    if (a.spotifyId) have.add(`sp:${a.spotifyId}`);
  }
  const crowd = db.prepare("SELECT artist_key, name, status FROM artists WHERE status IN ('community','confirmed')").all()
    .filter((a) => !have.has(a.artist_key))
    .map((a) => {
      const [platform, id] = [a.artist_key.slice(0, 2), a.artist_key.slice(3)];
      return {
        name: a.name,
        channelId: platform === 'yt' ? id : null,
        spotifyId: platform === 'sp' ? id : null,
        confidence: a.status, // 'community' | 'confirmed'
        source: 'crowd',
      };
    });
  const artifact = {
    artists: [...seed.artists, ...crowd],
    stats: { ...seed.stats, crowd: crowd.length, total: seed.artists.length + crowd.length },
    generatedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(artifact);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  const prev = db.prepare('SELECT v FROM kv WHERE k = ?').get('etag')?.v;
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('blocklist', body);
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('etag', etag);
  if (etag !== prev) gitPublish(body).catch((e) => { counters.git_errors++; console.error('[git] publish failed:', e.message); });
  return { crowd: crowd.length, total: artifact.stats.total, etag };
}

// Push the artifact via the git contents API (Gitea and GitHub share the shape).
async function gitPublish(content) {
  if (!GIT_API_BASE || !GIT_REPO || !GIT_TOKEN) return;
  const base = `${GIT_API_BASE}/repos/${GIT_REPO}/contents/${encodeURIComponent(GIT_FILEPATH)}`;
  const headers = { authorization: `token ${GIT_TOKEN}`, 'content-type': 'application/json' };
  const cur = await fetch(`${base}?ref=${GIT_BRANCH}`, { headers });
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const res = await fetch(base, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: 'chore: publish community blocklist',
      content: Buffer.from(content).toString('base64'),
      branch: GIT_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`contents API ${res.status}`);
  counters.git_publishes++;
}

// --- admin ---
function adminAuth(req, res) {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
    json(res, 401, { ok: false });
    return false;
  }
  return true;
}

// --- http ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/v1/reports') return handleReport(req, await readBody(req), res);
    if (req.method === 'GET' && url.pathname === '/v1/blocklist.json') {
      let body = db.prepare('SELECT v FROM kv WHERE k = ?').get('blocklist')?.v;
      if (!body) { publish(); body = db.prepare('SELECT v FROM kv WHERE k = ?').get('blocklist').v; }
      const etag = db.prepare('SELECT v FROM kv WHERE k = ?').get('etag').v;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
        etag,
        'access-control-allow-origin': '*',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const status = db.prepare('SELECT status, COUNT(*) c FROM artists GROUP BY status').all();
      const lines = [
        ...Object.entries(counters).map(([k, v]) => `ammit_${k}_total ${v}`),
        ...status.map((s) => `ammit_artists{status="${s.status}"} ${s.c}`),
        `ammit_reports_rows ${db.prepare('SELECT COUNT(*) c FROM reports').get().c}`,
      ];
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(lines.join('\n') + '\n');
    }
    if (url.pathname === '/admin/queue' && req.method === 'GET') {
      if (!adminAuth(req, res)) return;
      const rows = db.prepare(`
        SELECT a.*, (SELECT COUNT(DISTINCT install_id) FROM reports r WHERE r.artist_key = a.artist_key AND r.action='report') installs,
                    (SELECT COUNT(DISTINCT install_id) FROM reports r WHERE r.artist_key = a.artist_key AND r.action='not_ai') notai
        FROM artists a WHERE a.status IN ('queued','community') ORDER BY installs DESC LIMIT 200
      `).all();
      return json(res, 200, rows);
    }
    if (url.pathname === '/admin/decide' && req.method === 'POST') {
      if (!adminAuth(req, res)) return;
      const { artistKey, status } = await readBody(req);
      if (!['confirmed', 'rejected', 'protected', 'queued'].includes(status)) return json(res, 400, { ok: false });
      const r = db.prepare('UPDATE artists SET status = ?, needs_review = NULL WHERE artist_key = ?').run(status, artistKey);
      publish();
      return json(res, 200, { ok: true, changed: r.changes });
    }
    if (url.pathname === '/admin/aggregate' && req.method === 'POST') {
      if (!adminAuth(req, res)) return;
      return json(res, 200, aggregate());
    }
    json(res, 404, { ok: false });
  } catch (e) {
    json(res, e.message === 'body too large' ? 413 : 400, { ok: false });
  }
});

server.listen(PORT, () => console.log(`[ammit-report-api] :${PORT} db=${DB_PATH} fv=${ammit.FEATURES_VERSION}`));
if (AGGREGATE_INTERVAL_MIN > 0) setInterval(aggregate, AGGREGATE_INTERVAL_MIN * 60e3);
