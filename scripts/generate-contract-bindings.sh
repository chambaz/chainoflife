#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$app_dir"
thruput_cli="${THRUPUT_CLI:-thruput}"
spec="$repo_root/target/thruput/game_of_life.spec.xdr"

(
  cd "$repo_root"
  "$thruput_cli" build -p game-of-life
  "$thruput_cli" codegen ts "$spec" \
    -o web/src/contracts/generated/game-of-life.ts
  "$app_dir/node_modules/.bin/prettier" --write web/src/contracts/generated/game-of-life.ts
)
