#!/usr/bin/env bash
# Development only: prints the current 6-digit sign-in code for a test staff account and copies it to the clipboard when it can.
# Usage: bash server/staff-code.sh [a1|a2|a3|p1]      (default a1; needs /tmp/live.env from live-dev.sh up)
set -eu
cd "$(dirname "$0")/.."
[ -f /tmp/live.env ] || { echo "Run 'bash server/live-dev.sh up' first." >&2; exit 1; }
. /tmp/live.env
who=$(echo "${1:-a1}" | tr a-z A-Z); var="${who}_SECRET"; secret="${!var:-}"
[ -n "$secret" ] || { echo "No secret for '${1:-a1}'. Use a1, a2, a3 or p1." >&2; exit 1; }
code=$(node server/tools.mjs code "$secret")
if command -v clip >/dev/null 2>&1; then printf %s "$code" | clip; note=" (copied)"; elif command -v pbcopy >/dev/null 2>&1; then printf %s "$code" | pbcopy; note=" (copied)"; elif command -v xclip >/dev/null 2>&1; then printf %s "$code" | xclip -selection clipboard; note=" (copied)"; else note=""; fi
echo "${1:-a1} code: $code$note   Use it within 30 seconds."
