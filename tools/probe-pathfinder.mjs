// Calibrate a Spotify heuristic: capture the player's own queryArtistOverview
// persisted-query hash + auth token, then replay it for AI + real artists.
// Read-only. Usage: node tools/probe-pathfinder.mjs
import { chromium } from 'playwright-core';

const AI = {
  'Xania Monet': '0YIEJNJUCsjzeWwj8Xh2LD',
  'The Velvet Sundown': '2GRtyAXWUiisGYub5SGMrb',
  'Aiyun': '4dSpK6RQ66rjinHJxA5P8s',
  'Breaking Rust': '3h9rLaviiFj1TeEhdIRpP5',
  'Nick Hustles': '4y6CMS7tqBf8ubmUuP9SQI',
  'Aventhis': '0a97V3mDhGyNg93Dcf9Ahj',
};
const REAL = {
  Radiohead: '4Z8W4fKeB5YxbusRsdQVPb',
  'Kendrick Lamar': '2YZyLoL8N0Wb9xBt1NhZWg',
  Coldplay: '4gzpq5DPGxSnKTe4SA8HAU',
  'Billie Eilish': '6qqNVTkY8uBg9cP3Jd7DAH',
  Verdena: '4Kv1LMHvKM4QTVA2X3Vdb0',
  'boy pablo': '7wDwGB0PB1LK8roLYT9kO3',
};

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://open.spotify.com'));

let token = null, hash = null, template = null;
page.on('request', (r) => { const a = r.headers()['authorization']; if (a?.startsWith('Bearer ') && !token) token = a.slice(7); });
page.on('request', (r) => {
  if (!/pathfinder\/v2\/query/.test(r.url())) return;
  try {
    const b = JSON.parse(r.postData());
    if (b.operationName === 'queryArtistOverview') { hash = b.extensions.persistedQuery.sha256Hash; template = b; }
  } catch { /* */ }
});

await page.goto('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 20 && (!token || !hash); i++) await page.waitForTimeout(500);
if (!token || !hash) { console.error('missing token/hash', { token: !!token, hash: !!hash }); process.exit(1); }
console.log('captured hash', hash.slice(0, 12), '…');

async function overview(uri) {
  const body = { ...template, variables: { ...template.variables, uri } };
  const res = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { _err: res.status };
  return res.json();
}

function features(a) {
  const d = a?.discography ?? {};
  const albums = d.albums?.totalCount ?? 0;
  const singles = d.singles?.totalCount ?? 0;
  const releases = albums + singles;
  const years = [];
  for (const grp of ['albums', 'singles', 'popularReleasesAlbums']) {
    for (const it of d[grp]?.items ?? []) {
      const y = it.releases?.items?.[0]?.date?.year ?? it.date?.year;
      if (y) years.push(y);
    }
  }
  const ml = a?.stats?.monthlyListeners ?? null;
  const fol = a?.stats?.followers ?? null;
  const share2024 = years.length ? years.filter((y) => y >= 2024).length / years.length : null;
  return {
    name: a?.profile?.name, monthlyListeners: ml, followers: fol,
    listenersPerFollower: ml && fol ? +(ml / fol).toFixed(1) : null,
    albums, singles, releases,
    yearMin: years.length ? Math.min(...years) : null, yearMax: years.length ? Math.max(...years) : null,
    share2024: share2024 == null ? null : +share2024.toFixed(2),
  };
}

const rows = [];
for (const [label, group] of [['ai', AI], ['real', REAL]]) {
  for (const [name, id] of Object.entries(group)) {
    const j = await overview(`spotify:artist:${id}`);
    if (j._err) { console.log(label, name, 'err', j._err); continue; }
    const f = features(j.data?.artistUnion);
    rows.push({ label, ...f });
    console.log(label, '|', f.name, '| ML', f.monthlyListeners, '| fol', f.followers, '| L/F', f.listenersPerFollower, '| rel', f.releases, '| 2024+', f.share2024, '| yrs', f.yearMin + '-' + f.yearMax);
    await page.waitForTimeout(400);
  }
}
console.log('\nJSON', JSON.stringify(rows));
await browser.close();
