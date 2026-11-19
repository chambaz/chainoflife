# Architecture

Chain of Life has four parts:

- `contract/` stores the world and its metadata.
- `core/` supplies pure simulation, deterministic initialization, and hashing.
- `indexer/` verifies complete snapshots and serves immutable tiles.
- `web/` displays tiles and manages visitor wallets and transaction recovery.

## Generation flow

1. The browser signs and submits one `advance` transaction.
2. The contract computes the next generation and commits all bank writes,
   metadata, and the `GenerationAdvanced` event together. Failure rolls them
   all back.
3. The world state has an exclusive lock. If two advances or resizes land in
   the same block, one commits. The node drops the others without a receipt
   or effect. Their senders can submit again.
4. The indexer reads the committed metadata, downloads the world, and verifies
   population and digest against that metadata.
5. The browser displays the next generation when viewport coverage is complete.
   It checks the indexer every 5 seconds, or every second while the chain is
   known to be ahead of its newest snapshot, as after its own advance.

Edges wrap around. Configurable worlds support 100–17,400 cells per side in
steps of 100. Resizing keeps the seed, increments the epoch, and resets generation
to zero. Fixed worlds reject resizing.
See [contract storage and encoding](../contract/README.md).

## Evidence and recovery

Submission and committed execution are distinct states.
Deployment and browser code save signed evidence before broadcast. An uncertain
result is observed by its original hash, never automatically submitted again.
The browser keeps a pending write's signed bytes in the wallet's one write
record, so a finished write no longer keeps them. An unknown write is released
as expired only when the RPC's history covers every block from signing to
expiry and does not include it. Browser write locks coordinate tabs; interrupted resets are recovered under that lock.

Visitor keys are generated in the browser and persist across reloads and tabs.
Deployment keys stay on disk. Funding intent is saved before the RPC request;
an uncertain funding attempt does not trigger a new grant automatically.

The chain owns canonical state. The indexer verifies a complete world before
publishing tiles; individual tiles have no independent proofs. Provenance
records the verified identity and the source block. It does not reference
events or transactions. Browser predictions remain separate from verified
snapshots. The previous generation stays visible until replacement tiles are
ready.

## Tooling boundaries

`scripts/deployment-config.ts` owns deployment presets and budgets.
`scripts/world.ts` holds the deployment, funding, and `advance` helpers that
deployment, the benchmark, and live checks share.
The selected environment file supplies public browser settings; contract metadata
supplies resize permission. `scripts/configuration.mjs` loads selected files for
development, builds, and Vite. `scripts/paths.mjs` resolves repository paths.

The browser connects to the RPC and the indexer directly. A local node does not
allow cross-origin requests, so for a loopback RPC the Vite dev server proxies
it through `scripts/local-rpc-proxy.ts`. The build writes a Content-Security-Policy
that allows connections to the RPC and indexer origins only. Browser fixture
serving lives in `tests/support/fixture.ts`. [Hosting](development.md#hosting)
describes the container images.

## Protocol identifiers

| Identifier             | Value                              | Changes require                            |
| ---------------------- | ---------------------------------- | ------------------------------------------ |
| World digest domain    | `chain-of-life/world/v2`           | New reference vectors and a new deployment |
| Indexer JSON documents | `schemaVersion: 2`                 | Matching indexer and browser releases      |
| Indexer HTTP paths     | `/v2/worlds/<network>/<contract>/` | Matching indexer and browser releases      |
| Density tile encoding  | `live-count-u8-z3-u16le`           | Matching indexer and browser releases      |
| Browser storage keys   | `chain-of-life:<kind>:v1:…`        | A new key; old records are ignored         |

The digest binds the size, epoch, and generation, so each reset has a distinct
digest and immutable artifact directory. Rust package names appear in contract
event identities and build artifacts; renaming them changes the contract.
