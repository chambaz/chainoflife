# Grid-size benchmark

The benchmark measures the gas that `advance` uses at each world size. It
helps choose a world size and gas budget for networks with a per-transaction
gas cap, such as Futurenet's one-billion-gas cap.

## Futurenet preset

The Futurenet preset deploys a fixed **10,000 × 10,000** world (100 million
cells). Every deployment, reset, and advance has a **1-billion** root gas budget
and a **999-million** target gas budget, the full per-transaction cap.

## Results

Runs on 2026-11-16 with Thruput CLI 0.45.2, v6 artifact SHA-256
`166bbea3e2a7930095804433803080eacb3cca26aed2ab630fdb2181698248a9`, and the
preset budgets. Each world ran five advances.

### Local

Managed runtime hog-devnode 0.1.34 with its default one-billion-gas cap, seeds
0, 1, and 42:

| Grid            |        Advances |    Root gas per advance | Below 1-billion cap | Deploy and initialize |
| --------------- | --------------: | ----------------------: | ------------------: | --------------------: |
| 8,000 × 8,000   | 15/15 succeeded | 198,351,908–198,351,912 |               80.2% |           274,868,195 |
| 10,000 × 10,000 | 15/15 succeeded | 309,592,320–309,592,324 |               69.0% |           430,092,969 |

Gas is deterministic for the same artifact, runtime, and world size; it
varied by 4 gas between the two storage banks and not at all across seeds.
Both sizes use 3.1 gas per cell. Operation-to-receipt time for one advance
was 0.8–1.0 seconds at 8,000² and 0.8–1.3 seconds at 10,000².

### Futurenet

These results predate the 4,096-byte storage chunks and the `v2` digest, and
need a new deployment to refresh. The 10,000 × 10,000 world deployed with
442,547,966 gas, and its first advance produced the `v1` reference
generation-one digest
`fb612ac3026ff7604b96f66c8ce76131f144482928e53198cb32b3c3cb642b96`.

The hosted explorer, checked with the live advance test in Chromium with
SwiftShader, showed first content in 0.5 seconds and the first ready world in
3.4 seconds. The advanced generation became visible 46 seconds after the click.
Most of that time is indexing: the hosted indexer took 17 seconds to download
the world from the public RPC and 19 seconds to publish 84 MB of tiles.

## Method

For each size and seed, the benchmark:

1. Creates a new account and funds it. On a local node it uses the faucet from
   the runtime manifest. On a public network it requests an airdrop.
2. Deploys the contract and initializes a fixed world in one transaction.
3. Checks the generation-zero metadata.
4. Runs the requested number of generations. Each generation is one `advance`
   transaction. Use at least two generations so that both storage banks are
   read and written.
5. Checks that each `GenerationAdvanced` event and the committed metadata have
   the expected generation and digest.

It records the root gas, the outcome, and the operation-to-receipt time of each
transaction. Operation-to-receipt time includes signing, evidence writes, RPC
latency, scheduling, execution, and receipt polling. It is not executor
duration. To confirm an executor-time target, use node-side telemetry.

The benchmark uses the same deployment, funding, and `advance` code as
`npm run deploy` (`scripts/world.ts`).

## Evidence and retries

Each run writes a new directory under the ignored `.tmp/benchmarks/` directory.
It contains the network configuration, artifact hash, account keys, funding
intent, signed transactions, receipts, and results. The keys are private: do
not publish these directories.

Funding intent and signed transactions are saved before broadcast. A run never
retries or submits a transaction again. If a transaction fails, the run stops
that world and continues with the next one. If a result is uncertain, inspect
the saved hashes before you start another run.

## Reproduce

Build with a [compatible CLI](../README.md#requirements). The target runtime
must accept the artifact format; set `THRUPUT_CLI` to select the CLI.

From the repository root:

```sh
"${THRUPUT_CLI:-thruput}" build -p game-of-life
npm run benchmark:world -- --rpc-url https://rpc.thruput.network \
  --sizes 8000,10000 --seeds 0,1,42 --generations 5
```

The defaults are the preset budgets: 1-billion root gas and 999-million target
gas. For a local check, start a compatible node with its default
one-billion-gas cap, and pass `--rpc-url` and `--runtime-manifest`.

Run `npm run benchmark:world -- --help` for all options.
