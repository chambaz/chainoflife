# Chain of Life explorer

The React app displays verified world snapshots, submits tick requests, and
resets configurable worlds through a 100–10,000-cell-per-side header slider.
Fixed worlds expose Advance without a size control.
See the [root README](../../README.md) for installation and local startup.

Dragging previews the boundary. Releasing the slider, or releasing an adjustment
key, submits one reset. A reset keeps the seed, increments the epoch, and starts
generation zero. Pending requests must finish first. Signed resets are saved
before broadcast. The app automatically checks uncertain results using the
original transaction hash. Advance stays disabled until the reset is visible.

The Activity panel lists generation and reset transactions. Each shortened hash
has a button to copy its full value. Advances are processed automatically.

## Commands

Run these from this directory:

```sh
npm run typecheck
npm test
npm run build
npm run test:chromium
npm run check:contracts
```

Browser tests require Chromium at `/usr/bin/chromium`, or `CHROMIUM_PATH`.
`generate:contracts` builds the contract and regenerates bindings with
`THRUPUT_CLI` (default: `thruput`). `check:contracts` checks for binding drift.

Live checks:

```sh
# Isolated accounts and ledger; restores the previous .env.local on exit.
npm run test:clean-ledger

# Existing local deployment and running app.
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 npm run test:integration:local
GAME_OF_LIFE_APP_URL=http://127.0.0.1:5173 npm run test:browser:local
```

The live resize test changes the board through 100, 1,000, and 10,000 cells per
side and returns to 100. It saves timings in `test-results/live/resize-measurements.json`.
To preserve an older deployment journal when deploying this format, set
`GAME_OF_LIFE_DEPLOYMENT_JOURNAL=deployment-v2.json` for `setup:local`.
Development scopes storage by network and contract under `tmp/game-of-life-indexer-v2`.

Set `GAME_OF_LIFE_BROWSER_EVIDENCE` to an ignored JSON path to save browser
measurements. Browser tests use SwiftShader; timings are not hardware-GPU results.

## Deployment

One script, `scripts/index.ts`, deploys to local nodes and Futurenet:

```sh
npm run deploy -- --preset local
npm run deploy -- --preset futurenet
npm run dev -- --config .env.futurenet
npm run build -- --config .env.futurenet
```

`setup:local` is a shortcut for the local default. The local preset starts a
resizable 10,000² world; Futurenet starts a fixed 2,900² world. `devnet` aliases
`futurenet`. Use CLI 0.43.0 for the current Futurenet runtime, selected with
`THRUPUT_CLI=/path/to/thruput`. The deploy command builds before submission.

Flags override presets: `--rpc-url`, `--mode configurable|fixed`, `--size`,
`--seed`, `--output`, `--state-dir`, and `--runtime-manifest`. For example:

```sh
npm run deploy -- --preset local --size 1000 \
  --state-dir ../../tmp/small-world --output .env.small
npm run dev -- --config .env.small
```

Local output defaults to `.env.local`; Futurenet output defaults to
`.env.futurenet`. Selecting a file isolates its public app settings from other
environment files and inherited `VITE_` values. `dev` defaults to `.env.local`.
It starts a local indexer and app; the RPC can be remote HTTP(S).

Deployment verifies three full-world updates. Evidence and private keys stay in
`tmp/chain-of-life` or `tmp/chain-of-life-futurenet`. Use a separate `--state-dir`
and `--output` for each additional deployment. After interruption, repeat the
same command with `--resume`. Saved transactions are observed by their original
hash. A hashless funding attempt reuses its saved nonce only on explicit resume.
Fixed size is enforced on-chain and cannot be changed by editing app settings.

This contract adds a metadata field. Deploy a new world rather than reusing an
older contract or deployment journal. The world digest format stays at v2.

## Configuration

Setup writes these public values to `.env.local`:

```text
VITE_THRUPUT_RPC_URL=http://127.0.0.1:9545
VITE_THRUPUT_NETWORK_ID=<64 lowercase hex characters>
VITE_GAME_OF_LIFE_CONTRACT_ADDRESS=<0x-prefixed 32-byte hex address>
VITE_GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787
```

The indexer URL must be an origin root. `dev` builds and supervises the indexer
and Vite; the node runs separately. Indexer data defaults to
`tmp/game-of-life-indexer-v2/<network>/<contract>`. Override with `GAME_OF_LIFE_ARTIFACT_ROOT` and
`GAME_OF_LIFE_INDEXER_DB`. The app uses same-origin `/thruput-rpc` and
`/thruput-indexer` proxies.

Each browser creates a random wallet, saves it in local storage, and requests
funding once for ten times the transaction budget plus a small storage reserve.
Local setup supplies the public faucet address, and the browser uses the
official `dev_fundAccount` RPC. Networks without this local setting use one
standard airdrop. Reloads and tabs share that wallet. Deployment keys are never sent
to the browser. Funding failures keep the wallet and pending funding evidence;
**Check funding** observes the original attempt without requesting another.

The local development and preview proxies allow reads, signed transaction
submission, and faucet requests. A hosted deployment needs equivalent RPC
routing and a faucet-enabled network.

## Data boundaries

The chain owns canonical state. The indexer verifies a complete download's
population and digest before publishing immutable tiles. Tiles do not carry
independent proofs. The browser keeps the previous verified generation visible
until the next viewport has complete render coverage.

Transaction records distinguish submission, queue admission, and execution.
Signed evidence is saved before broadcast. Uncertain transactions are observed
by their original hash and never resubmitted automatically. Request and crank
histories are scoped to network, caller, and contract.

## Ports and local state

| Service | Default | Override |
| --- | --- | --- |
| Node RPC | `127.0.0.1:9545` (Thruput default) | `thruput node --port` and matching `THRUPUT_RPC_URL` for setup |
| Indexer | `127.0.0.1:8787` | `GAME_OF_LIFE_INDEXER_URL` during setup |
| App | `127.0.0.1:5173` | `GAME_OF_LIFE_APP_URL` when running `dev` |

Keep the local services on loopback. Setup writes public connection settings to
the selected environment file. Changing the app port changes the browser
origin, so it creates a separate visitor wallet.

Setup creates three local accounts and funds them through `dev_fundAccount`,
the same local faucet API used by browser wallets. The amount covers contract
storage and the larger gas reservation. It saves the funding nonce and amount
before the request, then saves the returned hash and signed bytes. Explicit
`setup:local -- --resume` reuses a hashless request's nonce and amount; once a hash
is known, it only observes that transaction. The journal also saves the deployment
nonce, so setup can resume during funding without changing the contract address.

Deployment keys and the journal live under `tmp/chain-of-life` at the repository
root. `CHAIN_OF_LIFE_LOCAL_DIR` changes that setup directory. It does not start
or configure a node. The node's ledger location is selected by `thruput node
--data-dir`.

Setup reads the node's runtime manifest to find its public faucet address and
check the network ID. By default it reads
`data/runtime/runtime-manifest.json` at the repository root. Set
`THRUPUT_RUNTIME_MANIFEST` to an absolute path when using another node directory
instead of `data/`. Faucet signing keys stay in the node; setup sends
funding requests over RPC. Indexer state is separate, as documented above.

### Start a separate fresh demo

The simplest option is a separate clone outside this repository, with fresh
dependencies and local data. Stop the previous services or choose different
ports using the table above. Use a fresh browser profile or clear site data for
the demo origin. Local nodes can reuse the same network ID, so old browser
funding records must not be reused for a new ledger.

Do not copy `.env.local`, deployment journals, keys, indexer databases, or tiles
from the previous run. Keep the old clone if you want to resume its world later.
Cloning inside another Cargo workspace can merge parent Cargo configuration;
use a separate directory instead.

### Setup still times out with `--resume`

Resume observes saved transaction hashes. It does not replace a transaction that
expired without committing. For this disposable local experiment, start a fresh
demo as described above rather than deleting individual journal entries and
guessing which steps ran. Keep the old ledger and journal if you need to inspect
the original transaction.

### Grid-size benchmarks

See the [Futurenet benchmark results](../../docs/futurenet-benchmark.md) for the
recommended size, measured gas, and runtime compatibility.

`npm run benchmark:world` deploys fresh worlds and measures initialization and
whole-world ticks. It records outer-wallet gas and operation-to-receipt time;
the latter includes network, scheduling, and polling delays, not just execution.

Build the contract with a CLI compatible with the target runtime, then run:

```sh
npm run generate:contracts
npm run benchmark:world -- --rpc-url https://rpc.thruput.network \
  --sizes 2900,3000 --seeds 0,1,42 --generations 5 --gas-limit 950000000
```

For a local node, supply `--rpc-url` and `--runtime-manifest` pointing to its
runtime manifest. Use the default one-billion-gas node cap for this benchmark.
The benchmark never changes `.env.local` or the existing demo deployment.

Each run writes to an ignored directory under `.tmp/benchmarks` at the repository
root. It contains private account keys, funding intent, pre-broadcast signed
evidence, receipts, and `results.json`. Runs stop on uncertain submissions and
never retry automatically. Inspect the saved transaction hash before another run.
Failed executions are recorded; other sizes use separate accounts and contracts.

### UI components

The shadcn components are checked-in source under `src/components/ui`. The CLI
is not needed to install, build, or run the app. If adding components, invoke the
CLI explicitly with `npx shadcn@4.16.1`; review the generated diff before keeping it.
