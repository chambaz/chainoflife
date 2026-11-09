#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec 9>"$app_dir/.env.local.lock"
flock -n 9 || { echo "Another setup owns .env.local" >&2; exit 1; }
cd "$app_dir/../.."
"${THRUPUT_CLI:-thruput}" build -p game-of-life
cd "$app_dir"
exec node_modules/.bin/tsx scripts/setup-local.ts "$@"
