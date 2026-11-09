import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4176",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
  webServer: {
    timeout: 180_000,
    command: "npx vite --mode e2e --host 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
    env: {
      VITE_THRUPUT_RPC_URL: "http://127.0.0.1:4176",
      VITE_THRUPUT_LOCAL_FAUCET_ADDRESS: "",
      VITE_THRUPUT_NETWORK_ID: `0x${"AA".repeat(32)}`,
      VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"22".repeat(32)}`,
      VITE_GAME_OF_LIFE_INDEXER_URL: "http://127.0.0.1:4176",
      VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "100000",
      VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT: "100000",
      VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS: "64",
      VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS: "30000",
      VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT: "10010000000",
      VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: "10000000000",
      VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS: "2",
      VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS: "300000",
    },
  },
});
