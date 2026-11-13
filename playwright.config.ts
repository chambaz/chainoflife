import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
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
    env: { GAME_OF_LIFE_CONFIG: "tests/support/browser.env" },
  },
});
