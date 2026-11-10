# Chain of Life Indexer

The indexer downloads an on-chain world, verifies its population and digest,
builds immutable tiles, and serves one network and contract on loopback HTTP.

Schema version 2 includes the reset epoch and variable square dimensions.
Publication order is `(epoch, generation)`. The v2 digest binds the epoch,
so resets to the same size still have distinct immutable artifact paths.
The HTTP paths remain under `/v1/worlds`; JSON schema versions are separate.
Use a fresh database and artifact directory when switching from schema 1.

## Run

The app's `npm run dev` command configures and starts the indexer. To run it
separately, set `THRUPUT_RPC_URL`, `THRUPUT_NETWORK_ID` (64 lowercase hex
characters), and `THRUPUT_CONTRACT_ADDRESS` (a 0x-prefixed hex address).

Optional settings include `GAME_OF_LIFE_ARTIFACT_ROOT`,
`GAME_OF_LIFE_INDEXER_DB`, `GAME_OF_LIFE_INDEXER_LISTEN`,
`GAME_OF_LIFE_CORS_ORIGINS`, and `GAME_OF_LIFE_RETENTION_GRACE_SECONDS`.

```bash
cargo run --locked -p game-of-life-indexer --release
```

## Live acceptance

`scripts/live-acceptance.sh` checks publication, HTTP responses, SQLite state,
and byte-for-byte artifact stability after restarting the indexer service.
It reads the configured live chain without submitting transactions.

Set the three chain variables above, `GAME_OF_LIFE_EXPECT_GENERATION`,
`GAME_OF_LIFE_ARTIFACT_ROOT`, and `GAME_OF_LIFE_INDEXER_DB`, then run the
script from the repository root. Use a separate acceptance directory. For a
world beyond generation zero, copy existing artifacts and take a consistent
SQLite backup first: the test also checks retained predecessor publication.
Keep the chain generation stable during the check.

For deployment and transaction checks, use the app's `test:clean-ledger` command.
For browser advance, indexing, rendering, and reload checks, use
`GAME_OF_LIFE_APP_URL=http://127.0.0.1:5173 npm run test:browser:local`
from `apps/game-of-life`.
