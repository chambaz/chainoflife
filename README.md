# Chain of Life

A 100-million-cell Conway's Game of Life world on Thruput. One transaction
advances the entire 10,000 × 10,000 grid. A Rust indexer verifies each generation
against its on-chain digest and serves tiles to an interactive browser explorer.

## Run locally

Requires Linux, Node.js 22.12+, npm, Rust with rustup, and
[Thruput CLI](https://thruput.network/docs/) **0.43.0**. Rust uses the pinned
toolchain in this repository. Dependencies come from public npm and crates.io.

```sh
cd apps/game-of-life
npm ci
npm run node
```

Keep the node running. In another terminal:

```sh
cd apps/game-of-life
npm run setup:local
npm run dev
```

Open **http://127.0.0.1:5173**. Use **Advance 100,000,000 cells** to request
and process a generation. Each visitor gets a browser wallet funded by an
airdrop. The wallet is saved in that browser for future visits.

The local node uses port 9547 and a 60-billion-gas transaction cap. A full-world
tick needs about 9.1 billion gas, above the default 1-billion cap; this experiment
requires the supplied local configuration.

Setup creates deployment accounts and checks the world before writing
`.env.local`. Keys, transactions, and ledger data stay in ignored `tmp/`.
To restart, run `node` and `dev` without setup. To finish interrupted setup,
run `npm run setup:local -- --resume`. Set `THRUPUT_CLI=/path/to/thruput` if
the required CLI version is not on your PATH.
