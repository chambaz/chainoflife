# Architecture

Chain of Life has four parts:

- `contract/` stores the world, request queue, and metadata.
- `core/` supplies pure simulation, deterministic initialization, and hashing.
- `indexer/` verifies complete snapshots and serves immutable tiles.
- `web/` displays tiles and manages visitor wallets and transaction recovery.

## Generation flow

1. The browser signs and submits a tick request.
2. A separate transaction consumes one queued request and computes the world.
3. The contract commits all bank writes, queue changes, metadata, and events
   together. Failure rolls them all back.
4. The indexer downloads the committed world and verifies population and digest.
5. The browser displays the next generation when viewport coverage is complete.

Edges wrap around. Configurable worlds support 100–10,000 cells per side in
steps of 100. Resizing keeps the seed, increments the epoch, and resets generation
to zero. Pending requests must finish first. Fixed worlds reject resizing.
See [contract storage and encoding](../contract/README.md).

## Evidence and recovery

Submission, queue admission, and committed execution are distinct states.
Deployment and browser code save signed evidence before broadcast. An uncertain
result is observed by its original hash, never automatically submitted again.
Browser write locks coordinate tabs; interrupted resets are recovered under that lock.

Visitor keys are generated in the browser and persist across reloads and tabs.
Deployment keys stay on disk. Funding intent is saved before the RPC request;
an uncertain funding attempt does not trigger a new grant automatically.

The chain owns canonical state. The indexer verifies a complete world before
publishing tiles; individual tiles have no independent proofs. Browser predictions
remain separate from verified snapshots. The previous generation stays visible
until replacement tiles are ready.

## Tooling boundaries

`scripts/deployment-config.ts` owns deployment presets and budgets.
The selected environment file supplies public browser settings; contract metadata
supplies resize permission. `scripts/configuration.mjs` loads selected files for
development, builds, and Vite. `scripts/paths.mjs` resolves repository paths.

Vite connects the browser to the RPC and read-only indexer proxies in
`scripts/proxy.ts`. Browser fixture serving lives in `tests/support/fixture.ts`.
Hosting needs equivalent routing and remains a separate deployment task.

## Compatibility

Directory names are independent of stored protocol identities. The digest domain
remains `chain-of-life/world/v2`, JSON uses `schemaVersion: 2`, and HTTP paths use
`/v1/worlds`. The epoch distinguishes resets in digests and immutable tile paths.
Browser storage identities and database formats remain stable.
Rust package names also remain stable because artifacts and event identities use them.
