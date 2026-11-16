# Grid-size benchmark

The benchmark measures the gas that `advance` uses at each world size. It
helps choose a world size and gas budget for networks with a per-transaction
gas cap, such as Futurenet's one-billion-gas cap.

## Futurenet preset

The Futurenet preset deploys a fixed **2,900 × 2,900** world (8.41 million
cells). Each advance has a **950-million** root gas budget and a
**945-million** target gas budget.

## Results

Runs on 2026-11-16 with Thruput CLI 0.45.2, v6 artifact SHA-256
`ca0528b08791027bd045322912c6962bfe38c38830a5c3a71cd7e55c6dc242dd`, and the
preset budgets. Each world ran five advances.

### Local

Managed runtime hog-devnode 0.1.34, seeds 0, 1, and 42:

| Grid          |        Advances | Peak root gas | Below 1-billion cap | Deploy and initialize |
| ------------- | --------------: | ------------: | ------------------: | --------------------: |
| 2,900 × 2,900 | 15/15 succeeded |   881,126,123 |               11.9% |           153,301,620 |
| 3,000 × 3,000 | 15/15 succeeded |   934,038,953 |                6.6% |           159,783,415 |

Size 2,900 is the largest tested size with at least 10% headroom below the cap.
Operation-to-receipt time for one advance was 2.3–3.7 seconds.

### Futurenet

Seed 0 at 2,900 × 2,900: 5/5 advances succeeded, with the same peak root gas
as the local run (881,126,123). Operation-to-receipt time for one advance was
2.2–2.9 seconds, and 1.8 seconds for deploy and initialize.

The hosted explorer, checked with the live advance test in Chromium with
SwiftShader, showed first content in 0.6 seconds and the first ready world in
3.4 seconds. The advanced generation became visible 9.0 seconds after the
click. That time includes the transaction, indexing, and loading the new
tiles.

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
  --sizes 2900,3000 --seeds 0,1,42 --generations 5 --gas-limit 950000000
```

For a local check, start a compatible node with its default one-billion-gas
cap. Pass `--rpc-url` and `--runtime-manifest` to the benchmark. To find the
size limit, add larger sizes and set a target budget close to the cap, for
example `--sizes 3100 --seeds 0 --generations 2 --gas-limit 1000000000
--target-gas-limit 999000000`.

Run `npm run benchmark:world -- --help` for all options.
