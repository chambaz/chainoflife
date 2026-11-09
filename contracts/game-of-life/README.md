# Chain of Life contract

The contract stores a bit-packed 10,000 × 10,000 toroidal Conway world.
One successful non-empty `process_next_tick` invocation consumes one queued
request and atomically writes the complete next generation.

## Storage

Cells use row-major, LSB-first bits. Each row is 1,250 bytes, split into a
1,000-byte chunk and a 250-byte tail. Each bank has 20,000 chunks and
12,500,000 bytes. Even generations read bank A and write bank B; odd
generations reverse those roles. Initialization materializes bank A.

For cell `(x, y)`:

```text
byte_in_row  = floor(x / 8)
bit          = x % 8
part         = byte_in_row < 1000 ? 0 : 1
byte_in_part = byte_in_row - part * 1000
chunk_key    = y * 2 + part
```

The digest starts with SHA-256 of the ASCII domain `chain-of-life/world/v1`,
followed by big-endian width (`u32`), height (`u32`), and generation (`u64`).
In ascending key order, each step hashes the previous digest, chunk key (`u32`),
actual length (`u32`), and SHA-256 of the chunk bytes. The core tests pin the
encoding and full-world vectors.

## Transactions

`request_tick` adds attributed intent to a bounded queue. A separate,
permissionless `process_next_tick` consumes one request. Its caller need not
be the requester. An empty crank does not advance the generation.

A non-empty crank streams a three-row window, evaluates each destination
row, writes its chunks, and calculates population and digest. It then switches
the active bank and metadata, releases the queue slot, and emits
`GenerationAdvanced`. All effects commit together or revert together,
including queue consumption.

One tick performs 100,000,000 cell evaluations, 20,004 bank-chunk reads
(12,502,500 bytes), and 20,000 bank-chunk writes (12,500,000 bytes).
Reads include two repeated rows for toroidal boundaries. Four row buffers
use 5,000 bytes; runtime and compiler temporaries add to guest memory use.

## Build and verify

```sh
thruput build -p game-of-life
cargo test --locked -p game-of-life-core
cargo test --locked -p game-of-life-core --release \
  full_scale_generation_one_vector -- --ignored
npm --prefix apps/game-of-life run check:contracts
```

See the [root README](../../README.md) for local deployment. From the app,
`npm run test:clean-ledger` verifies setup and the live transaction lifecycle
on an isolated ledger. Full-world ticks need a raised local gas cap; the
supplied node command configures it.
