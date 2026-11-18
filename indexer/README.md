# Chain of Life Indexer

The indexer downloads an on-chain world, verifies its population and digest,
builds immutable tiles, and serves them over HTTP for one network and contract.

## Publication

1. Poll `get_metadata` every 2 seconds. If the world matches `latest.json`,
   do nothing.
2. Download every chunk. Metadata before and after the download must be equal,
   and no chunk can come from a block before the source block. Chunks are read
   with `simulateInvocations`, up to 16 views per request (fewer if the endpoint's
   `getServerLimits` batch limit is lower) and 64 requests at a time. Each batch
   runs against one committed snapshot. Endpoints without batch support are read
   one view at a time.
3. Verify population and digest against the metadata, then build and check
   the tiles. Nothing is written before these checks pass.
4. Install the digest directory: write the tiles and `provenance.json` into a
   hidden staging directory, fsync them together, and rename it into place.
   Then install `manifest.json`. Files in a digest directory are never changed.
5. Replace `latest.json` atomically.

Publication order is `(epoch, generation)`. `latest.json` never moves back.
The digest binds the epoch, so resets to the same size still have distinct
immutable artifact paths.

`provenance.json` records the network, contract, world identity, source block,
and verification time. It does not reference events or transactions.

## Tiles

Each digest directory holds `tiles/{z}/{x}/{y}.bin` for zoom 0 to 6, 256 × 256
texels per tile. Zoom 6 tiles hold exact cells, one bit each (8,192 bytes).
Lower zooms hold the live-cell count of each texel. Zooms 3 to 5 count at most
64 cells per texel and use one byte (65,536 bytes per tile); zooms 0 to 2 use two
bytes, little-endian (131,072 bytes). A full-size world publishes 49 MB per
generation.

Artifacts from schema version 1 (`v1/` under the artifact root) are not read
or served. Delete that directory after upgrading.

## State

All state is on the filesystem: the digest directories and `latest.json`.
There is no database. A lock file allows one writer for each artifact root.

If the indexer stops after an install but before step 5, the next run finds
the existing digest directory. It reuses that directory's `provenance.json`,
so the retried install writes identical bytes. A staging directory left by an
interrupted install is never served and is removed at the next cleanup.

Retention keeps the directory that `latest.json` points to and the previous
publication. Other publications stay for a grace period after they are
replaced, so browsers can finish loading them. After a restart, every
publication older than `latest.json` starts a new grace period. Unpromoted
directories are removed at the next cleanup. To rebuild from the chain,
stop the indexer and delete its artifact directory.

## Run

The app's `npm run dev` command configures and starts the indexer. To run it
separately, set `THRUPUT_RPC_URL`, `THRUPUT_NETWORK_ID` (64 lowercase hex
characters), and `THRUPUT_CONTRACT_ADDRESS` (a 0x-prefixed hex address).

Optional settings include `GAME_OF_LIFE_ARTIFACT_ROOT`,
`GAME_OF_LIFE_INDEXER_LISTEN` (default `127.0.0.1:8787`),
`GAME_OF_LIFE_CORS_ORIGINS` (comma-separated browser origins), and
`GAME_OF_LIFE_RETENTION_GRACE_SECONDS` (default 300). Requests from other
origins receive 403. [Hosting](../docs/development.md#hosting) describes the container image.

Run from the repository root. The default artifact root is
`.local/indexer/<network>/<contract>/artifacts`.

```bash
cargo run --locked -p game-of-life-indexer --profile indexer
```

## Live acceptance

`indexer/scripts/live-acceptance.sh` checks publication, HTTP responses, and
byte-for-byte artifact stability after restarting the indexer service.
It reads the configured live chain without submitting transactions.

Set the three chain variables above, `GAME_OF_LIFE_EXPECT_GENERATION`, and
`GAME_OF_LIFE_ARTIFACT_ROOT`, then run the script from the repository root.
Use a separate acceptance directory. Keep the chain generation stable during
the check.

For deployment and transaction checks, use the app's `test:clean-ledger` command.
For browser advance, indexing, rendering, and reload checks, use
`GAME_OF_LIFE_APP_URL=http://127.0.0.1:5173 npm run test:browser:local`
from the repository root.
