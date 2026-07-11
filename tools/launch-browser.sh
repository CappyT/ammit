#!/usr/bin/env bash
# Launch the test Chrome with CDP + programmatic-extension-loading enabled,
# then inject the unpacked extension (Extensions.loadUnpacked replaces
# --load-extension, which branded Chrome >=137 ignores).
set -euo pipefail
cd "$(dirname "$0")/.."

/usr/bin/google-chrome \
  --user-data-dir="$PWD/.chrome-profile" \
  --remote-debugging-port=9222 \
  --enable-unsafe-extension-debugging \
  --no-first-run --no-default-browser-check \
  https://music.youtube.com &

for i in $(seq 1 20); do
  curl -s --max-time 1 http://localhost:9222/json/version >/dev/null && break
  sleep 0.5
done

node tools/load-extension.mjs
