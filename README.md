# Chain of Life

A resizable Conway's Game of Life world on Thruput, from 100 × 100 to
10,000 × 10,000 cells. One transaction advances the entire grid.
A Rust indexer verifies each generation
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
and process a generation. Use the header slider to change the board size.
Releasing the slider resets generation to zero with the same seed.
Each visitor gets a browser wallet funded once by the local faucet.
The wallet is shared across tabs and saved for future visits.

The local node uses port 9547 and a 60-billion-gas transaction cap. A full-world
tick needs about 9.6 billion gas, above the default 1-billion cap; this experiment
requires the supplied local configuration.

Setup creates deployment accounts and checks the world before writing
`.env.local`. Keys, transactions, and ledger data stay in ignored `tmp/`.
To restart, run `node` and `dev` without setup. To finish interrupted setup,
run `npm run setup:local -- --resume`. Set `THRUPUT_CLI=/path/to/thruput` if
the required CLI version is not on your PATH.
