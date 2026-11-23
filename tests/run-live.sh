#!/usr/bin/env bash
# Real-browser test of the live voter flow. Needs local Postgres. Set PLAYWRIGHT_CHROMIUM_PATH if Playwright's own browser is unavailable.
cd "$(dirname "$0")/.."; set -e
bash server/live-dev.sh up; set -a; . /tmp/live.env; set +a
VITE_ELECTION_ID=$ELECTION_ID npx vite build --outDir dist-live --emptyOutDir >/dev/null
node node_modules/vite/bin/vite.js preview --outDir dist-live --port 4174 --strictPort >/tmp/live-web.log 2>&1 & W=$!
trap 'kill $W 2>/dev/null; bash server/live-dev.sh down' EXIT; sleep 2
LIVE_DB=evlive npx playwright test -c playwright.live.config.ts "$@"
