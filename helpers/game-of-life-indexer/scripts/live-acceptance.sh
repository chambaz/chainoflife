#!/usr/bin/env bash
set -euo pipefail

: "${THRUPUT_RPC_URL:?set THRUPUT_RPC_URL}"
: "${THRUPUT_NETWORK_ID:?set THRUPUT_NETWORK_ID}"
: "${THRUPUT_CONTRACT_ADDRESS:?set THRUPUT_CONTRACT_ADDRESS}"

: "${GAME_OF_LIFE_EXPECT_GENERATION:?set the current generation}"
: "${GAME_OF_LIFE_ARTIFACT_ROOT:?set the acceptance artifact directory}"
: "${GAME_OF_LIFE_INDEXER_DB:?set the acceptance SQLite database}"

cargo test --locked -p game-of-life-indexer --release --test live_acceptance \
  indexes_live_generation_and_restarts_byte_identically -- --ignored --exact --nocapture
