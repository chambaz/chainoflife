// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import configuration from "./vite.config";
import { configurationEnvironment } from "./scripts/configuration.mjs";
import {
  allowedIndexerRoute,
  isIndexerArtifactNotFound,
  isAllowedRpcRequest,
  isSameOriginLoopback,
  indexerProxyScope,
  validateIndexerTarget,
  validateRpcTarget,
} from "./scripts/proxy";
const network = "11".repeat(32);
const contract = `0x${"22".repeat(32)}`;

test("selected app configuration excludes inherited and default environment values", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(".tmp/life-config-");
  const selected = join(directory, "selected.env");
  await writeFile(
    selected,
    `VITE_THRUPUT_RPC_URL=https://rpc.thruput.network\nVITE_THRUPUT_NETWORK_ID=${network}\nVITE_GAME_OF_LIFE_CONTRACT_ADDRESS=${contract}\nVITE_GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787\nVITE_GAME_OF_LIFE_GAS_LIMIT=950000000\nVITE_GAME_OF_LIFE_TARGET_GAS_LIMIT=945000000\n`,
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
  test.each([
    "https://rpc.example.test/#fragment",
    "file:///rpc",
    "http://user:pass@127.0.0.1",
  ])("rejects unsafe target %s", (target) =>
    expect(() => validateRpcTarget(target)).toThrow(/credential-free/),
  );
});

describe("read-only indexer proxy policy", () => {
  test("preserves only an upstream not-found status", () => {
    expect(isIndexerArtifactNotFound(404)).toBe(true);
    expect(isIndexerArtifactNotFound(400)).toBe(false);
    expect(isIndexerArtifactNotFound(500)).toBe(false);
  });
  test("normalizes optional-0x uppercase network env before routing", () => {
    const scope = indexerProxyScope({
      VITE_THRUPUT_NETWORK_ID: `0x${"AA".repeat(32)}`,
      VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: contract,
    });
    expect(scope.networkId).toBe("aa".repeat(32));
    expect(
      allowedIndexerRoute(
        `/v1/worlds/${"aa".repeat(32)}/${contract}/latest.json`,
        scope.networkId,
        scope.contractAddress,
      ),
    ).not.toBeNull();
  });
  test.each([
    `/v1/worlds/${network}/${contract}/latest.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/manifest.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/provenance.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/tiles/6/39/39.bin`,
  ])("allows configured artifact %s", (path) =>
    expect(allowedIndexerRoute(path, network, contract)).not.toBeNull(),
  );

  test.each([
    `/v1/worlds/${network}/${contract}/latest.json?redirect=x`,
    `/v1/worlds/${network}/${contract}/../status.json`,
    `/v1/worlds/${network}/${contract}/status.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/tiles/6/40/0.bin`,
    `/v1/worlds/${"33".repeat(32)}/${contract}/latest.json`,
  ])("rejects non-canonical artifact %s", (path) =>
    expect(allowedIndexerRoute(path, network, contract)).toBeNull(),
  );

  test("rejects non-loopback upstreams", () =>
    expect(() => validateIndexerTarget("https://indexer.example.test")).toThrow(
      /loopback/,
    ));
  test.each([
    "http://127.0.0.1:8787/root/",
    "http://127.0.0.1:8787/?world=life",
    "http://127.0.0.1:8787/#life",
  ])("rejects non-root upstream %s", (target) =>
    expect(() => validateIndexerTarget(target)).toThrow(/origin root/),
  );
});
