// Shared heuristic module: feature extraction via innertube + scoring.
// Used by the content script AND evaluated in the page by tools/collect-features.mjs,
// so calibration and runtime compute identical features. Keep dependency-free;
// scoreFeatures() must stay pure (it is also eval'd in node by tools/analyze-features.mjs).
var ytmAiban = (() => {
  const YEAR_RE = /\b(19|20)\d{2}\b/;
  const AI_KEYWORD_RE = /\bsuno\b|\budio\b|ai[ -]generated|generative ai|created with ai/i;

  function cfg(name) {
    const m = document.documentElement.innerHTML.match(new RegExp('"' + name + '":"([^"]+)"'));
    return m?.[1];
  }

  async function innertube(path, body) {
    const key = cfg('INNERTUBE_API_KEY');
    const ver = cfg('INNERTUBE_CLIENT_VERSION') ?? '1.20260101.01.00';
    const res = await fetch(`/youtubei/v1/${path}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: ver, hl: 'en' } },
        ...body,
      }),
    });
    if (!res.ok) throw new Error(`innertube ${path} ${res.status}`);
    return res.json();
  }

  function parseCount(txt) {
    const m = (txt ?? '').replaceAll(',', '').match(/([\d.]+)\s*([KMB])?/);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  // Resolve an artist name to a channel id (calibration helper).
  async function searchArtist(query) {
    const j = await innertube('search', { query });
    const sections =
      j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
    for (const s of sections) {
      const items = [
        ...(s.musicCardShelfRenderer ? [s.musicCardShelfRenderer] : []),
        ...(s.musicShelfRenderer?.contents ?? []),
      ];
      for (const it of items) {
        const ep =
          it.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint ??
          it.musicResponsiveListItemRenderer?.navigationEndpoint?.browseEndpoint;
        const pageType =
          ep?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' && ep.browseId?.startsWith('UC')) return ep.browseId;
      }
    }
    return null;
  }

  function gridItems(j) {
    const sections =
      j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
    for (const s of sections) {
      if (s.gridRenderer) return { items: s.gridRenderer.items ?? [], truncated: !!s.gridRenderer.continuations };
    }
    return { items: [], truncated: false };
  }

  function itemYear(it) {
    const sub = it.musicTwoRowItemRenderer?.subtitle?.runs?.map((r) => r.text).join('') ?? '';
    const y = sub.match(YEAR_RE)?.[0];
    return y ? +y : null;
  }

  async function extractFeatures(channelId) {
    const j = await innertube('browse', { browseId: channelId });
    const header = j?.header?.musicImmersiveHeaderRenderer ?? j?.header?.musicVisualHeaderRenderer ?? {};
    const name = header?.title?.runs?.[0]?.text ?? null;
    if (!name) throw new Error('no artist header for ' + channelId);
    const subscribers = parseCount(
      header?.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText?.runs?.[0]?.text
    );
    const description = header?.description?.runs?.map((r) => r.text).join(' ') ?? '';

    const sections =
      j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];

    // Play counts from the "Top songs" shelf (hl=en → "N plays" column).
    const topPlays = [];
    for (const c of sections) {
      for (const it of c.musicShelfRenderer?.contents ?? []) {
        for (const col of it.musicResponsiveListItemRenderer?.flexColumns ?? []) {
          const t = col.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map((r) => r.text).join('') ?? '';
          const m = t.match(/^([\d.,]+[KMB]?)\s*plays$/i);
          if (m) { const n = parseCount(m[1]); if (n) topPlays.push(n); }
        }
      }
    }

    let albums = 0, singles = 0, truncated = false;
    const years = [];
    for (const c of sections) {
      const car = c.musicCarouselShelfRenderer;
      if (!car) continue;
      const hdr = car.header?.musicCarouselShelfBasicHeaderRenderer;
      const title = hdr?.title?.runs?.[0]?.text ?? '';
      const isAlbums = title === 'Albums';
      const isSingles = title === 'Singles & EPs' || title === 'Singles';
      if (!isAlbums && !isSingles) continue;

      let items = car.contents ?? [];
      // Follow the "more" page for the full catalog when present (carousels cap at 10).
      const moreEp = hdr?.moreContentButton?.buttonRenderer?.navigationEndpoint?.browseEndpoint;
      if (moreEp?.browseId) {
        try {
          const jj = await innertube('browse', { browseId: moreEp.browseId, params: moreEp.params });
          const grid = gridItems(jj);
          if (grid.items.length > items.length) items = grid.items;
          truncated = truncated || grid.truncated;
        } catch (e) { /* keep carousel items */ }
      }
      if (isAlbums) albums += items.length; else singles += items.length;
      for (const it of items) {
        const y = itemYear(it);
        if (y) years.push(y);
      }
    }

    const totalReleases = albums + singles;
    const share2024plus = years.length ? years.filter((y) => y >= 2024).length / years.length : null;
    const yearMin = years.length ? Math.min(...years) : null;
    const yearMax = years.length ? Math.max(...years) : null;
    const activeMonths = yearMin ? (yearMax - yearMin + 1) * 12 : null;
    const maxPlays = topPlays.length ? Math.max(...topPlays) : null;
    return {
      channelId, name, subscribers, albums, singles, totalReleases, truncated,
      datedReleases: years.length,
      yearMin, yearMax, share2024plus,
      releasesPerMonth: activeMonths ? totalReleases / activeMonths : null,
      maxPlays,
      playsToSubs: maxPlays !== null ? maxPlays / Math.max(subscribers ?? 1, 1) : null,
      hasDescription: description.trim().length > 0,
      aiKeyword: AI_KEYWORD_RE.test(description + ' ' + name),
    };
  }

  // Pure scoring — weights calibrated on confirmed-AI vs. real-artist samples
  // (see tools/analyze-features.mjs). f.mbPresent is supplied by the caller
  // (MusicBrainz lookup happens outside the page).
  function scoreFeatures(f) {
    const reasons = [];
    let score = 0;
    const add = (pts, why) => { score += pts; reasons.push(`+${pts} ${why}`); };

    // The "all 2024+" signal needs at least a few dated releases so a single
    // undated/fluke item can't drive it. It does NOT require full-catalogue
    // coverage: Spotify's overview (and YouTube's paged extractor) reliably
    // surface the earliest album, so a real long-career artist shows a pre-2024
    // yearMin and share<1 even when recent singles dominate the sample.
    const sampled = f.datedReleases ?? 0;
    // Real reach (Spotify monthly listeners) rules out the "obscure/ghost"
    // low-audience heuristics; undefined on YouTube, so YT scoring is unchanged.
    const popular = (f.monthlyListeners ?? 0) >= 50000;
    // A large subscriber base is a real fanbase, not AI slop (which draws plays
    // but few subscribers). A recent all-2024 catalogue plus a big audience is a
    // genuine breakout/soundtrack act (e.g. a 2025 film OST), not a generator —
    // so the recency signal must not fire. Threshold sits well above every
    // calibration AI (max ~200k) and below observed false positives (~500k+).
    const bigFanbase = (f.subscribers ?? 0) >= 300000;

    if (f.aiKeyword) add(4, 'suno/udio/AI keyword in name or description');
    if (f.mbPresent === false) add(3, 'absent from MusicBrainz');
    if (!bigFanbase && sampled >= 3 && f.share2024plus !== null && f.share2024plus >= 0.8 && f.totalReleases >= 5)
      add(4, `catalog ~all 2024+ (${f.totalReleases} releases)`);
    if (f.totalReleases === 0 && f.mbPresent === false && (f.subscribers ?? 0) < 10000 && !popular)
      add(2, 'no releases, unknown ghost channel');
    if (f.totalReleases >= 20 && (f.subscribers ?? 0) < 20000 && !popular)
      add(2, `${f.totalReleases} releases but small audience`);
    if (sampled >= 3 && f.releasesPerMonth !== null && f.releasesPerMonth >= 1.5)
      add(2, `inhuman cadence (${f.releasesPerMonth.toFixed(1)} releases/month)`);
    if (!f.hasDescription) add(1, 'no channel description');

    const verdict = score >= 5 ? 'ai' : score >= 3 ? 'unsure' : 'human';
    return { score, verdict, reasons };
  }

  return { extractFeatures, scoreFeatures, searchArtist, parseCount };
})();
