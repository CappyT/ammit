# Ammit 🐊

*In Egyptian mythology, Ammit devoured the hearts of impure souls. This one
devours AI-generated music.*

Browser extension (MV3, Chrome + Firefox ≥140) that filters AI-generated music
on **YouTube Music** and **Spotify** from one shared blocklist: blocked tracks
are skipped by default, with opt-in escalation to dislike (YTM) and permanent
artist-ban (Spotify).

## How it works — YouTube Music

A content script observes the `ytmusic-player-bar` for track changes, extracts the
artist name + channel ID from the byline, and matches them against a bundled
blocklist (O(1) lookup by channel ID and normalized name). On a match it clicks
dislike (idempotent via the `like-status` attribute), waits 400ms for the feedback
request to fire, then clicks next.

## How it works — Spotify

Spotify has no per-track dislike, so the equivalent is **skip + artist-ban**. A
content script watches the now-playing widget, matches every credited artist
(collabs included) by Spotify ID / name against the blocklist, clicks skip, and
bans each blocked artist via Spotify's internal `collection/v2/write` endpoint
(`set: "artistban"`) so Spotify's own engine stops serving them. The ban needs
the page's short-lived Bearer token, which only exists in the page context (the
`/get_access_token` endpoint is TOTP-gated and 403s), so a `world: "MAIN"`
script (`src/spotify-main.js`) sniffs it by wrapping `window.fetch` and performs
the API call, bridged to the isolated content script via `postMessage`. The ban
is the durable mechanism; on free accounts skips are rate-limited (best-effort).
Ads carry no artist link, so they're ignored. Tracks are keyed by per-track id
(cover-link `uri`, else album+title) so consecutive songs by the same blocked
artist each get skipped — a ban does not stop an already-queued track.

The same heuristic scorer runs on Spotify for unlisted artists: features come
from the player's internal `pathfinder` GraphQL `queryArtistOverview` (followers,
monthly listeners, full discography with release years) — the public
`api.spotify.com` is rate-limited (429) for the web token, so the main-world
script sniffs the persisted-query hash from the player's own traffic and replays
it. Validated 7/7 on a Spotify AI/real sample; the dominant signal is the same
"catalogue entirely 2024+, no back-catalogue" (AI share2024 = 1.00, real 0.03–
0.47). Monthly-listeners-to-followers ratio does not discriminate (AI 1.4–4.9,
real 0.6–2.6) and is not scored — same finding as YT's plays-to-subscribers.

## Blocklist

3600+ artists compiled from four community sources
([soul-over-ai](https://github.com/xoundbyte/soul-over-ai) — YT + Spotify IDs +
disclosure, [surasshu's Blocktube list](https://surasshu.com/blocklist-for-ai-music-on-youtube/),
[CevvalYoutubeAIBlocklist](https://github.com/cevvalkoala/CevvalYoutubeAIBlocklist),
[eye-wave/spotify-ai-blocklist](https://github.com/eye-wave/spotify-ai-blocklist) —
Spotify IDs), with per-entry confidence (`confirmed` = self-disclosed/press-
confirmed, `suspected` = community-listed) and whichever of `channelId` /
`spotifyId` / `name` each source provides. Rebuild with:

```sh
node tools/build-blocklist.mjs
```

User data lives in separate storage keys (`userBlocklist`, `whitelist`) and survives
blocklist rebuilds.

### Credits

The bundled blocklist stands on the shoulders of the people who research and
maintain these community lists — thank you for the hard work:

- [xoundbyte](https://github.com/xoundbyte) — [soul-over-ai](https://github.com/xoundbyte/soul-over-ai)
- [surasshu](https://surasshu.com) — [blocklist for AI music on YouTube](https://surasshu.com/blocklist-for-ai-music-on-youtube/)
- [cevvalkoala](https://github.com/cevvalkoala) — [CevvalYoutubeAIBlocklist](https://github.com/cevvalkoala/CevvalYoutubeAIBlocklist)
- [eye-wave](https://github.com/eye-wave) — [spotify-ai-blocklist](https://github.com/eye-wave/spotify-ai-blocklist)

## Development

Branded Chrome ≥137 ignores `--load-extension`; the extension is injected through the
CDP `Extensions.loadUnpacked` command instead (requires
`--enable-unsafe-extension-debugging`).

```sh
./tools/launch-browser.sh       # start test Chrome (persistent profile) + inject extension
node tools/load-extension.mjs   # (re)inject after code changes
node tools/eval.mjs '<expr>'    # evaluate JS in the YT Music tab
node tools/check-cs.mjs         # reload tab, dump content-script logs
node tools/test-block.mjs [UC…] # E2E: play a blocklisted artist, watch dislike+skip
node tools/test-guard.mjs       # regression: stale verdict must not touch an innocent track
node tools/test-race.mjs        # regression: hard navigation kills in-flight evaluation
node tools/eval.mjs '<expr>' https://open.spotify.com   # eval in the Spotify tab
node tools/test-spotify-e2e.mjs <artistId>              # play a blocklisted artist, watch skip+ban
node tools/test-spotify-heuristic.mjs                   # heuristic chain on AI/real sample (read-only)
node tools/probe-pathfinder.mjs                         # calibration: replay queryArtistOverview
node tools/spotify-unban.mjs <artistId>                 # test cleanup (see caveat below)
```

`test-spotify-e2e.mjs` and the Spotify ban tooling write to the logged-in
account's `artistban` set — use a throwaway account. A clean programmatic unban
endpoint wasn't found (`collection/v2/delete|remove` 404, `write` with `remove`
400); remove bans from the Spotify UI if needed.

### Firefox

Firefox ≥140 is required (`data_collection_permissions` in the manifest; the
MAIN-world content scripts alone would allow 128). One codebase serves both
browsers: the repo manifest declares both `background.service_worker` (Chrome)
and `background.scripts` (Firefox event page) plus the AMO-required
`browser_specific_settings.gecko` block, and each `chrome.*`-using file aliases
`browser` over `chrome` since Firefox only returns promises on `browser.*`.
Store packages are built with a single-browser manifest
(`node tools/build-manifest.mjs <chrome|firefox>`, restore with git after).

The backend endpoints default to the public instance (`src/config.js`, shown
as placeholders in the popup); users override them per-install from the popup,
forks self-hosting the backend edit that one file.

```sh
./tools/launch-firefox.sh   # web-ext run: temporary install, auto-reload on changes
```

The CDP tooling above (`eval.mjs`, `test-*.mjs`) is Chrome-only; on Firefox use
the extension debugging console (`about:debugging` → Ammit → Inspect).

Distribution happens from the stores: tagged releases submit the new version
to the AMO listed channel (`AMO_JWT_ISSUER`/`AMO_JWT_SECRET` repo secrets from
[AMO API keys](https://addons.mozilla.org/developers/addon/api/key/)) and
upload+publish to the Chrome Web Store (`CWS_EXTENSION_ID`, `CWS_CLIENT_ID`,
`CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` secrets — Google Cloud OAuth client
with the Chrome Web Store API enabled). Jobs skip with a warning when the
secrets are missing.

### Wrong-target protection

The player bar exposes no readable track identity (videoId lives in Polymer
props), so every action is transactional on DOM reads: a track is acted on only
after two identical reads 250ms apart (mid-transition reads mix old byline with
new title), the track is re-verified immediately before the dislike click, and
again before the delayed skip — if it changed in the meantime (natural end,
user action, async verdict landing late) nothing is touched. Storage writes the
extension makes itself (verdict/MusicBrainz caches) no longer retrigger
evaluation.

The test profiles live in `.chrome-profile/` and `.firefox-profile/`
(gitignored, keep logins).

## Verified selectors (2026-07)

**music.youtube.com**

| What | Selector |
|---|---|
| artist links | `ytmusic-player-bar .byline a[href^="channel/"]` |
| dislike | `ytmusic-player-bar #button-shape-dislike button` |
| like state | `ytmusic-like-button-renderer[like-status]` → `INDIFFERENT\|LIKE\|DISLIKE` |
| next | `ytmusic-player-bar .next-button button` |

**open.spotify.com**

| What | Selector |
|---|---|
| now-playing widget | `[data-testid=now-playing-widget]` |
| artist links | `[data-testid=now-playing-widget] a[href*="/artist/"]` (locale-prefixed, e.g. `/intl-it/artist/<id>`) |
| skip | `[data-testid=control-button-skip-forward]` |
| ban API | `POST spclient.wg.spotify.com/collection/v2/write` · body `{username, set:"artistban", items:[{uri:"spotify:artist:<id>"}]}` |

aria-labels are localized — never match on them.

## Heuristic scorer

Artists not on the blocklist are scored live (`src/heuristics.js`): the content
script fetches the artist page via innertube `browse` (subscribers, full album/
singles catalog with release years by following the "more" pages, top-song play
counts, description), asks the service worker for a MusicBrainz presence check
(cached, 1.2s throttle), and applies a weighted point system. `score ≥ threshold`
(default 5, configurable 3–8 from the popup) → verdict `ai`; the 2 points below
the threshold are `unsure`. **Blocklist-first**: by default a heuristic `ai`
verdict only flags the artist for review in the popup (toast + review list);
auto-action is opt-in (`auto-block heuristic verdicts`). A real-world footprint
vetoes an `ai` verdict outright on both platforms: Spotify concerts or merch
> 0, YTM a "Live performances" shelf — each absent on every confirmed-AI
channel probed and present only on artists who actually perform ("Featured on"
and "Playlists by" looked similar but appear on AI channels too — rejected).
A track the user has liked/saved is never acted on regardless of verdict.

The cache stores **features** (facts), not verdicts: score and verdict are
derived at decision time from the current scorer + threshold, so recalibrations
and slider moves apply retroactively to everything already scored (a stale
cached verdict once kept dislike-nuking a false positive after the scorer had
been fixed). `FEATURES_VERSION` gates entries from older extractors.

Weights were calibrated on 30 confirmed-AI + 30 real artists collected with the
same extractor (`tools/collect-features.mjs` + `tools/analyze-features.mjs`):
**26/30 AI auto-blocked, 0/29 real artists misclassified**. Strongest signals
measured: catalog ≥80% released 2024+ (real artists max out at ~0.6), absence
from MusicBrainz (25/30 AI vs 0/29 real). Notably, plays-to-subscribers ratio
does NOT discriminate (real artists often rank higher — plays accumulate over
years) and is deliberately not scored.

## Popup

Enable toggle · current track with verdict badge (blocklist/ai/unsure/human/
whitelisted + score with reasons on hover) · block / whitelist current artist ·
AI threshold slider (3 = strictest, 8 = most conservative; applies live, cached
verdicts included) · `auto-block heuristic verdicts` (default off: heuristic
verdicts only appear in the review list) · `full action` (default off: blocked
tracks are only **skipped**; opt in to also dislike on YT Music / ban the artist
on Spotify) · review list of suspected-AI artists with one-click **Block** /
**Not AI** · remote blocklist sync (set a raw-JSON URL, `Sync blocklist` button;
the service worker also re-syncs on browser start when older than 24h).

## Community blocklist (v2)

The backend
lives in its own repo — **[CappyT/ammit-backend](https://github.com/CappyT/ammit-backend)**
(Go, pluggable sqlite/postgres, DoS-hardened, mandatory proof-of-work) — with
k8s manifests and a docker-compose for non-Kubernetes hosting.

Extension side: `contribute reports` toggle + report API URL in the popup;
Block / Not AI (review list, current-track buttons and the on-page badge) also
submit an anonymous report (artist ids + feature snapshot + random install
id) carrying the required PoW; the client follows the server's `/v1/config`
dials (difficulty, sampling). Spotify ban requires `confirmed` confidence —
`suspected` (imported lists) and `community` (auto-promoted) entries skip only.

## License

[GPL-3.0](LICENSE).

## Roadmap

- Import updated source lists periodically (`tools/build-blocklist.mjs`).
- In-popup Spotify unban for artists banned before skip-only became the default.
- Per-artist community status in the popup (`GET /v1/artist/:key`).
