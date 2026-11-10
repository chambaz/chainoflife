# Chain of Life development

## Structure

- `contracts/game-of-life`: atomic world contract.
- `helpers/game-of-life-core`: simulation, initialization, and digest.
- `helpers/game-of-life-indexer`: verified snapshots, tiles, SQLite state, HTTP.
- `apps/game-of-life`: React explorer, visitor wallets, setup, and live tests.
- `apps/game-of-life-renderer-fixture`: isolated renderer regression tests.
- `sim-fixtures/life-storage-admission`: contract storage workload fixture.

## Conventions

- Read the relevant READMEs before changing setup or runtime behavior.
- Use npm with each app's lockfile, the pinned Rust toolchain, and public registries.
  Preserve package versions unless an upgrade is requested.
- Use official Thruput RPC and wallet APIs. Regenerate contract bindings with
  `npm run generate:contracts` from the app; never edit generated files.
- Keep one full-world update atomic. Queue consumption, bank writes, metadata,
  and events must roll back together on failure.
- The digest domain is `chain-of-life/world/v2`, including the reset epoch. Changes to it or the encoding
  require new reference vectors and a new deployment.
- Distinguish submission, queue admission, and committed execution. Save signed
  evidence before broadcast; observe uncertain transactions by their original hash.
- Generate visitor keys in the browser; never inject deployment keys into the app.
  Preserve the wallet across reloads and tabs. Persist funding attempts before
  requesting an airdrop and never repeat an uncertain attempt automatically.
- Keep canonical indexer snapshots distinct from browser-derived predictions.
- Never commit environment files, keys, ledgers, indexer databases or tiles,
  test output, or build output. Use ignored `.tmp/` for local notes and reports.

## Verification

From the affected app, run `npm run typecheck`, `npm test`, `npm run build`,
and `npm run test:chromium` for browser changes. Chromium must be installed;
`CHROMIUM_PATH` selects its executable.

For Rust changes, run `cargo fmt --all --check`,
`cargo test --locked -p game-of-life-core -p game-of-life-indexer`, and
`cargo clippy --locked --workspace --all-targets --no-deps -- -D warnings`.
Run the core's ignored full-scale reference test in release mode after changes
to initialization, simulation, or digest encoding.

Run the app's `check:contracts` after contract or generator changes. Live checks
require CLI 0.43.0 and its compatible runtime: `test:clean-ledger` creates an
isolated ledger, and `test:browser:local` uses `GAME_OF_LIFE_APP_URL`.
Full-world ticks exceed the default gas cap; use the supplied node configuration.
Report blocked live checks explicitly. Fixtures and old measurements are not
fresh live acceptance.
