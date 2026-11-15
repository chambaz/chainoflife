import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadAppConfig } from "./web/src/config";
import { repoRoot, repoPath } from "./scripts/paths.mjs";
import { readConfiguration } from "./scripts/configuration.mjs";
import { localRpcProxy } from "./scripts/local-rpc-proxy";

/**
 * The app reads chain state from the RPC and snapshots from the indexer. A
 * local RPC is proxied by the dev server, so it stays same-origin.
 */
function contentSecurityPolicy(origins: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    `connect-src 'self' ${origins.join(" ")}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join("; ");
}
// Vitest unit tests do not read app configuration.
const UNIT_TEST_ENVIRONMENT = {
  VITE_THRUPUT_RPC_URL: "http://127.0.0.1:9545",
  VITE_THRUPUT_NETWORK_ID: "11".repeat(32),
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"22".repeat(32)}`,
  VITE_GAME_OF_LIFE_INDEXER_URL: "http://127.0.0.1:8787",
  VITE_GAME_OF_LIFE_GAS_LIMIT: "950000000",
  VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT: "945000000",
};

export default defineConfig(async ({ mode }) => {
  const selected = process.env.GAME_OF_LIFE_CONFIG;
  if (!selected && !process.env.VITEST)
    throw new Error(
      "Select an app configuration with GAME_OF_LIFE_CONFIG or npm run dev/build -- --config",
    );
  const environment: Record<string, string | undefined> = selected
    ? readConfiguration(selected)
    : UNIT_TEST_ENVIRONMENT;
  const config = loadAppConfig(environment);
  const origins = [
    config.indexerUrl.origin,
    ...(config.rpcProxied ? [] : [config.rpcUrl.origin]),
  ];
  const e2ePlugins =
    mode === "e2e"
      ? [
          (await import("./tests/support/fixture")).fixtureArtifacts(
            config.networkId,
            config.contractAddress,
          ),
        ]
      : [];
  return {
    root: repoPath("web"),
    // Only the selected configuration reaches the app.
    envDir: false as const,
    envPrefix: [],
    define: selected
      ? Object.fromEntries(
          Object.entries(environment)
            .filter(([key]) => key.startsWith("VITE_"))
            .map(([key, value]) => [
              `import.meta.env.${key}`,
              JSON.stringify(value),
            ]),
        )
      : {},
    build: { outDir: repoPath("dist"), emptyOutDir: true },
    plugins: [
      react(),
      tailwindcss(),
      ...(config.rpcProxied ? [localRpcProxy(config.rpcUrl.href)] : []),
      {
        name: "content-security-policy",
        transformIndexHtml: () => [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: contentSecurityPolicy(origins),
            },
            injectTo: "head-prepend" as const,
          },
        ],
      },
      ...e2ePlugins,
    ],
    resolve: { alias: { "@": repoPath("web/src") } },
    server: { host: "127.0.0.1", cors: false },
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
