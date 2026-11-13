import { describe, expect, test, vi } from "vitest";
import type { LifeTransactionProfiles } from "@/config";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import {
  loadCranks,
  loadRequests,
  saveCranks,
  saveRequests,
  transactionScope,
} from "./records";
import type { WriteBoundary } from "./write-boundary";
import { advance, recoverCrank, recoverRequest } from "./workflow";

const config = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
};
const wallet = walletFromSeed(`0x${"01".repeat(32)}`);
const profiles: LifeTransactionProfiles = {
  request: {
    transactionGasLimit: 100_000n,
    targetGasLimit: 100_000n,
    expiryBlocks: 64n,
    observationTimeoutMs: 30_000,
  },
  crank: {
    transactionGasLimit: 10_010_000_000n,
    targetGasLimit: 10_000_000_000n,
    expiryBlocks: 2n,
    observationTimeoutMs: 300_000,
  },
};
const scope = transactionScope(config, wallet.addressHex);
const hash = `0x${"44".repeat(32)}`;

describe("request and crank workflow", () => {
  test("saves the hash as indeterminate before broadcast and never auto-cranks it", async () => {
    const execute = vi.fn<WriteBoundary["execute"]>(
      async (_target, _policy, observer) => {
        observer.onSigned(hash);
        expect(loadRequests(scope)[0]).toMatchObject({
          status: "indeterminate",
          transactionHash: hash,
        });
        return { kind: "indeterminate", hash, message: "Disconnected" };
      },
    );
    const result = await advance({
      config,
      profiles,
      wallet,
      boundary: { execute, observe: vi.fn() },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.requests[0]).toMatchObject({
      status: "indeterminate",
      transactionHash: hash,
    });
    expect(result.cranks).toEqual([]);
    expect(result.message).toBe("Disconnected");
  });

  test("cranks an accepted request instead of requesting another tick", async () => {
    saveRequests(scope, [
      {
        localId: "accepted",
        status: "accepted",
        transactionHash: hash,
        requestId: `0x${"55".repeat(32)}`,
        epoch: "0",
        receiptBlock: "7",
        observedThroughBlock: null,
      },
    ]);
    const execute = vi.fn<WriteBoundary["execute"]>(async () => ({
      kind: "preSubmissionFailure",
      message: "Offline",
    }));
    const result = await advance({
      config,
      profiles,
      wallet,
      boundary: { execute, observe: vi.fn() },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![1]).toBe(profiles.crank);
    expect(result.requests).toHaveLength(1);
    expect(result.cranks[0]).toMatchObject({ status: "failed" });
    expect(result.message).toBe("Offline");
  });

  test("refuses a duplicate local crank while an outcome is indeterminate", async () => {
    saveRequests(scope, [
      {
        localId: "accepted",
        status: "accepted",
        transactionHash: hash,
        requestId: `0x${"55".repeat(32)}`,
        epoch: "0",
        receiptBlock: "7",
        observedThroughBlock: null,
      },
    ]);
    saveCranks(scope, [
      { localId: "crank", status: "indeterminate", transactionHash: hash },
    ]);
    const boundary: WriteBoundary = { execute: vi.fn(), observe: vi.fn() };
    await expect(
      advance({ config, profiles, wallet, boundary }),
    ).rejects.toThrow(/existing crank/);
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  test("fails hashless signing records under the lock without observing", async () => {
    saveRequests(scope, [{ localId: "request", status: "signing" }]);
    saveCranks(scope, [{ localId: "crank", status: "signing" }]);
    const boundary: WriteBoundary = { execute: vi.fn(), observe: vi.fn() };
    const params = { config, profiles, wallet, boundary };
    await expect(recoverRequest(params, "request")).resolves.toMatchObject({
      message: "Signing was interrupted. Try again.",
    });
    await expect(recoverCrank(params, "crank")).resolves.toMatchObject({
      message: "Signing was interrupted. Try again.",
    });
    expect(loadRequests(scope)).toEqual([
      { localId: "request", status: "failed", transactionHash: null },
    ]);
    expect(loadCranks(scope)).toEqual([
      { localId: "crank", status: "failed", transactionHash: null },
    ]);
    expect(boundary.observe).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  test("observes signed request and crank records by their original hash", async () => {
    const crankHash = `0x${"88".repeat(32)}`;
    saveRequests(scope, [
      { localId: "request", status: "indeterminate", transactionHash: hash },
    ]);
    saveCranks(scope, [
      { localId: "crank", status: "indeterminate", transactionHash: crankHash },
    ]);
    const boundary: WriteBoundary = {
      execute: vi.fn(),
      observe: vi.fn(async (observed) => ({
        kind: "invalid" as const,
        hash: observed,
        message: "expired",
      })),
    };
    const params = { config, profiles, wallet, boundary };
    await recoverRequest(params, "request");
    await recoverCrank(params, "crank");
    expect(boundary.observe).toHaveBeenNthCalledWith(1, hash);
    expect(boundary.observe).toHaveBeenNthCalledWith(2, crankHash);
    expect(loadRequests(scope)[0]?.status).toBe("failed");
    expect(loadCranks(scope)[0]?.status).toBe("failed");
    expect(boundary.execute).not.toHaveBeenCalled();
  });
});
