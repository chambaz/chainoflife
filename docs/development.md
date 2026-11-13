# Development

Run commands from the repository root. See the [README](../README.md) for
requirements and node startup.

## Deployment

```sh
npm run deploy -- --preset local
npm run deploy -- --preset futurenet
npm run dev -- --config .env.futurenet
npm run build -- --config .env.futurenet
```

Local defaults to a resizable 10,000² world. Futurenet uses
`https://rpc.thruput.network` and a fixed 2,900² world, with 950-million root gas
and 945-million target gas. The contract enforces the fixed size.
Use the [required CLI](../README.md#requirements); set `THRUPUT_CLI` to select
its executable. Deployment builds the contract and verifies three complete updates.

Flags override presets: `--rpc-url`, `--mode configurable|fixed`, `--size`,
`--seed`, `--output`, `--state-dir`, and `--runtime-manifest`.

```sh
npm run deploy -- --preset local --size 1000 \
  --state-dir .local/deployments/small --output .env.small
npm run dev -- --config .env.small
```

Use a separate state directory and output file for each deployment.
After interruption, repeat the same command with `--resume`. Resume observes
saved transaction hashes. It reuses a hashless funding attempt's saved nonce
and amount only when explicitly requested. Keep the complete deployment directory.

## Configuration and state

Deployment writes public app settings to `.env.local` or `.env.futurenet`.
`dev` and `build` read `.env.local` unless `--config` selects another file.
The app receives only the `VITE_` settings in the selected file; inherited
values are ignored. `dev` starts the indexer and Vite. Run the local node
separately. Remote RPC URLs can use HTTP or HTTPS.

| State | Location |
| --- | --- |
| Local ledger | `data/` |
| Deployment keys, journal, signed evidence | `.local/deployments/<preset>/` |
| Indexer database and tiles | `.local/indexer/<network>/<contract>/` |
| Reports and benchmarks | `.tmp/` |
| Public app settings | `.env.local`, `.env.futurenet` |

All these paths are Git-ignored. Deployment journals use `deployment.json`.
Move complete state directories only while their services are stopped.

| Service | Default | Override |
| --- | --- | --- |
| Node RPC | `127.0.0.1:9545` | `thruput node --port` and deployment `--rpc-url` |
| Indexer | `127.0.0.1:8787` | `GAME_OF_LIFE_INDEXER_URL` during deployment |
| App | `127.0.0.1:5173` | `GAME_OF_LIFE_APP_URL` during `dev` |

The indexer URL must be an origin root. Set `GAME_OF_LIFE_ARTIFACT_ROOT` and
`GAME_OF_LIFE_INDEXER_DB` to override indexer storage. See the
[indexer README](../indexer/README.md) for standalone operation.

Local deployment reads `data/runtime/runtime-manifest.json` for the public
faucet address and network ID. For another ledger path, pass `--runtime-manifest`
or set `THRUPUT_RUNTIME_MANIFEST`. `CHAIN_OF_LIFE_LOCAL_DIR` overrides deployment
state; it does not configure the node.

## Recovery

Restart the same node command and run `npm run dev` to continue an existing world.
Each browser origin keeps its visitor wallet across reloads and tabs. Changing
the app port creates a different origin and wallet. **Check funding** observes
the original funding attempt without requesting another grant.

For a fresh demo, use a separate clone, fresh ledger, and fresh browser profile.
Stop previous services or select different ports. Local ledgers can share a
network ID, so do not reuse old browser funding records with a fresh ledger.
Keep old deployment state for inspection if a saved transaction expired without
commitment. Resume does not replace it.

## Verification

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:chromium
npm run check:contracts
cargo fmt --all --check
cargo test --locked -p game-of-life-core -p game-of-life-indexer
cargo clippy --locked --workspace --all-targets --no-deps -- -D warnings
```

Chromium defaults to `/usr/bin/chromium`; override with `CHROMIUM_PATH`.
`test:chromium` serves the app with the fixture settings in
`tests/support/browser.env`. `generate:contracts` regenerates bindings;
`check:contracts` checks for drift.
After simulation, initialization, or digest changes, also run:

```sh
cargo test --locked -p game-of-life-core --release \
  full_scale_generation_one_vector -- --ignored
```

Live checks require the [required CLI](../README.md#requirements) and its runtime:

```sh
# Creates an isolated ledger and restores .env.local on exit.
npm run test:clean-ledger
# Uses an existing deployment and running app.
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 npm run test:integration:local
GAME_OF_LIFE_APP_URL=http://127.0.0.1:5173 npm run test:browser:local
```

The live browser checks work with any world size. The resize check needs a
configurable world: it advances at 100, 1,000, 10,000, and 100 cells per side,
then restores the original size.
Set `GAME_OF_LIFE_BROWSER_EVIDENCE` to an ignored JSON path to save the
advance check's browser evidence.
SwiftShader timings are software-renderer results.

The isolated renderer has its own checks: run `npm ci`, `npm run typecheck`,
`npm test`, `npm run build`, and `npm run test:chromium` in `tests/renderer`.
CI also guest-builds the storage-admission fixture. See
[benchmarks](benchmarks.md) for workload measurements and reproduction commands.

UI components live in `web/src/components/ui`. To add components, use
`npx shadcn@4.16.1` from the root and review its changes.
