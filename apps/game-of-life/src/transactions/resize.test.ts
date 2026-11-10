import { expect, test, vi } from "vitest";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import {
  loadResize,
  resizeWorld,
  recoverResize,
  resizeStorageKey,
} from "./resize";
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

test("releases an interrupted unsigned reset without submitting or observing", async () => {
  const boundary = {
    execute: vi.fn().mockRejectedValue(new Error("Interrupted")),
    observe: vi.fn(),
  };
  const params = { config, profiles, wallet, boundary };
  await expect(resizeWorld(params, 8000)).rejects.toThrow("Interrupted");
  const recovered = await recoverResize(params);
  expect(recovered).toMatchObject({
    status: "failed",
    hash: null,
    size: 8000,
    message: "Reset interrupted. Try again.",
  });
  expect(loadResize(transactionScope(config, wallet.addressHex))).toEqual(
    recovered,
  );
  expect(boundary.execute).toHaveBeenCalledOnce();
  expect(boundary.observe).not.toHaveBeenCalled();
  boundary.execute.mockResolvedValue({
    kind: "preSubmissionFailure",
    hash: null,
    message: "Offline",
  });
  await expect(resizeWorld(params, 8000)).resolves.toMatchObject({
    status: "failed",
    message: "Offline",
  });
});

test("reloads evidence after acquiring the lock instead of releasing another tab's signed reset", async () => {
  const boundary = {
    execute: vi.fn().mockRejectedValue(new Error("Interrupted")),
    observe: vi
      .fn()
      .mockResolvedValue({ kind: "indeterminate", hash, reason: "unknown" }),
  };
  const params = { config, profiles, wallet, boundary };
  await expect(resizeWorld(params, 8000)).rejects.toThrow("Interrupted");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        action: () => Promise<unknown>,
      ) => {
        await gate;
        return action();
      },
    },
  });
  const recovery = recoverResize(params);
  const scope = transactionScope(config, wallet.addressHex);
  expect(loadResize(scope)?.status).toBe("signing");
  expect(boundary.observe).not.toHaveBeenCalled();
  localStorage.setItem(
    resizeStorageKey(scope),
    JSON.stringify({ ...loadResize(scope), hash, status: "indeterminate" }),
  );
  release();
  await expect(recovery).resolves.toMatchObject({
    status: "indeterminate",
    hash,
  });
  expect(boundary.observe).toHaveBeenCalledWith(
    hash,
    policy.observationTimeoutMs,
  );
  expect(boundary.execute).toHaveBeenCalledOnce();
});

test("queued recovery leaves a terminal reset unchanged", async () => {
  const boundary = {
    execute: vi
      .fn()
      .mockResolvedValue({
        kind: "preSubmissionFailure",
        hash: null,
        message: "Offline",
      }),
    observe: vi.fn(),
  };
  const params = { config, profiles, wallet, boundary };
  const failed = await resizeWorld(params, 8000);
  await expect(recoverResize(params)).resolves.toEqual(failed);
  expect(boundary.observe).not.toHaveBeenCalled();
});
