// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import configuration from "./vite.config";
import { configurationEnvironment } from "./scripts/configuration.mjs";
import {
  isAllowedRpcRequest,
  isSameOriginLoopback,
} from "./scripts/local-rpc-proxy";
const network = "11".repeat(32);
const contract = `0x${"22".repeat(32)}`;

test("selected app configuration excludes inherited and default environment values", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(".tmp/life-config-");
  const selected = join(directory, "selected.env");
  await writeFile(
    selected,
    `VITE_THRUPUT_RPC_URL=https://rpc.thruput.network\nVITE_THRUPUT_NETWORK_ID=${network}\nVITE_GAME_OF_LIFE_CONTRACT_ADDRESS=${contract}\nVITE_GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787\nVITE_GAME_OF_LIFE_GAS_LIMIT=1000000000\nVITE_GAME_OF_LIFE_TARGET_GAS_LIMIT=999000000\n`,
  );
  vi.stubEnv("GAME_OF_LIFE_CONFIG", selected);
  vi.stubEnv("VITE_THRUPUT_LOCAL_FAUCET_ADDRESS", "must-not-leak");
  try {
    const environment = configurationEnvironment(selected, {
      PATH: "/tools",
      VITE_THRUPUT_RPC_URL: "https://wrong.invalid",
      VITE_THRUPUT_LOCAL_FAUCET_ADDRESS: "must-not-leak",
    });
    expect(environment.PATH).toBe("/tools");
    expect(environment.VITE_THRUPUT_RPC_URL).toBe(
      "https://rpc.thruput.network",
    );
    expect(environment).not.toHaveProperty("VITE_THRUPUT_LOCAL_FAUCET_ADDRESS");
    if (typeof configuration !== "function")
      throw new Error("Expected Vite configuration factory");
    const config = await configuration({
      command: "build",
      mode: "production",
    });
    expect(config.envDir).toBe(false);
    expect(config.envPrefix).toEqual([]);
    expect(config.define?.["import.meta.env.VITE_THRUPUT_RPC_URL"]).toBe(
      JSON.stringify("https://rpc.thruput.network"),
    );
    expect(
      config.define?.["import.meta.env.VITE_THRUPUT_LOCAL_FAUCET_ADDRESS"],
    ).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true });
  }
});
describe("visitor RPC proxy policy", () => {
  test.each([
    "getChainTip",
    "getEvents",
    "simulateInvocation",
    "getVersionInfo",
    "getNetworkInfo",
    "getServerLimits",
    "getBalance",
    "faucet_requestAirdrop",
    "dev_fundAccount",
    "sendTransaction",
    "getTransactionReceipt",
    "getTransactionStatus",
  ])("allows %s", (method) =>
    expect(
      isAllowedRpcRequest({ jsonrpc: "2.0", id: 1, method, params: {} }),
    ).toBe(true),
  );
  test.each(["eth_call"])("denies %s", (method) =>
    expect(isAllowedRpcRequest({ jsonrpc: "2.0", id: 1, method })).toBe(false),
  );
  test("rejects batches, notifications, and unknown envelope fields", () => {
    expect(isAllowedRpcRequest([])).toBe(false);
    expect(
      isAllowedRpcRequest({ jsonrpc: "2.0", method: "simulateInvocation" }),
    ).toBe(false);
    expect(
      isAllowedRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateInvocation",
        extra: true,
      }),
    ).toBe(false);
  });
  test("requires matching same-origin loopback headers", () => {
    expect(
      isSameOriginLoopback({
        host: "127.0.0.1:4176",
        origin: "http://127.0.0.1:4176",
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(true);
    expect(
      isSameOriginLoopback({
        host: "127.0.0.1:4176",
        origin: "http://evil.test",
      }),
    ).toBe(false);
    expect(
      isSameOriginLoopback({
        host: "localhost:4176",
        referer: "http://localhost:4176/explorer",
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(true);
  });
});

describe("content security policy", () => {
  async function policy(rpcUrl: string) {
    await mkdir(".tmp", { recursive: true });
    const directory = await mkdtemp(".tmp/life-csp-");
    const selected = join(directory, "selected.env");
    await writeFile(
      selected,
      `VITE_THRUPUT_RPC_URL=${rpcUrl}\nVITE_THRUPUT_NETWORK_ID=${network}\nVITE_GAME_OF_LIFE_CONTRACT_ADDRESS=${contract}\nVITE_GAME_OF_LIFE_INDEXER_URL=https://indexer.example.test\nVITE_GAME_OF_LIFE_GAS_LIMIT=1000000000\nVITE_GAME_OF_LIFE_TARGET_GAS_LIMIT=999000000\n`,
    );
    vi.stubEnv("GAME_OF_LIFE_CONFIG", selected);
    try {
      if (typeof configuration !== "function")
        throw new Error("Expected Vite configuration factory");
      const config = await configuration({
        command: "build",
        mode: "production",
      });
      const plugins = (config.plugins ?? []).flat() as Array<{
        name?: string;
        transformIndexHtml?: () => Array<{ attrs: { content: string } }>;
      }>;
      return {
        names: plugins.map((plugin) => plugin.name),
        csp: plugins.find(
          (plugin) => plugin.name === "content-security-policy",
        )!.transformIndexHtml!()[0]!.attrs.content,
      };
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true });
    }
  }
  test("allows a remote RPC and the indexer, without a proxy", async () => {
    const { names, csp } = await policy("https://rpc.thruput.network");
    expect(csp).toContain(
      "connect-src 'self' https://indexer.example.test https://rpc.thruput.network",
    );
    expect(names).not.toContain("thruput-local-rpc");
  });
  test("proxies a local RPC same-origin", async () => {
    const { names, csp } = await policy("http://127.0.0.1:9545");
    expect(csp).toContain("connect-src 'self' https://indexer.example.test;");
    expect(names).toContain("thruput-local-rpc");
  });
});
