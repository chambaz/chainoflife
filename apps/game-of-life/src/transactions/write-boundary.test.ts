import {
  createPubkeyAccount,
  Ed25519Signer,
  fromHex0x,
  toHex0x,
  type ThruputClient,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GameOfLife } from "@/contracts/game-of-life";
import { parseDevelopmentPersonas } from "@/development-personas";
import { createLocalWriteBoundary } from "./write-boundary";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createWalletClient: vi.fn(() => ({ executeAndWait: execute })),
}));
beforeEach(() => {
  execute.mockReset();
});

describe("Life write boundary", () => {
  test("passes separate root and child budgets to the official wallet", async () => {
    const persona = parseDevelopmentPersonas(
      JSON.stringify(
        ["alice", "bob", "carol"].map((id, index) => {
          const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}`;
          const signer = Ed25519Signer.fromSeed(fromHex0x(privateKey));
          const walletRoot = toHex0x(createPubkeyAccount({ signer }).address);
          return {
            id,
            label: id,
            privateKey,
            signerPublicKey: toHex0x(signer.publicKey.ed25519),
            walletRoot,
            walletEntrypoint: "0x0000000000000000",
            expectedCaller: walletRoot,
            callerVerified: true,
          };
        }),
      ),
    )![0]!;
    execute.mockRejectedValue(new Error("Preparation failed"));
    const boundary = createLocalWriteBoundary(
      { networkId: "00".repeat(32) },
      persona,
      {} as ThruputClient,
    );
    const invocation = GameOfLife.v0_1.processNextTick.invocation(
      persona.walletRoot,
      gasAmount(10_000_000_000n),
    );
    const result = await boundary.execute(
      invocation,
      {
        transactionGasLimit: 10_010_000_000n,
        targetGasLimit: 10_000_000_000n,
        expiryBlocks: 64n,
        observationTimeoutMs: 300_000,
      },
      { onSigned: vi.fn() },
    );
    expect(execute).toHaveBeenCalledWith(
      { invocation, gasLimit: 10_010_000_000n, expiryBlocks: 64n },
      { timeoutMs: 300_000 },
    );
    expect(invocation.gas_limit).toBe(10_000_000_000n);
    expect(result.kind).toBe("preSubmissionFailure");
  });
});
