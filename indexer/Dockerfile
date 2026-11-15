# Builds and runs the indexer for one deployed world.
# Build from the repository root: docker build -f indexer/Dockerfile .
FROM rust:1-bookworm AS build
WORKDIR /src
# rust-toolchain.toml selects the pinned nightly toolchain.
COPY rust-toolchain.toml rustfmt.toml Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY contract contract
COPY core core
COPY indexer indexer
RUN cargo build --locked -p game-of-life-indexer --profile indexer

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/indexer/game-of-life-indexer /usr/local/bin/
# Mount a persistent volume at /data to keep published snapshots across restarts.
ENV GAME_OF_LIFE_ARTIFACT_ROOT=/data/artifacts
CMD ["sh", "-c", "GAME_OF_LIFE_INDEXER_LISTEN=\"[::]:${PORT:-8787}\" exec game-of-life-indexer"]
