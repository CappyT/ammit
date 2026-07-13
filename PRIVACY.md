# Ammit — Privacy Policy

_Last updated: 2026-07-13_

Ammit is a browser extension that detects and skips AI-generated music
artists on YouTube Music and the Spotify Web Player. It is designed to work
without collecting personal data.

## What the extension collects

**Nothing, by default.** Ammit has no analytics, no telemetry, no tracking,
and requires no account. All settings, blocklists, whitelists and cached
artist metadata are stored locally in your browser (`chrome.storage.local`)
and never leave it.

## Network requests the extension makes

- **music.youtube.com / open.spotify.com** — the pages you are already on;
  the extension reads the current artist from the player and, in the optional
  full-action mode, uses your own Spotify session to ban an artist in your
  library. Your credentials are never read, stored or transmitted anywhere.
- **musicbrainz.org** — artist name lookups against the open music database,
  used as a detection signal. Only the artist name is sent.
- **raw.githubusercontent.com / gist.githubusercontent.com** — downloads of
  blocklist updates (plain JSON, no user data attached).

## Opt-in community reporting

Reporting is **disabled by default** and only active if you explicitly enable
it in the settings and configure a report server. When enabled, a report
contains:

- a random install identifier generated at install time (not derived from,
  or linkable to, your identity, hardware or accounts);
- the reported artist's public identifier and name;
- the verdict (AI / not AI) and the public catalog metadata the verdict was
  based on (release counts and dates, audience size, concert/merchandise
  presence);
- the extension version.

Reports never include personal information, browsing or listening history,
account data, or page content. On the server side, IP addresses are used only
transiently for rate limiting as coarse, salted network buckets and are not
stored with reports.

## Data sharing and selling

No data is sold or shared with third parties. Aggregated, non-personal
blocklist data (artist identifiers and verdicts) may be published openly as
part of the community blocklist.

## Your choices

- Community reporting is opt-in and can be disabled at any time.
- All locally stored data is removed by uninstalling the extension.

## Changes

Changes to this policy are published in this file, in this repository, with
the date above updated.

## Contact

Open an issue at https://github.com/CappyT/ammit/issues
