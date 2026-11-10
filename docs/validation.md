# Validation notes

This is a local developer experiment, not a public-network benchmark.
Checks below were run on 2026-11-09.

## Environment

- Linux x86-64, AMD Ryzen 9 7940HS, 60 GiB usable RAM.
- Node.js 26.13.0 and npm 11.20.0.
- Rust `nightly-2026-07-01`, Thruput CLI 0.43.0, hog-devnode 0.1.31.
- Chromium 155.0.8059.84. Browser automation uses SwiftShader software rendering.
- Local node: one-second block interval and 60-billion-gas transaction cap.

This describes the reference machine, not minimum hardware requirements.
No minimum-memory or clean-OS installation test has been completed. The isolated
checkout used existing system tools and Cargo download caches, with fresh npm
dependencies, deployment accounts, and ledger state.

## Checks

Run app checks from `apps/game-of-life`:

```sh
npm run typecheck
npm test
npm run build
npm run test:chromium
npm run check:contracts
```

The main app has 212 passing unit tests and 29 passing Chromium tests. The renderer
fixture has 14 passing unit tests and 5 passing Chromium tests. Rust formatting,
60 core/indexer tests, and workspace Clippy pass. The contract builds and generated
TypeScript bindings match it. Live tests are separate from these fixture checks.

### Isolated contract execution

`npm run test:clean-ledger` passed in a separate checkout with fresh accounts and
ledger data. Setup verified three full-world advances. The integration test
confirmed that a failed crank preserves the world and admitted request, and
another caller can complete it.

The first three 10,000 × 10,000 advances used 9,560,453,763; 9,569,091,249; and
9,567,190,815 root gas. Gas is a computation budget, not elapsed time or a token fee.

### Timing interpretation

The live resize test saves measurements under `test-results/live/`. Each record
separates submission, receipt confirmation, and board readiness. Confirmation
includes scheduling and observation; it is not a measurement of executor CPU time.
Board readiness also includes indexer work, polling, tile loading, and rendering.
SwiftShader interaction timings are not hardware-GPU benchmarks.

## Dependency review

The release pass removed the shadcn CLI from normal installation. Its unused CSS
import was also removed; the checked-in UI uses Tailwind and Radix state variants
directly. This removes its MCP/Express tooling dependency tree. Vite was patched
to 7.3.8, Vitest to 4.1.12, and `source-map-js` to 1.2.2 in both apps.

The Cargo lockfile now uses rustls 0.23.46, rustls-webpki 0.103.16,
webpki-root-certs 1.0.10, and Tokio 1.53.3. Thruput SDK and renderer versions
remain pinned.

Remaining findings are recorded rather than hidden by audit exclusions:

| Finding | Use in this experiment | Decision |
| --- | --- | --- |
| [fflate malformed ZIP64 archive](https://github.com/advisories/GHSA-px8p-9vwx-vf98) | Transitive loaders.gl dependency. The renderer fetches custom binary cell/density tiles and does not load ZIP archives. | Retain pinned renderer versions; reassess before adding archive input. |
| [image-size ICNS parser loop](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | Transitive loaders.gl dependency. The demo does not parse ICNS files or accept image uploads. | Retain pinned renderer versions; reassess before adding image input. |
| [SQLite database/WAL memory exposure](https://rustsec.org/advisories/RUSTSEC-2026-0459.html) | Bundled SQLite through rusqlite 0.32. The indexer creates and owns its local database; it does not import uploaded databases. | Defer the rusqlite 0.41 upgrade. Use locally generated database/WAL files, not files supplied by another party. |

After cleanup, each npm lockfile reports 11 affected packages (8 high, 3 moderate)
from the two loader advisories and their parent packages. `cargo audit` reports
the one SQLite advisory and no remaining informational warnings. These commands
still exit nonzero. No exploit was demonstrated in the demo's current input paths.

Recheck with `npm audit` in both app directories and `cargo audit` at the root.
Avoid `npm audit fix --force`: its suggested renderer downgrade changes the
tested renderer stack.

## Repository hygiene

A targeted scan of 274 historical Git blobs and the release working tree found
no matched private-key headers, common GitHub/AWS tokens, credential-bearing URLs,
or personal absolute paths. No tracked environment files, account files,
databases, or build directories were found in that history. This is a pattern
scan, not proof that all possible secret formats are absent.

The screenshot contains only the public demo UI. Runtime keys, journals, browser
state, databases, raw logs, and timing output remain ignored.

## Known limits

- Setup resume observes saved hashes but cannot replace an expired uncommitted
  setup transaction. A separate fresh demo is the simple recovery route.
- Activity currently scans history from block zero. This is suitable for short
  experiments; it is not a long-running history service.
- Unresolved signed evidence is retained in browser storage. Terminal evidence
  has no archival policy yet.
- CI builds the contract and tests the core, indexer, and browser fixtures. The
  local-node execution checks remain manual; CI is not a live acceptance result.
