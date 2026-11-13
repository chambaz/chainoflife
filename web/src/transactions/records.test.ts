import { describe, expect, test, vi } from "vitest";
import {
  crankStorageKey,
  loadCranks,
  loadRequests,
  requestStorageKey,
  saveCranks,
  saveRequests,
  transactionLockName,
  withTransactionLock,
  type AcceptedRequest,
  type CrankRecord,
  type TickRequestRecord,
  type TransactionScope,
} from "./records";

const scope: TransactionScope = {
  networkId: "11".repeat(32),
  expectedCaller: `0x${"22".repeat(32)}`,
  contractAddress: `0x${"33".repeat(32)}`,
};

describe("transaction records", () => {
  test("persists requests and cranks independently in the full scope", () => {
    saveRequests(scope, [request()]);
    saveCranks(scope, [crank()]);
    expect(loadRequests(scope)).toHaveLength(1);
    expect(loadCranks(scope)).toHaveLength(1);
    expect(requestStorageKey(scope)).not.toBe(crankStorageKey(scope));
    expect(transactionLockName(scope)).toContain(scope.contractAddress);
    expect(transactionLockName(scope)).toContain(scope.expectedCaller);
  });

  test("preserves malformed storage and fails closed", () => {
    localStorage.setItem(requestStorageKey(scope), "not-json");
    expect(() => loadRequests(scope)).toThrow(/invalid/);
    expect(localStorage.getItem(requestStorageKey(scope))).toBe("not-json");
  });

  test("rejects records that contradict their lifecycle", () => {
    const { requestId: _requestId, ...missingRequestId } = request();
    expect(() =>
      saveRequests(scope, [missingRequestId as TickRequestRecord]),
    ).toThrow(/invalid/);
    expect(() =>
      saveRequests(scope, [
        { ...request(), observedThroughBlock: "6" } as TickRequestRecord,
      ]),
    ).toThrow(/invalid/);
    expect(() =>
      saveCranks(scope, [
        { localId: "crank", status: "indeterminate" } as CrankRecord,
      ]),
    ).toThrow(/invalid/);
  });

  test("keeps pending records and the newest 50 terminal records", () => {
    const terminal = Array.from({ length: 52 }, (_, index) => ({
      localId: `crank-${index}`,
      status: "noWork" as const,
      transactionHash: null,
    }));
    const saved = saveCranks(scope, [
      terminal[0]!,
      { localId: "pending", status: "signing" },
      ...terminal.slice(1),
    ]);
    expect(saved).toHaveLength(51);
    expect(saved[0]).toEqual({ localId: "pending", status: "signing" });
    expect(saved[1]?.localId).toBe("crank-2");
  });

  test("uses an exclusive Web Lock", async () => {
    const action = vi.fn(async () => 7);
    await expect(withTransactionLock(scope, action)).resolves.toBe(7);
    expect(action).toHaveBeenCalledOnce();
  });
});

function request(): AcceptedRequest {
  return {
    localId: "request-1",
    status: "accepted",
    transactionHash: `0x${"44".repeat(32)}`,
    requestId: `0x${"55".repeat(32)}`,
    epoch: "0",
    receiptBlock: "7",
    observedThroughBlock: null,
  };
}

function crank(): CrankRecord {
  return {
    localId: "crank-1",
    status: "noWork",
    transactionHash: `0x${"66".repeat(32)}`,
  };
}
