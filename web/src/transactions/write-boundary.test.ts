import type { ThruputClient } from "@thruputchain/client";
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
      gasAmount(10_000_000_000n),
    );
    const result = await boundary.execute(
      invocation,
      {
        transactionGasLimit: 10_010_000_000n,
        targetGasLimit: 10_000_000_000n,
      },
      { onSigned: vi.fn() },
    );
    expect(execute).toHaveBeenCalledWith(
      { invocation, gasLimit: 10_010_000_000n, expiryBlocks: 32n },
      { timeoutMs: 20_000 },
    );
    expect(invocation.gas_limit).toBe(10_000_000_000n);
    expect(result.kind).toBe("preSubmissionFailure");
  });
});
