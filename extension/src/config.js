// Instance defaults, baked into the build and overridable per-user from the
// popup (an empty field falls back to these). Forks self-hosting the backend
// only need to edit this file.
//
// Loaded by popup.html via a script tag, by the firefox event page via the
// manifest's background.scripts array, and by chrome's classic service worker
// via importScripts in background.js.
globalThis.AMMIT_DEFAULTS = {
  reportUrl: 'https://ammit.nolicen.se/v1/reports',
  syncUrl: 'https://ammit.nolicen.se/v1/blocklist.json',
};
