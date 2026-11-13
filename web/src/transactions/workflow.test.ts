import { describe, expect, test, vi } from "vitest";
import type { LifeTransactionProfiles } from "@/config";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import {
  loadCranks,
  loadRequests,
  saveCranks,
  saveRequests,
  transactionScope,
  type CrankRecord,
  type TickRequestRecord,
} from "./records";
import type { WriteBoundary } from "./write-boundary";
import {
  abandonUnsignedCrank,
  abandonUnsignedRequest,
  processOneTick,
  recoverCrank,
  recoverRequest,
  requestTick,
} from "./workflow";

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

describe("request and crank workflow", () => {
  test("persists the canonical hash and never auto-cranks an indeterminate request", async () => {
    const execute = vi.fn<WriteBoundary["execute"]>(
      async (_target, _policy, observer) => {
        const hash = `0x${"44".repeat(32)}`;
        observer.onSigned(hash);
        return { kind: "indeterminate", hash, reason: "disconnect" };
      },
    );
    const result = await requestTick({
      config,
      profiles,
      wallet,
      boundary: { execute, observe: vi.fn() },
      automaticCrank: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.requests[0]).toMatchObject({
      status: "indeterminate",
      transactionHash: `0x${"44".repeat(32)}`,
    });
    expect(result.cranks).toEqual([]);
  });

  test("refuses a duplicate local crank while an outcome is indeterminate", async () => {
    const scope = transactionScope(config, wallet.addressHex);
    saveCranks(scope, [crank(wallet.addressHex)]);
    const boundary: WriteBoundary = {
      execute: vi.fn(),
      observe: vi.fn(),
    };
    await expect(
      processOneTick({ config, profiles, wallet, boundary }),
    ).rejects.toThrow(/existing crank/);
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  test("requires explicit confirmation before abandoning hashless signing", async () => {
    const scope = transactionScope(config, wallet.addressHex);
    saveRequests(scope, [unsigned(wallet.addressHex)]);
    await abandonUnsignedRequest({ config, wallet, localId: "unsigned" });
    expect(loadRequests(scope)[0]).toMatchObject({
      status: "failed",
      diagnostic: "User confirmed that signing did not complete",
    });
    expect(loadCranks(scope)).toEqual([]);
  });

  test("recovers signed request and crank records after reload", async () => {
    const scope = transactionScope(config, wallet.addressHex);
    const requestRecord = {
      ...unsigned(wallet.addressHex),
      transactionHash: `0x${"77".repeat(32)}`,
    };
    saveRequests(scope, [requestRecord]);
    saveCranks(scope, [
      {
        ...crank(wallet.addressHex),
        status: "signing",
        transactionHash: `0x${"88".repeat(32)}`,
        diagnostic: null,
      },
    ]);
    const boundary: WriteBoundary = {
      execute: vi.fn(),
      observe: vi.fn(async (hash) => ({
        kind: "invalid" as const,
        hash,
        reason: "expired",
      })),
    };
    await recoverRequest({
      config,
      profiles,
      wallet,
      boundary,
      localId: "unsigned",
    });
    await recoverCrank({
      config,
      profiles,
      wallet,
      boundary,
      localId: "crank",
    });
    expect(loadRequests(scope)[0]?.status).toBe("invalid");
    expect(loadCranks(scope)[0]?.status).toBe("invalid");
  });

  test("requires explicit confirmation before abandoning a hashless crank", async () => {
    const scope = transactionScope(config, wallet.addressHex);
    saveCranks(scope, [
      {
        ...crank(wallet.addressHex),
        status: "signing",
        transactionHash: null,
        diagnostic: null,
      },
    ]);
    await abandonUnsignedCrank({ config, wallet, localId: "crank" });
    expect(loadCranks(scope)[0]).toMatchObject({
      status: "failed",
      diagnostic: "User confirmed that signing did not complete",
    });
  });
});

function crank(caller: string): CrankRecord {
  return {
    schemaVersion: 1,
    localId: "crank",
    submittedBy: caller,
    status: "indeterminate",
    transactionHash: `0x${"55".repeat(32)}`,
    submittedAt: "2026-08-29T00:00:00.000Z",
    completedAt: null,
    receiptBlock: null,
    consumedRequestId: null,
    resultingGeneration: null,
    resultingPopulation: null,
    resultingStateDigest: null,
    diagnostic: "timeout",
  };
}

function unsigned(caller: string): TickRequestRecord {
  return {
    schemaVersion: 1,
    localId: "unsigned",
    requester: caller,
    status: "signing",
    transactionHash: null,
    requestId: null,
    receiptBlock: null,
    submittedAt: "2026-08-29T00:00:00.000Z",
    acceptedAt: null,
    observedThroughBlock: null,
    resultingGeneration: null,
    resultingPopulation: null,
    resultingStateDigest: null,
    advancedTransactionHash: null,
    diagnostic: null,
  };
}
