#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:-thruput}"
spec="$repo_root/target/thruput/game_of_life.spec.xdr"

(
  cd "$repo_root"
  "$thruput_cli" build -p game-of-life
  "$thruput_cli" codegen ts "$spec" \
    -o apps/game-of-life/src/contracts/generated/game-of-life.ts
  "$app_dir/node_modules/.bin/prettier" --write apps/game-of-life/src/contracts/generated/game-of-life.ts
)
