# Builds the browser app for one public configuration and serves it as static
# files. Build from the repository root: docker build -f web/Dockerfile .
# Pass each setting as a build argument; Railway passes service variables.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
ARG VITE_THRUPUT_RPC_URL
ARG VITE_THRUPUT_NETWORK_ID
ARG VITE_GAME_OF_LIFE_CONTRACT_ADDRESS
ARG VITE_GAME_OF_LIFE_INDEXER_URL
ARG VITE_GAME_OF_LIFE_GAS_LIMIT
ARG VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT
# The build reads one configuration file and validates every value.
RUN printenv | grep '^VITE_' > /tmp/app.env \
  && node scripts/build.mjs --config /tmp/app.env

FROM caddy:2-alpine
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv
