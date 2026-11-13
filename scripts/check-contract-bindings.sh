#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$app_dir"
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
  node_modules/.bin/prettier --stdin-filepath web/src/contracts/generated/game-of-life.ts \
    < "$generated" > "$temporary_dir/formatted.ts"
)

if ! diff -u "$app_dir/web/src/contracts/generated/game-of-life.ts" "$temporary_dir/formatted.ts"; then
  printf 'Committed Chain of Life bindings are stale. Run npm run generate:contracts.\n' >&2
  exit 1
fi
