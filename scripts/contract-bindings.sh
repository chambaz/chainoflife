#!/usr/bin/env bash
# Generate the contract TypeScript bindings. With --check, fail if they are stale.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
bindings=web/src/contracts/generated/game-of-life.ts
thruput_cli="${THRUPUT_CLI:-thruput}"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

"$thruput_cli" build -p game-of-life
"$thruput_cli" codegen ts target/thruput/game_of_life.spec.xdr \
  -o "$temporary_dir/generated.ts"
node_modules/.bin/prettier --stdin-filepath "$bindings" \
  < "$temporary_dir/generated.ts" > "$temporary_dir/formatted.ts"

if [[ "${1:-}" == "--check" ]]; then
  if ! diff -u "$bindings" "$temporary_dir/formatted.ts"; then
    echo "Committed Chain of Life bindings are stale. Run npm run generate:contracts." >&2
    exit 1
  fi
else
  cp "$temporary_dir/formatted.ts" "$bindings"
fi
