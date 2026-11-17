# Chain of Life development

This is a local Thruput developer experiment. Keep solutions small and specific
to the showcase. Avoid new frameworks, hosted-service features, or contribution
infrastructure unless explicitly requested.

## Structure

- `contract/`: atomic world contract.
- `core/`: simulation, initialization, and digest.
- `indexer/`: verified snapshots, immutable tiles, HTTP.
- `web/`: React explorer and visitor wallets.
- `scripts/`: setup, development, build, and benchmark commands.
- `tests/browser/` and `tests/live/`: cross-component checks.

## Conventions

- Read the relevant READMEs before changing setup or runtime behavior.
- Start local chains with the documented `thruput node` command. Setup creates
  and funds its accounts through the local faucet; it does not need bootstrap
  allocations. Persist funding intent before the RPC and reuse its nonce and
  amount only on explicit setup resume; observe known hashes without a new grant.
- Use root npm commands, the pinned Rust toolchain, and public registries.
  Preserve package versions unless an upgrade is requested.
- Use official Thruput RPC and wallet APIs. Regenerate contract bindings with
  `npm run generate:contracts` from the root; never edit generated files.
- Keep one full-world update atomic. Bank writes, metadata, and events must
  roll back together on failure.
- The digest domain is `chain-of-life/world/v2`, including the reset epoch. Changes to it or the encoding
  require new reference vectors and a new deployment.
- Distinguish submission and committed execution. Save signed
  evidence before broadcast; observe uncertain transactions by their original hash.
- Recover interrupted resets under the cross-tab write lock and reload the record
  after acquiring it. A pending reset without a hash can become a retryable failure:
  the SDK awaits the hash-saving callback before broadcast. Never automatically
  resubmit a signed reset. Timing storage must not affect transaction outcomes.
- Generate visitor keys in the browser; never inject deployment keys into the app.
  Preserve the wallet across reloads and tabs. Persist funding attempts before
  requesting an airdrop and never repeat an uncertain attempt automatically.
- Keep canonical indexer snapshots distinct from browser-derived predictions.
- Never commit environment files, keys, ledgers, indexer databases or tiles,
  test output, or build output. Use ignored `.tmp/` for local notes and reports.

## Verification

Run the checks in [docs/development.md](docs/development.md#verification) that
match your change. Rust changes need the Rust checks. Initialization, simulation,
or digest changes also need the core's release-mode full-scale reference test.
Contract or generator changes need `npm run check:contracts`.

Every supported world fits the default one-billion-gas transaction cap.
Report blocked live checks explicitly. Fixtures and old measurements are not
fresh live acceptance.
