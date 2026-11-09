#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:-thruput}"
spec="$repo_root/target/thruput/game_of_life.spec.xdr"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
generated="$temporary_dir/game-of-life.ts"

(
  cd "$repo_root"
  "$thruput_cli" build -p game-of-life
  "$thruput_cli" codegen ts "$spec" -o "$generated"
)
(
  cd "$app_dir"
  npx prettier --write "$generated" >/dev/null
)

if ! diff -u "$app_dir/src/contracts/generated/game-of-life.ts" "$generated"; then
  printf 'Committed Chain of Life bindings are stale. Run npm run generate:contracts.\n' >&2
  exit 1
fi
