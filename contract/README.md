# Chain of Life contract

The contract stores a bit-packed square toroidal Conway world. Each side is
100 to 10,000 cells, in steps of 100.

| Method | Effect |
| --- | --- |
| `initialize(seed, size, resizable)` | Creates the world once at generation zero. |
| `advance()` | Computes and stores the next generation of the complete world. |
| `resize(size)` | Resets a resizable world at a new size and epoch, keeping its seed. Fixed worlds fail with `FixedWorld`. |
| `get_metadata()` | Returns epoch, size, generation, seed, population, digest, and resize policy. |
| `get_chunk(row, part)` | Returns one stored chunk of the active bank. |

## Storage

Cells use row-major, LSB-first bits. Each row has `ceil(size / 8)` bytes,
split into chunks of at most 1,000 bytes. Padding bits are zero.
At full size, each bank has 20,000 chunks and 12,500,000 bytes.
Even generations read bank A and write bank B; odd generations reverse
those roles. Initialization and reset write bank A. Unused keys from larger
boards remain stored, but ticks do not read or write them.

For cell `(x, y)`:

```text
byte_in_row  = floor(x / 8)
bit          = x % 8
part         = floor(byte_in_row / 1000)
byte_in_part = byte_in_row - part * 1000
chunk_key    = y * ceil(ceil(size / 8) / 1000) + part
```

The digest starts with SHA-256 of the ASCII domain `chain-of-life/world/v2`,
followed by big-endian width (`u32`), height (`u32`), epoch (`u64`), and
generation (`u64`).
In ascending key order, each step hashes the previous digest, chunk key (`u32`),
actual length (`u32`), and SHA-256 of the chunk bytes. The core tests pin the
encoding and full-world vectors.

## Transactions

`advance` streams a three-row window, evaluates each destination row, writes
its chunks, and calculates population and digest. It then switches the active
bank, writes the world state, and emits `GenerationAdvanced` with the caller as
the `advanced_by` topic. All effects commit together or roll back together.

The world state is written with an exclusive lock. If two advances or resets
land in the same block, one commits. The node drops the others without a
receipt or effect; they expire, and their senders can submit again.

`resize` and `initialize` emit `WorldInitialized`. Each reset increments the
epoch, so resets to an earlier size still have a distinct digest.

At full size, one advance performs 100,000,000 cell evaluations, 20,004
bank-chunk reads (12,502,500 bytes), and 20,000 bank-chunk writes (12,500,000
bytes). Reads include two repeated rows for toroidal boundaries. At smaller
sizes, evaluations and chunk traffic scale with the selected grid.

## Build and verify

```sh
thruput build -p game-of-life
cargo test --locked -p game-of-life-core
cargo test --locked -p game-of-life-core --release \
  full_scale_generation_one_vector -- --ignored
npm run check:contracts
```

See the [root README](../README.md) for local deployment. From the repository root,
`npm run test:clean-ledger` verifies deployment and the live transaction lifecycle
on an isolated ledger. Full-world advances need a raised local gas cap; the
supplied node command configures it.
