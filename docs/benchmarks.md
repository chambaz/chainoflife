# Futurenet grid-size benchmark

## Recommendation

Use **2,900 × 2,900 cells (8.41 million cells)** for the hosted preset.
The largest observed update used **879,632,458 gas**, leaving **12.0%** of
Futurenet's one-billion-gas cap unused. A root budget of 950 million gas and an
inner crank budget of 945 million passed every tested update.

This is a gas-based recommendation for the tested workloads, not a guarantee
for every future generation. The **1.75–1.8-second executor-time target is not
verified**. The public RPC reports gas and commitment, but not executor duration.

## Results

Measurements started on 2026-11-13 UTC. Each size used seeds 0, 1, and 42, with
five generations per seed. Each generation used separate request and crank
transactions through the same wallet wrapper as the app. Both storage banks
were exercised, including the first writes to the second bank.

| Grid | Cells | Futurenet updates | Peak root gas | Headroom below network cap |
| --- | ---: | ---: | ---: | ---: |
| 2,900 × 2,900 | 8,410,000 | 15/15 passed | 879,632,458 | 12.0% |
| 3,000 × 3,000 | 9,000,000 | 15/15 passed | 932,493,688 | 6.8% |

Initialization used 151,863,489 gas at size 2,900 and 158,304,620 at size 3,000.
Tick requests used 81,130 gas. Local runs with the matching runtime produced
identical gas figures for all tested seeds and generations.

Size 3,100 aborted on the first crank for all three seeds locally with a
995-million inner budget. A boundary check with a 999-million inner budget also
aborted, consuming 999,000,150 root gas. These were local boundary checks,
not Futurenet submissions. Size 3,000 is the largest successful size tested;
2,900 is the largest tested size with at least 10% gas headroom.

## Timing

For size 2,900, crank operation-to-receipt time ranged from **1.94 to 4.55 seconds**,
with a **2.48-second median**. This includes preparation, signing, evidence writes,
RPC latency, scheduling, execution, and receipt polling. It excludes the preceding
request transaction and the later indexer/rendering work.

Size 3,000 had wider confirmation-time variation, including a 21.82-second sample.
The much smaller request transactions also slowed during that run. The sizes
were tested sequentially, so their confirmation times are not a controlled
comparison of executor performance. One crank committed during a client restart;
its original hash was recovered and its missing duration was excluded.

A two-second block interval does not establish a two-second transaction latency.
Confirm the executor-time target with node-side telemetry before making a timing
claim. Local host timings alone cannot establish Futurenet executor performance.

## Reproduce

The target reported wire format 14.1.1 and runtime release 0.1.31. The successful
artifact was built with Thruput CLI 0.43.0. CLI 0.44.0 produced a newer artifact
format that the matching local runtime rejected with `ContractRejectUnsupportedFormat`.
Use `THRUPUT_CLI` to select a compatible installed CLI when building.

From the repository root:

```sh
THRUPUT_CLI=/path/to/compatible/thruput npm run generate:contracts
npm run benchmark:world -- --rpc-url https://rpc.thruput.network \
  --sizes 2900,3000 --seeds 0,1,42 --generations 5 --gas-limit 950000000
```

For local checks, start a compatible node with its default one-billion-gas cap
and pass `--rpc-url` and `--runtime-manifest` to the benchmark. The boundary check
uses `--sizes 3100 --seeds 0 --generations 2 --gas-limit 1000000000
--target-gas-limit 999000000`.

The benchmark saves the network configuration, artifact hash, funding intent,
signed evidence, receipts, and results under ignored `.tmp/benchmarks/` directories.
Those directories also contain private keys and must not be published.

## Public evidence

- RPC: `https://rpc.thruput.network`
- Network: `DFizVugYrvktaiKivvCx2P1ApArLuyYmH6vN3HN7FcNT`
- Artifact SHA-256: `967c6373aee0d91a275d5ddee5d39c4ef5a0b8fd72d7bdc3141fa7da22de49c6`
- Size 2,900, seed 0 contract: `65DGqmV1n89QmWKfPdNyaqhQXC8kA84YEHJZmL8cTG5d`
- Size 2,900 peak-gas transaction: `FFgNmuJZzWTewCko3gcR1gUfuNcHomMf8jhk5YwwUban`
- Size 3,000 peak-gas transaction: `AyAMntL8UfBR1KKnVFeUFrNDfXtzWPVFUyMNe5fgtJc9`

These benchmark deployments remain resizable. The fixed-mode deployment below
uses the new metadata format.

## Fixed-mode deployment check

The final fixed 2,900² contract was deployed to Futurenet with seed zero.
All three deployment checks passed: **878,886,415**, **879,632,544**, and
**879,452,084** root gas. The peak still leaves approximately **12% headroom**
below the network cap. This confirms the final artifact for these generations;
the earlier three-seed benchmark used the artifact listed above.

- Contract: `39mnVDrG3bGDa34URkck4W48Es6Kz2cGydXxKCBakmwe`
- Artifact SHA-256: `b29d6f6442933ac59d9ddc317a56f2a0a872458ab37f0e62fe8a779ac853cb37`
- Peak-gas transaction: `6GQgZ3KtvGHcFG27bd6QZzXuWj6nrVXsmGC1yaVDq9CX`

The fixed and configurable policies both passed fresh-ledger checks. Fixed
worlds reject resize without changing metadata; configurable worlds can reset.
Explicit resume observed the original transactions on both local and public
deployments. A live Chromium check loaded the selected Futurenet configuration,
funded a visitor wallet, advanced generation 3 to 4, verified indexed rendering,
and retained generation 4 after reload. The fixed world had no size control.

## Verification

Formatting, typecheck, 226 app unit tests, 30 Chromium tests, both app builds, and
generated-binding checks passed. Rust formatting, 60 core/indexer tests, workspace
Clippy, and the release-mode full-scale reference test passed. Fresh-ledger
acceptance passed fixed/configurable initialization and resize checks plus the existing
atomic rollback test, including setup resume. All 66 public deployment, request,
and crank receipts had the same gas usage as their matching local samples.
