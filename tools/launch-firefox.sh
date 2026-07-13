#!/usr/bin/env bash
# Launch a test Firefox with the extension temporarily installed via web-ext.
# The profile persists in .firefox-profile/ (gitignored) so logins survive
# restarts; web-ext reloads the extension automatically on file changes.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .firefox-profile
npx --yes web-ext run \
  --source-dir extension \
  --firefox-profile .firefox-profile \
  --profile-create-if-missing \
  --keep-profile-changes \
  --start-url https://music.youtube.com
