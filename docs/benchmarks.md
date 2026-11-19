# Grid-size benchmark

The benchmark measures the gas that `advance` uses at each world size. It
helps choose a world size and gas budget for networks with a per-transaction
gas cap, such as Futurenet's one-billion-gas cap.

## Futurenet preset

The Futurenet preset deploys a fixed **10,000 × 10,000** world (100 million
cells). Every deployment, reset, and advance has a **1-billion** root gas budget
and a **999-million** target gas budget, the full per-transaction cap.

## Results

Local runs on 2026-11-16 and the Futurenet run on 2026-11-17, with Thruput CLI 0.45.2, v6 artifact SHA-256
`0e7f8387771fcbfe5314651cef8b4f339f58be511676d7b3bb4fdaa6b7c1c286`, and the
preset budgets. Each world ran five advances.

### Local

Managed runtime hog-devnode 0.1.34 with its default one-billion-gas cap, seeds
0, 1, and 42:

| Grid            |        Advances |    Root gas per advance | Below 1-billion cap | Deploy and initialize |
| --------------- | --------------: | ----------------------: | ------------------: | --------------------: |
| 8,000 × 8,000   | 15/15 succeeded | 198,375,908–198,375,912 |               80.2% |            70,356,196 |
| 10,000 × 10,000 | 15/15 succeeded | 309,622,320–309,622,324 |               69.0% |           110,162,970 |

Gas is deterministic for the same artifact, runtime, and world size; it
varied by 4 gas between the two storage banks and not at all across seeds.
Both sizes use 3.1 gas per cell. Operation-to-receipt time for one advance
was 0.8–1.3 seconds at both sizes.

### Larger worlds

Local runs on 2026-11-19 with Thruput CLI 0.45.2, v6 artifact SHA-256
`f32ac135fb776564a5c24aecda19849049f813cf13b909137f446be097bf6d76`, the preset budgets, and seed 0.
Each world ran two or four advances.

| Grid            | Node output limit |    Root gas per advance | Of 1-billion cap | Deploy and initialize | Advance to receipt |
| --------------- | ----------------- | ----------------------: | ---------------: | --------------------: | -----------------: |
| 11,300 × 11,300 | 16 MiB (default)  | 395,020,329–395,020,331 |            39.5% |           141,308,620 |          1.5–1.8 s |
| 11,400 × 11,400 | 16 MiB (default)  | 402,530,313–402,530,318 |            40.3% |           143,984,280 |          1.5–1.8 s |
| 11,500 × 11,500 | 16 MiB (default)  |                       — |                — |   dropped, no receipt |                  — |
| 17,300 × 17,300 | 64 MiB            | 932,418,634–932,418,636 |            93.2% |           336,220,450 |          2.6–3.1 s |

The default rows used the managed hog-devnode 0.1.34. Its executor limits one
transaction's storage output to 16 MiB, so 11,400 cells per side (16.2 MB per
bank) is the largest world it accepts. A larger transaction is dropped like a
conflict: it gets no receipt and expires. The 17,300 row used hog-devnode
0.1.34 built with that limit raised to 64 MiB, standing in for a network whose
`max_subtransaction_output_bytes` allows a 37.4 MB write. Its generation-zero
and generation-one digests matched the core reference vectors.

On the same machine, the indexer verified and published each 17,300²
generation in 5.4–5.9 seconds: 3.0–3.4 s to download from the local RPC,
1.7 s to build 6,190 tiles (143 MB), and 0.7–0.8 s to publish them. The live
advance test in Chromium with SwiftShader showed the new generation 9.5 seconds
after the click. These are four-core sandbox timings with one-second blocks.

### Futurenet

The 10,000 × 10,000 world deployed with 110,162,970 gas, the same as the local
run, and its first advance produced the reference generation-one digest
`1ea48941caa8c1614bbb00c80ed6903855c174778d45725522439cc875ccde71`.

The hosted explorer, checked with the live advance test in Chromium with
SwiftShader, showed first content in 1.1 seconds and the first ready world in
6.8 seconds. The advanced generation became visible 56 seconds after the click.
Most of that time is indexing: the hosted indexer took 18 seconds to download
the world from the public RPC and 23 seconds to publish 84 MB of tiles.

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
