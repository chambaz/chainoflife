import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { loadAppConfig } from "./web/src/config";
import { repoRoot, repoPath } from "./scripts/paths.mjs";
import { readConfiguration } from "./scripts/configuration.mjs";
import {
  indexerProxyScope,
  validateRpcTarget,
  validateIndexerTarget,
  rpcProxy,
  readOnlyIndexerProxy,
} from "./scripts/proxy";
import { fixtureArtifacts } from "./tests/support/fixture";
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self'; frame-ancestors 'none'",
};

export default defineConfig(({ command, mode }) => {
  const selected = process.env.GAME_OF_LIFE_CONFIG;
  const environment = selected
    ? readConfiguration(selected)
    : loadEnv(mode, repoRoot, "");
  if (selected) loadAppConfig(environment);
  const target = environment.VITE_THRUPUT_RPC_URL ?? "http://127.0.0.1:9545";
  const indexerTarget =
    environment.VITE_GAME_OF_LIFE_INDEXER_URL ?? "http://127.0.0.1:8787";
  const { networkId, contractAddress } = indexerProxyScope(
    mode === "test" || command === "build"
      ? {
          VITE_THRUPUT_NETWORK_ID:
            environment.VITE_THRUPUT_NETWORK_ID ?? "11".repeat(32),
          VITE_GAME_OF_LIFE_CONTRACT_ADDRESS:
            environment.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS ??
            `0x${"22".repeat(32)}`,
        }
      : environment,
  );
  validateRpcTarget(target);
  validateIndexerTarget(indexerTarget);
  return {
    root: repoPath("web"),
    envDir: repoRoot,
    build: { outDir: repoPath("dist"), emptyOutDir: true },
    ...(selected
      ? {
          envDir: false as const,
          define: Object.fromEntries(
            Object.entries(environment)
              .filter(([key]) => key.startsWith("VITE_"))
              .map(([key, value]) => [
                `import.meta.env.${key}`,
                JSON.stringify(value),
              ]),
          ),
        }
      : {}),
    envPrefix: selected
      ? []
      : [
          "VITE_THRUPUT_RPC_URL",
          "VITE_THRUPUT_LOCAL_FAUCET_ADDRESS",
          "VITE_THRUPUT_NETWORK_ID",
          "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS",
          "VITE_GAME_OF_LIFE_INDEXER_URL",
          "VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT",
          "VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT",
          "VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS",
          "VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS",
          "VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT",
          "VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT",
          "VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS",
          "VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS",
        ],
    plugins: [
      react(),
      tailwindcss(),
      rpcProxy(target),
      readOnlyIndexerProxy(indexerTarget, networkId, contractAddress),
      ...(mode === "e2e" ? [fixtureArtifacts(networkId, contractAddress)] : []),
    ],
    resolve: { alias: { "@": repoPath("web/src") } },
    server: {
      host: "127.0.0.1",
      cors: false,
      headers: SECURITY_HEADERS,
    },
    preview: { host: "127.0.0.1", cors: false, headers: SECURITY_HEADERS },
    test: {
      root: repoRoot,
      execArgv: ["--no-experimental-webstorage"],
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://127.0.0.1" } },
      setupFiles: ["./web/src/test/setup.ts"],
      include: ["web/src/**/*.test.{ts,tsx}", "vite.config.test.ts"],
    },
  };
});
