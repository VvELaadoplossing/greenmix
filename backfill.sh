#!/usr/bin/env bash
# Backfill greenmix history month-by-month via the worker's /api/refresh route.
#
# Usage:
#   ./backfill.sh BASE_URL TOKEN START [END]
#
# Example (realized from the start of 2024 to today):
#   ./backfill.sh https://greenmix.dry-violet-bcdc.workers.dev MYTOKEN 2024-01-01
#
# Defaults to source=realized (the series worth backfilling — forecast history
# is recalculated by Ned and not a true day-ahead record). Override with:
#   SOURCE=forecast ./backfill.sh ...
#
# One month per call keeps each request well under the fetch cap and Ned's
# 200-requests/5-min limit. Works with GNU date (Linux/Codespaces) and BSD date
# (macOS). Dates are YYYY-MM-DD, interpreted as UTC by the worker.
set -euo pipefail

BASE="${1:?usage: backfill.sh BASE_URL TOKEN START [END]}"
TOKEN="${2:?missing TOKEN}"
START="${3:?missing START date YYYY-MM-DD}"
END="${4:-$(date -u +%F)}"
SOURCE="${SOURCE:-realized}"

# add one month to a YYYY-MM-DD date, GNU first then BSD fallback
add_month() {
  date -u -d "$1 +1 month" +%F 2>/dev/null \
    || date -u -j -v+1m -f %Y-%m-%d "$1" +%F
}

echo "Backfilling source=$SOURCE from $START to $END (monthly chunks)"
cur="$START"
while [ "$cur" \< "$END" ]; do
  next="$(add_month "$cur")"
  [ "$next" \> "$END" ] && next="$END"
  printf '  %s -> %s ... ' "$cur" "$next"
  resp="$(curl -fsS "$BASE/api/refresh?token=$TOKEN&source=$SOURCE&from=$cur&to=$next" || echo '{"error":"request failed"}')"
  echo "$resp" | grep -o '"written":[0-9]*' | head -1 || echo "$resp"
  cur="$next"
  sleep 3   # be polite to Ned's rate limit
done
echo "done."
