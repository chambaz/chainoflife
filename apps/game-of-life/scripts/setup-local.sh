#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec 9>"$app_dir/.env.local.lock"
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }
if [[ " $* " == *" --help "* ]]; then
  cd "$app_dir"
  exec node_modules/.bin/tsx scripts/index.ts "$@"
fi
cd "$app_dir/../.."
"${THRUPUT_CLI:-thruput}" build -p game-of-life
cd "$app_dir"
exec node_modules/.bin/tsx scripts/index.ts "$@"
