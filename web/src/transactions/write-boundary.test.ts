import { createWalletClient, type ThruputClient } from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GameOfLife } from "@/contracts/game-of-life";
import { walletFromSeed } from "@/wallet/visitor-wallet";
import { createWriteBoundary } from "./write-boundary";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createWalletClient: vi.fn(() => ({ executeAndWait: execute })),
}));
beforeEach(() => {
  execute.mockReset();
});

describe("Life write boundary", () => {
  test("classifies a connection failure before signing as retryable", async () => {
    const wallet = walletFromSeed(`0x${"01".repeat(32)}`);
    const boundary = createWriteBoundary(
      { networkId: "00".repeat(32) },
      wallet,
      Promise.reject(new Error("RPC unavailable")),
    );
    const onSigned = vi.fn();
    await expect(
      boundary.execute(
        GameOfLife.v0_1.advance.invocation(
          wallet.account.address,
          gasAmount(100n),
        ),
        { transactionGasLimit: 200n, targetGasLimit: 100n },
        { onSigned },
      ),
    ).resolves.toEqual({
      kind: "preSubmissionFailure",
      message: "RPC unavailable",
    });
    expect(onSigned).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  test("passes separate root and child budgets to the official wallet", async () => {
    const wallet = walletFromSeed(`0x${"01".repeat(32)}`);
    execute.mockRejectedValue(new Error("Preparation failed"));
    const boundary = createWriteBoundary(
      { networkId: "00".repeat(32) },
      wallet,
      {} as ThruputClient,
    );
    const invocation = GameOfLife.v0_1.advance.invocation(
      wallet.account.address,
      gasAmount(999_000_000n),
    );
    const result = await boundary.execute(
      invocation,
      {
        transactionGasLimit: 1_000_000_000n,
        targetGasLimit: 999_000_000n,
      },
      { onSigned: vi.fn() },
    );
    expect(execute).toHaveBeenCalledWith(
      { invocation, gasLimit: 1_000_000_000n, expiryBlocks: 32n },
      { timeoutMs: 20_000 },
    );
    expect(invocation.gas_limit).toBe(999_000_000n);
    expect(result.kind).toBe("preSubmissionFailure");
  });
  describe("saving signed evidence before broadcast", () => {
    const wallet = walletFromSeed(`0x${"01".repeat(32)}`);
    const signed = {
      transactionHash: new Uint8Array(32).fill(0x44),
      signedTransaction: new Uint8Array([1, 2]),
    };
    const evidence = {
      transactionHash: `0x${"44".repeat(32)}`,
      signedTransaction: "0x0102",
    };
    function run(onSigned: () => void, afterSigned: Error) {
      // The SDK awaits onSigned and broadcasts only if it returns.
      execute.mockImplementation(async () => {
        await vi.mocked(createWalletClient).mock.lastCall![0].onSigned!(
          signed as never,
        );
        throw afterSigned;
      });
      return createWriteBoundary(
        { networkId: "00".repeat(32) },
        wallet,
        {} as ThruputClient,
      ).execute(
        GameOfLife.v0_1.advance.invocation(
          wallet.account.address,
          gasAmount(100n),
        ),
        { transactionGasLimit: 200n, targetGasLimit: 100n },
        { onSigned },
      );
    }
    test("a failed save is retryable because nothing was broadcast", async () => {
      await expect(
        run(() => {
          throw new Error("Storage is full");
        }, new Error("unreachable")),
      ).resolves.toEqual({
        kind: "preSubmissionFailure",
        message: "Storage is full",
      });
    });
    test("a failure after the save keeps the evidence for observation", async () => {
      const onSigned = vi.fn();
      await expect(
        run(onSigned, new Error("Connection reset")),
      ).resolves.toEqual({
        kind: "indeterminate",
        evidence,
        message: "Connection reset",
      });
      expect(onSigned).toHaveBeenCalledWith(evidence);
    });
  });
});
