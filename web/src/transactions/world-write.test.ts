import { describe, expect, test, vi } from "vitest";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import type { WriteBoundary } from "./write-boundary";
import {
  loadWrite,
  recoverWrite,
  submitWrite,
  writeScope,
  writeStorageKey,
} from "./world-write";

const config = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  transactionPolicy: {
    transactionGasLimit: 10_010_000_000n,
    targetGasLimit: 10_000_000_000n,
  },
};
const wallet = walletFromSeed(`0x${"01".repeat(32)}`);
const scope = writeScope(config, wallet);
const hash = `0x${"44".repeat(32)}`;

function boundary(overrides: Partial<WriteBoundary> = {}): WriteBoundary {
  return { execute: vi.fn(), observe: vi.fn(), ...overrides };
}

function store(value: unknown) {
  localStorage.setItem(writeStorageKey(scope), JSON.stringify(value));
}

describe("world writes", () => {
  test("saves the hash as indeterminate before broadcast", async () => {
    const execute = vi.fn<WriteBoundary["execute"]>(
      async (_target, _policy, observer) => {
        observer.onSigned(hash);
        expect(loadWrite(scope)).toEqual({
          kind: "advance",
          status: "indeterminate",
          transactionHash: hash,
        });
        return { kind: "indeterminate", hash, message: "Disconnected" };
      },
    );
    await expect(
      submitWrite(
        { config, wallet, boundary: boundary({ execute }) },
        { kind: "advance" },
      ),
    ).resolves.toEqual({
      kind: "advance",
      status: "indeterminate",
      transactionHash: hash,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![1]).toBe(config.transactionPolicy);
  });

  test("allows one pending write per wallet", async () => {
    store({ kind: "advance", status: "indeterminate", transactionHash: hash });
    const writes = boundary();
    await expect(
      submitWrite(
        { config, wallet, boundary: writes },
        { kind: "resize", size: 100 },
      ),
    ).rejects.toThrow(/pending transaction/);
    expect(writes.execute).not.toHaveBeenCalled();
  });

  test("explains a committed advance failure", async () => {
    const execute = vi.fn<WriteBoundary["execute"]>(async () => ({
      kind: "committedFailure",
      hash,
    }));
    await expect(
      submitWrite(
        { config, wallet, boundary: boundary({ execute }) },
        { kind: "advance" },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      message: "The advance failed on-chain. Try again.",
    });
  });

  test("fails a hashless signing write under the lock without observing", async () => {
    store({ kind: "resize", size: 800, status: "signing" });
    const writes = boundary();
    await expect(
      recoverWrite({ config, wallet, boundary: writes }),
    ).resolves.toEqual({
      kind: "resize",
      size: 800,
      status: "failed",
      message: "Signing was interrupted. Try again.",
    });
    expect(writes.observe).not.toHaveBeenCalled();
    expect(writes.execute).not.toHaveBeenCalled();
  });

  test("observes a signed write by its original hash and never signs", async () => {
    store({ kind: "advance", status: "indeterminate", transactionHash: hash });
    const writes = boundary({
      observe: vi.fn(async (observed) => ({
        kind: "invalid" as const,
        hash: observed,
        message: "expired",
      })),
    });
    await expect(
      recoverWrite({ config, wallet, boundary: writes }),
    ).resolves.toEqual({
      kind: "advance",
      status: "failed",
      message: "expired",
    });
    expect(writes.observe).toHaveBeenCalledWith(hash);
    expect(writes.execute).not.toHaveBeenCalled();
  });

  test("rejects malformed stored evidence", () => {
    store({ kind: "advance", status: "committed", transactionHash: "0x1" });
    expect(() => loadWrite(scope)).toThrow(/invalid/);
  });
});
