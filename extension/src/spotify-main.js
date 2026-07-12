// MAIN-world script for open.spotify.com.
// The artist-ban API needs Spotify's short-lived Bearer token, which lives only
// in the page context (the /get_access_token endpoint is TOTP-gated and 403s).
// We sniff it by wrapping window.fetch, then perform the ban here and bridge
// results to the isolated content script via window.postMessage.
(() => {
  const NS = 'ammit-spotify';
  const BAN_ENDPOINT = 'https://spclient.wg.spotify.com/collection/v2/write?market=from_token';

  const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query';
  // Persisted-query hash for queryArtistOverview. Seeded with a known-good value
  // and refreshed live from the player's own requests (hashes rotate per client
  // version). If it goes stale with no refresh, feature extraction fails soft
  // and only the blocklist path runs.
  let overviewHash = 'ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a';
  let overviewTemplate = null;

  let authHeader = null;
  let capturedUsername = null;
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const headers = args[1]?.headers;
      const auth =
        headers instanceof Headers ? headers.get('authorization') : headers?.authorization ?? headers?.Authorization;
      if (auth?.startsWith('Bearer ') && auth.length > 40) authHeader = auth;

      const body = args[1]?.body;
      if (typeof body === 'string') {
        if (body.includes('queryArtistOverview')) {
          const b = JSON.parse(body);
          if (b.operationName === 'queryArtistOverview' && b.extensions?.persistedQuery?.sha256Hash) {
            overviewHash = b.extensions.persistedQuery.sha256Hash;
            overviewTemplate = b;
          }
        }
        // The player's own collection calls carry the authoritative username.
        if (!capturedUsername && body.includes('"username"')) {
          const u = JSON.parse(body)?.username;
          if (typeof u === 'string' && u && u !== 'anonymous') capturedUsername = u;
        }
      }
    } catch { /* ignore */ }
    return origFetch.apply(this, args);
  };

  function username() {
    if (capturedUsername) return capturedUsername;
    try {
      const key = Object.keys(localStorage).find((k) => k.includes(':') && !k.startsWith('anonymous:'));
      return key?.split(':')[0] ?? null;
    } catch {
      return null;
    }
  }

  async function banArtist(artistId) {
    if (!authHeader) return { ok: false, reason: 'no auth token captured yet' };
    const user = username();
    if (!user) return { ok: false, reason: 'no username resolved' }; // don't send a malformed write
    try {
      const res = await origFetch(BAN_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', authorization: authHeader },
        body: JSON.stringify({ username: user, set: 'artistban', items: [{ uri: `spotify:artist:${artistId}` }] }),
      });
      if (res.status === 401) authHeader = null;
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  async function artistFeatures(artistId) {
    if (!authHeader) return { _err: 'no token' };
    const body = {
      operationName: 'queryArtistOverview',
      variables: { uri: `spotify:artist:${artistId}`, locale: '', preReleaseV2: true },
      extensions: { persistedQuery: { version: 1, sha256Hash: overviewHash } },
      ...(overviewTemplate ? { variables: { ...overviewTemplate.variables, uri: `spotify:artist:${artistId}` } } : {}),
    };
    try {
      const res = await origFetch(PATHFINDER, {
        method: 'POST',
        headers: { authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { _err: res.status };
      const j = await res.json();
      const a = j?.data?.artistUnion;
      if (!a?.profile) return { _err: 'no artistUnion' };
      const d = a.discography ?? {};
      const albums = d.albums?.totalCount ?? 0;
      const singles = d.singles?.totalCount ?? 0;
      const years = [];
      for (const grp of ['albums', 'singles', 'popularReleasesAlbums']) {
        for (const it of d[grp]?.items ?? []) {
          const y = it.releases?.items?.[0]?.date?.year ?? it.date?.year;
          if (y) years.push(y);
        }
      }
      const totalReleases = albums + singles;
      const yearMin = years.length ? Math.min(...years) : null;
      const yearMax = years.length ? Math.max(...years) : null;
      const activeMonths = yearMin ? (yearMax - yearMin + 1) * 12 : null;
      const bio = a.profile.biography?.text ?? '';
      // Map onto the shared scoreFeatures() feature shape (see heuristics.js).
      return {
        channelId: null,
        name: a.profile.name,
        subscribers: a.stats?.followers ?? null,
        monthlyListeners: a.stats?.monthlyListeners ?? null,
        albums, singles, totalReleases,
        datedReleases: years.length,
        yearMin, yearMax,
        share2024plus: years.length ? years.filter((y) => y >= 2024).length / years.length : null,
        releasesPerMonth: activeMonths ? totalReleases / activeMonths : null,
        hasDescription: bio.trim().length > 0,
        aiKeyword: /\bsuno\b|\budio\b|ai[ -]generated|generative ai|created with ai/i.test(bio + ' ' + a.profile.name),
        // Real-world footprint (concerts/merch): scoreFeatures vetoes an 'ai'
        // verdict when present — zero on every confirmed-AI calibration sample.
        concerts: a.goods?.concerts?.totalCount ?? a.goods?.events?.concerts?.totalCount ?? null,
        merch: a.goods?.merch?.totalCount ?? a.goods?.merch?.items?.length ?? null,
      };
    } catch (e) {
      return { _err: String(e) };
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.ns !== NS || event.data?.dir !== 'req') return;
    const { id, type, artistId } = event.data;
    let payload;
    if (type === 'ban') payload = await banArtist(artistId);
    else if (type === 'features') payload = await artistFeatures(artistId);
    else if (type === 'has-token') payload = { ok: !!authHeader };
    else return;
    window.postMessage({ ns: NS, dir: 'res', id, payload }, '*');
  });

  console.log('[ammit] spotify main-world bridge ready');
})();
