import { describe, expect, test } from "vitest";
import { ConfigurationError, loadAppConfig } from "./config";

const valid = {
  VITE_THRUPUT_RPC_URL: "http://127.0.0.1:9545",
  VITE_THRUPUT_NETWORK_ID: `0x${"AA".repeat(32)}`,
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"bb".repeat(32)}`,
  VITE_GAME_OF_LIFE_INDEXER_URL: "http://localhost:8787/",
  VITE_GAME_OF_LIFE_GAS_LIMIT: "1000000000",
  VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT: "999000000",
};
describe("startup configuration", () => {
  test("normalizes only the network ID and freezes the result", () => {
    const config = loadAppConfig(valid);
    expect(config.networkId).toBe("aa".repeat(32));
    expect(config.contractAddress).toBe(`0x${"bb".repeat(32)}`);
    expect(Object.isFrozen(config)).toBe(true);
  });
  test.each(["file:///tmp/rpc", "http://user:pass@localhost:1"])(
    "rejects unsafe URL %s",
    (url) =>
      expect(() =>
        loadAppConfig({ ...valid, VITE_THRUPUT_RPC_URL: url }),
      ).toThrow(ConfigurationError),
  );
  test("requires canonical lowercase contract addresses", () =>
    expect(() =>
      loadAppConfig({
        ...valid,
        VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"BB".repeat(32)}`,
      }),
    ).toThrow(/canonical lowercase/));
  test.each([
    "http://localhost:8787/root/",
    "http://localhost:8787/?world=life",
    "http://localhost:8787/#life",
  ])("rejects non-root indexer URL %s", (url) =>
    expect(() =>
      loadAppConfig({ ...valid, VITE_GAME_OF_LIFE_INDEXER_URL: url }),
    ).toThrow(/origin root/),
  );
  test("requires every public configuration value", () =>
    expect(() =>
      loadAppConfig({ ...valid, VITE_GAME_OF_LIFE_INDEXER_URL: undefined }),
    ).toThrow(/required/));
  test("loads the world-write gas budget", () =>
    expect(loadAppConfig(valid).transactionPolicy).toEqual({
      transactionGasLimit: 1_000_000_000n,
      targetGasLimit: 999_000_000n,
    }));
  test("rejects a target budget above the transaction budget", () =>
    expect(() =>
      loadAppConfig({
        ...valid,
        VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT: "1000000001",
      }),
    ).toThrow(/must not exceed/));
});
