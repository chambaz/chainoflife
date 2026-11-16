// @vitest-environment node
import { describe, expect, test } from "vitest";
import { deploymentConfig } from "../../scripts/deployment-config";

describe("deployment presets", () => {
  test("separates local and public worlds and evidence", () => {
    const local = deploymentConfig([], {});
    const remote = deploymentConfig(["--preset", "futurenet"], {});
    expect(local).toMatchObject({
      mode: "configurable",
      size: 10000,
      gasLimit: 1_000_000_000n,
      targetGasLimit: 999_000_000n,
    });
    expect(remote).toMatchObject({
      preset: "futurenet",
      mode: "fixed",
      size: 10000,
      manifest: null,
      gasLimit: 1_000_000_000n,
      targetGasLimit: 999_000_000n,
    });
    expect(remote.output).not.toBe(local.output);
    expect(remote.stateDir).not.toBe(local.stateDir);
  });
  test("explicit flags override presets", () => {
    expect(
      deploymentConfig(
        [
          "--preset",
          "futurenet",
          "--mode",
          "configurable",
          "--size",
          "100",
          "--seed",
          "42",
          "--rpc-url",
          "http://127.0.0.1:9546",
        ],
        {},
      ),
    ).toMatchObject({
      mode: "configurable",
      size: 100,
      seed: "42",
      rpcUrl: "http://127.0.0.1:9546",
    });
  });
  test.each([
    ["--preset", "devnet"],
    ["--size", "101"],
    ["--seed", "-1"],
    ["--mode", "unknown"],
    ["--rpc-url", "file:///rpc"],
  ])("rejects invalid flags %s %s", (...args) => {
    expect(() => deploymentConfig(args, {})).toThrow();
  });
});
