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
`https://rpc.thruput.network` and a fixed 11,400² world, the largest the
contract accepts. Every deployment, reset,
and advance uses 1-billion root gas and 999-million target gas, so every
supported size fits the one-billion-gas transaction cap.
The contract enforces the fixed size.
Use the [required CLI](../README.md#requirements); set `THRUPUT_CLI` to select
its executable.

Deployment creates and funds one deployment account, then deploys and
initializes the world in one transaction. It verifies the committed
generation-zero metadata and writes the environment file. It does not advance
the world.

Flags override presets: `--rpc-url`, `--mode configurable|fixed`, `--size`,
`--seed`, `--output`, `--state-dir`, and `--runtime-manifest`.

```sh
npm run deploy -- --preset local --size 1000 \
  --state-dir .local/deployments/small --output .env.small
npm run dev -- --config .env.small
```

Use a separate state directory and output file for each deployment.
After interruption, repeat the same command with `--resume`. Resume observes
the saved transaction hash and never signs or submits that transaction again.
It reuses a hashless funding attempt's saved nonce and amount only when
explicitly requested. Keep the complete deployment directory.

## Configuration and state

Deployment writes public app settings to `.env.local` or `.env.futurenet`.
`dev` and `build` read `.env.local` unless `--config` selects another file.
The app receives only the `VITE_` settings in the selected file; inherited
values are ignored. `dev` starts the indexer and Vite. Run the local node
separately. Remote RPC URLs can use HTTP or HTTPS.

| State                                    | Location                                         |
| ---------------------------------------- | ------------------------------------------------ |
| Local ledger                             | `data/`                                          |
| Deployment key, journal, signed evidence | `.local/deployments/<preset>/`                   |
| Indexer tiles                            | `.local/indexer/<network>/<contract>/artifacts/` |
| Reports and benchmarks                   | `.tmp/`                                          |
| Public app settings                      | `.env.local`, `.env.futurenet`                   |

All these paths are Git-ignored. Deployment journals use `deployment.json`.
Move complete state directories only while their services are stopped.

| Service  | Default          | Override                                         |
| -------- | ---------------- | ------------------------------------------------ |
| Node RPC | `127.0.0.1:9545` | `thruput node --port` and deployment `--rpc-url` |
| Indexer  | `127.0.0.1:8787` | `GAME_OF_LIFE_INDEXER_URL` during deployment     |
| App      | `127.0.0.1:5173` | `GAME_OF_LIFE_APP_URL` during `dev`              |

The indexer URL must be an origin root. Set `GAME_OF_LIFE_ARTIFACT_ROOT` to
override indexer storage. See the
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

## Hosting

The hosted app has two services. Each image builds from the repository root.

```sh
docker build -f indexer/Dockerfile .
docker build -f web/Dockerfile --build-arg VITE_THRUPUT_RPC_URL=... .
```

Browsers connect to the RPC and the indexer directly, so the RPC must allow
cross-origin requests. A local node does not; use `npm run dev` for local nodes.

**Indexer.** Set `THRUPUT_RPC_URL`, `THRUPUT_NETWORK_ID`,
`THRUPUT_CONTRACT_ADDRESS`, and `GAME_OF_LIFE_CORS_ORIGINS` (the web origin).
`PORT` sets the HTTP port. Mount a persistent volume at `/data`: the indexer
keeps published snapshots there and serves the latest one at once after a
restart. For a health check, use `/v2/worlds/<network>/<contract>/status.json`.

**Web.** Pass each public setting from the deployment's environment file as a
build argument, with `VITE_GAME_OF_LIFE_INDEXER_URL` set to the indexer's public
HTTPS origin. The build validates every value. It writes a
Content-Security-Policy that allows connections to the RPC and the indexer only.
[Caddy](../web/Caddyfile) serves the files, adds the headers that a `<meta>`
policy cannot set, and caches built assets as immutable. `PORT` sets the HTTP
port.

## Verification

```sh
npm run format:check
npm run typecheck
npm test
npm run build -- --config tests/support/browser.env
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
# Creates an isolated ledger, deploys, resumes, runs the local integration
# checks, and restores .env.local on exit.
npm run test:clean-ledger
# Uses an existing deployment and running app.
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 npm run test:integration:local
GAME_OF_LIFE_APP_URL=http://127.0.0.1:5173 npm run test:browser:local
```

The local integration checks create and fund new test accounts from the local
faucet. They save keys, funding intent, and signed transactions under
`.local/deployments/<preset>/integration/`. They cover initialization and
resize policy, concurrent advances, a rejected under-gassed advance, a
full-size advance, and a reset of the deployed world. On the clean ledger, the
full-size advance must match the core generation-one reference vector. These
checks change the deployed world: they advance it and reset a configurable
world to 100 cells per side.

The live browser checks work with any world size. The resize check needs a
configurable world: it advances at 100, 1,000, 10,000, and 100 cells per side,
then restores the original size.
Set `GAME_OF_LIFE_BROWSER_EVIDENCE` to an ignored JSON path to save the
advance check's browser evidence.
SwiftShader timings are software-renderer results.

See [benchmarks](benchmarks.md) for workload measurements and reproduction commands.

UI components live in `web/src/components/ui`. To add components, use
`npx shadcn@4.16.1` from the root and review its changes.
