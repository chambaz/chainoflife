#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
exec 9>".env.local.lock"
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }
if [[ " $* " == *" --help "* ]]; then
  exec node_modules/.bin/tsx scripts/deploy.ts "$@"
fi
"${THRUPUT_CLI:-thruput}" build -p game-of-life
exec node_modules/.bin/tsx scripts/deploy.ts "$@"
