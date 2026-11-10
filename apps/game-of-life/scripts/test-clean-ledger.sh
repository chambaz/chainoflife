#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_dir"
exec 9>".env.local.lock"
flock -n 9 || { echo "Another setup owns .env.local" >&2; exit 1; }
[[ ! -L .env.local ]] || { echo "Refusing a symlinked environment file" >&2; exit 1; }
mkdir -p ../../tmp
export CHAIN_OF_LIFE_LOCAL_DIR="$(mktemp -d "$(cd ../../tmp && pwd)/acceptance.XXXXXX")"
export THRUPUT_RPC_URL="${THRUPUT_RPC_URL:-http://127.0.0.1:9548}"
node_pid=""
had_environment=0
if [[ -f .env.local ]]; then
  cp -p .env.local "$CHAIN_OF_LIFE_LOCAL_DIR/previous.env"
  had_environment=1
fi
cleanup() {
  if [[ -n "$node_pid" ]]; then
    kill -TERM "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
  fi
  if [[ "$had_environment" == 1 ]]; then
    cp -p "$CHAIN_OF_LIFE_LOCAL_DIR/previous.env" .env.local
  else
    rm -f .env.local
  fi
  echo "Acceptance evidence: $CHAIN_OF_LIFE_LOCAL_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${THRUPUT_CLI:-thruput}" build -p game-of-life
port="$(node -e 'const u = new URL(process.env.THRUPUT_RPC_URL); if (u.hostname !== "127.0.0.1" || u.protocol !== "http:" || !u.port) throw new Error("Use an explicit loopback HTTP port"); process.stdout.write(u.port)')"
export THRUPUT_RUNTIME_MANIFEST="$CHAIN_OF_LIFE_LOCAL_DIR/atomic-node/runtime/runtime-manifest.json"
"${THRUPUT_CLI:-thruput}" node --port "$port" \
  --data-dir "$CHAIN_OF_LIFE_LOCAL_DIR/atomic-node" \
  --network-config max_tx_gas=60000000000 \
  --block-driver interval --block-interval-ms 1000 \
  --non-interactive --no-ui >"$CHAIN_OF_LIFE_LOCAL_DIR/node.log" 2>&1 &
node_pid=$!
# Wait for RPC discovery, not a fixed startup delay.
node --input-type=module <<'JS'
const deadline = Date.now() + 120_000;
for (;;) {
  try {
    const response = await fetch(process.env.THRUPUT_RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersionInfo", params: {} }),
      signal: AbortSignal.timeout(2000),
    });
    if ((await response.json()).result?.wireFormat) break;
  } catch {}
  if (Date.now() >= deadline) throw new Error("Local node did not become ready");
  await new Promise(resolve => setTimeout(resolve, 250));
}
JS
node_modules/.bin/tsx scripts/setup-local.ts
node_modules/.bin/tsx scripts/setup-local.ts --resume
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 npm run test:integration:local -- --maxWorkers=1
