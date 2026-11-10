import { expect, test, vi } from "vitest";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import { loadResize, resizeWorld, recoverResize } from "./resize";
import { transactionScope } from "./records";
import { requestTick } from "./workflow";
import type { WriteBoundary } from "./write-boundary";

const config = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
};
const wallet = walletFromSeed(`0x${"01".repeat(32)}`);
const policy = {
  targetGasLimit: 10_000_000_000n,
  transactionGasLimit: 10_010_000_000n,
  expiryBlocks: 64n,
  observationTimeoutMs: 300_000,
};
const profiles = { request: policy, crank: policy };
const hash = `0x${"44".repeat(32)}`;

test("persists signed reset identity before broadcast and only observes it after reload", async () => {
  const scope = transactionScope(config, wallet.addressHex);
  const execute = vi.fn<WriteBoundary["execute"]>(
    async (_target, _policy, observer) => {
      observer.onSigned(hash);
      expect(loadResize(scope)).toMatchObject({
        hash,
        size: 100,
        status: "indeterminate",
      });
      return { kind: "indeterminate", hash, reason: "disconnect" };
    },
  );
  const observe = vi.fn<WriteBoundary["observe"]>(async () => ({
    kind: "indeterminate",
    hash,
    reason: "unknown",
  }));
  const params = { config, profiles, wallet, boundary: { execute, observe } };
  await resizeWorld(params, 100);
  await expect(resizeWorld(params, 200)).rejects.toThrow(/pending resize/);
  await expect(
    requestTick({ ...params, automaticCrank: true }),
  ).rejects.toThrow(/pending resize/);
  await recoverResize(params);
  expect(execute).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledWith(hash, policy.observationTimeoutMs);
});

test("rejects invalid sizes before signing", async () => {
  const boundary = { execute: vi.fn(), observe: vi.fn() };
  for (const size of [0, 99, 101, 10_100, NaN])
    await expect(
      resizeWorld({ config, profiles, wallet, boundary }, size),
    ).rejects.toThrow(/world size/);
  expect(boundary.execute).not.toHaveBeenCalled();
});
