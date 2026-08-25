#!/usr/bin/env bash
# Capture live feed bytes as test fixtures. Run by hand when the fixtures need
# refreshing -- NOT part of bin/test, which must never touch the network.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p tests/fixtures
BASE="https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds"
for feed in gtfs gtfs-l; do
  curl -fsS --max-time 30 -o "tests/fixtures/$feed.pb" "$BASE/nyct%2F$feed"
  echo "  captured tests/fixtures/$feed.pb ($(stat -c%s "tests/fixtures/$feed.pb") bytes)"
done
curl -fsS --max-time 30 -o tests/fixtures/alerts.pb "$BASE/camsys%2Fsubway-alerts"
echo "  captured tests/fixtures/alerts.pb ($(stat -c%s tests/fixtures/alerts.pb) bytes)"
