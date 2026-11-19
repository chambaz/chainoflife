# Chain of Life contract

The contract stores a bit-packed square toroidal Conway world. Each side is
100 to 17,400 cells, in steps of 100.

| Method | Effect |
| --- | --- |
| `initialize(seed, size, resizable)` | Creates the world once at generation zero. |
| `advance()` | Computes and stores the next generation of the complete world. |
| `resize(size)` | Resets a resizable world at a new size and epoch, keeping its seed. Fixed worlds fail with `FixedWorld`. |
| `get_metadata()` | Returns epoch, size, generation, seed, population, digest, and resize policy. |
| `get_chunk(row, part)` | Returns up to 1,000 bytes of one row of the active bank, from byte `part * 1000`, padded with zeros. |

## Storage

Cells use row-major, LSB-first bits. Each row has `ceil(size / 8)` bytes;
padding bits are zero. A bank stores the rows end to end as one byte string,
split into chunks of 4,096 bytes under consecutive keys from zero. The last
chunk holds the remainder. A row can span two chunks.

At full size, each bank has 9,240 chunks and 37,845,000 bytes.
Even generations read bank A and write bank B; odd generations reverse
those roles. Initialization and reset write bank A. Unused keys from larger
boards remain stored, but advances do not read or write them.

For cell `(x, y)`:

```text
world_byte    = y * ceil(size / 8) + floor(x / 8)
bit           = x % 8
chunk_key     = floor(world_byte / 4096)
byte_in_chunk = world_byte % 4096
```

Chunks need a network whose `max_bytestring_len` is at least 4,096, as on
Futurenet. `thruput.toml` sets it for local nodes.

An advance writes a whole bank, so the network's `max_subtransaction_output_bytes`
must exceed the world's bytes plus per-chunk overhead. The 16 MiB default allows
worlds up to 11,400 cells per side; a full 17,400 world writes 37.8 MB, so 64 MiB
leaves room.

The digest starts with SHA-256 of the ASCII domain `chain-of-life/world/v2`,
followed by big-endian width (`u32`), height (`u32`), epoch (`u64`), and
generation (`u64`).
In ascending key order, each step hashes the previous digest, chunk key (`u32`),
actual length (`u32`), and SHA-256 of the chunk bytes. The core tests pin the
encoding and full-world vectors.

## Transactions

`advance` reads the chunks of the active bank in order, evaluates each
destination row from a three-row window, stores each completed chunk, and
calculates population and digest. It then switches the active
bank, writes the world state, and emits `GenerationAdvanced` with the caller as
the `advanced_by` topic. All effects commit together or roll back together.

The world state is written with an exclusive lock. If two advances or resets
land in the same block, one commits. The node drops the others without a
receipt or effect; they expire, and their senders can submit again.

`resize` and `initialize` emit `WorldInitialized`. Each reset increments the
epoch, so resets to an earlier size still have a distinct digest.

At full size, one advance performs 302,760,000 cell evaluations, reads the
9,240 chunks of one bank, and writes the 9,240 chunks of the other
(37,845,000 bytes each way). The first and last chunks are read again for the
toroidal boundary rows. At smaller sizes, evaluations and chunk traffic scale
with the selected grid.

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
on an isolated ledger with the node's default gas cap.
