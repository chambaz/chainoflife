# Chain of Life explorer

The React app displays verified world snapshots and submits tick requests.
See the [root README](../../README.md) for installation and local startup.

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

Set `GAME_OF_LIFE_BROWSER_EVIDENCE` to an ignored JSON path to save browser
measurements. Browser tests use SwiftShader; timings are not hardware-GPU results.

## Configuration

Setup writes these public values to `.env.local`:

```text
VITE_THRUPUT_RPC_URL=http://127.0.0.1:9547
VITE_THRUPUT_NETWORK_ID=<64 lowercase hex characters>
VITE_GAME_OF_LIFE_CONTRACT_ADDRESS=<0x-prefixed 32-byte hex address>
VITE_GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787
```

The indexer URL must be an origin root. `dev` builds and supervises the indexer
and Vite; the node runs separately. Indexer data defaults to
`tmp/game-of-life-indexer`. Override with `GAME_OF_LIFE_ARTIFACT_ROOT` and
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
