# Grid-size benchmark

The benchmark measures the gas that `advance` uses at each world size. It
helps choose a world size and gas budget for networks with a per-transaction
gas cap, such as Futurenet's one-billion-gas cap.

## Futurenet preset

The Futurenet preset deploys a fixed **11,400 × 11,400** world (130 million
cells), the largest that fits a transaction's 16 MiB storage output limit.
Every deployment, reset, and advance has a **1-billion** root gas budget and a
**999-million** target gas budget, the full per-transaction cap.

## Results

Runs on 2026-11-26 with Thruput CLI 0.48.0, v7 artifact SHA-256
`a5b608353bbd0e04b95cabbdcfb0af22f4fb4a292506ed5fe317c1b32b60ecb6`, the preset
budgets, and seed 0.

| Network   | Grid            |      Advances |    Root gas per advance | Of 1-billion cap | Deploy and initialize | Advance to receipt |
| --------- | --------------- | ------------: | ----------------------: | ---------------: | --------------------: | -----------------: |
| Local     | 10,000 × 10,000 | 2/2 succeeded | 309,021,479–309,021,483 |            30.9% |           109,818,733 |          2.1–2.4 s |
| Local     | 11,400 × 11,400 | 2/2 succeeded | 401,762,492–401,762,496 |            40.2% |           143,475,598 |              2.3 s |
| Futurenet | 11,400 × 11,400 | 5/5 succeeded | 401,762,492–401,762,496 |            40.2% |           143,475,598 |          2.0–2.6 s |

The local runs used the managed hog-devnode 0.1.37 with one-second blocks. Gas
is deterministic for the same artifact, runtime, and world size; it varies by
4 gas between the two storage banks.

### The size limit

Gas does not limit the world size; storage output does. Each advance rewrites
the whole world, and a node limits one transaction's storage output to 16 MiB.
An 11,400 × 11,400 world writes 16,245,000 bytes per advance and fits.
An 11,500 × 11,500 world writes 16,537,000 bytes and does not: on a local node
and on Futurenet, its transaction is dropped like a conflict, with status
`retry` and no receipt. With the limit raised to 64 MiB, a 17,400 × 17,400
advance used 943 million gas.

### Indexing and display

The indexer publishes 2,748 tiles (64.9 MB) for each 11,400 × 11,400
generation, with a peak of about 200 MB of memory. On a local node it verified
and published a generation in 1.8 seconds. Against Futurenet, from a
residential connection, it took 5.7–9.2 seconds, most of it downloading the
world from the public RPC (4.7–8.0 s).

The live advance test in Chromium with SwiftShader, with the app and indexer
running locally against the Futurenet world, showed the first ready world in
1.9 seconds and the advanced generation 9.0 seconds after the click.

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
