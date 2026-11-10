// @vitest-environment node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  addressFromHex,
  createThruputClient,
  createWalletClient,
  gasAmount,
  localnet,
  toBase58,
  toHex0x,
  TransactionExecutionError,
} from "@thruputchain/client";
import { describe, expect, test } from "vitest";
import { localAccounts, localRoot, rpcUrl } from "../../scripts/local-accounts";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
} from "@/contracts/game-of-life";

describe.skipIf(process.env.RUN_GAME_OF_LIFE_LOCAL_INTEGRATION !== "1")(
  "live atomic world",
  () => {
    test("failed crank preserves the world and admitted request; another caller can complete it", async () => {
      const env = parseEnv(await readFile(".env.local", "utf8"));
      const address = addressFromHex(env.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS!);
      const client = await createThruputClient({
        cluster: localnet({ rpcUrl }),
      });
      const accounts = await localAccounts();
      const wallets = accounts.map(({ account }) =>
        createWalletClient({
          client,
          account,
          onSigned: async (evidence) =>
            writeFile(
              resolve(
                localRoot,
                `test-${toBase58(evidence.transactionHash)}.json`,
              ),
              JSON.stringify({
                transactionHash: toBase58(evidence.transactionHash),
                networkHash: toBase58(evidence.networkHash),
                signedTransaction: toHex0x(evidence.signedTransaction),
              }),
              { mode: 0o600, flag: "wx" },
            ),
        }),
      );
      const before = (
        await GameOfLife.v0_1.getMetadata.view({ client, address })
      ).value;
      const admission = await wallets[0]!.executeAndWait({
        invocation: GameOfLife.v0_1.requestTick.invocation(
          address,
          gasAmount(1_000_000n),
        ),
        gasLimit: gasAmount(2_000_000n),
      });
      const requested = TickRequested.singleFromReceipt(admission.receipt, {
        address,
      });
      await expect(
        wallets[1]!.executeAndWait({
          invocation: GameOfLife.v0_1.resize.invocation(
            address,
            gasAmount(1_000_000n),
            { size: 100n },
          ),
          gasLimit: gasAmount(2_000_000n),
        }),
      ).rejects.toBeInstanceOf(TransactionExecutionError);
      expect(
        (await GameOfLife.v0_1.getMetadata.view({ client, address })).value,
      ).toEqual(before);
      await expect(
        wallets[1]!.executeAndWait({
          invocation: GameOfLife.v0_1.processNextTick.invocation(
            address,
            gasAmount(100_000n),
          ),
          gasLimit: gasAmount(2_000_000n),
        }),
      ).rejects.toBeInstanceOf(TransactionExecutionError);
      expect(
        (await GameOfLife.v0_1.getMetadata.view({ client, address })).value,
      ).toEqual(before);
      const completed = await wallets[1]!.executeAndWait(
        {
          invocation: GameOfLife.v0_1.processNextTick.invocation(
            address,
            gasAmount(10_000_000_000n),
          ),
          gasLimit: gasAmount(10_010_000_000n),
          expiryBlocks: 64n,
        },
        { timeoutMs: 300_000 },
      );
      const event = GenerationAdvanced.singleFromReceipt(completed.receipt, {
        address,
      });
      expect(event.topics.request_id).toEqual(requested.topics.request_id);
      expect(event.fields.requested_by).toEqual(accounts[0]!.account.address);
      expect(event.fields.generation).toBe(before.generation + 1n);
      const after = (
        await GameOfLife.v0_1.getMetadata.view({ client, address })
      ).value;
      const empty = await wallets[2]!.executeCallsAndWait({
        calls: [
          GameOfLife.v0_1.processNextTick.call({
            address,
            gasLimit: gasAmount(1_000_000n),
          }),
        ],
        gasLimit: gasAmount(2_000_000n),
      });
      expect(empty.values).toEqual([null]);
      expect(
        (await GameOfLife.v0_1.getMetadata.view({ client, address })).value,
      ).toEqual(after);
      await expect(
        GameOfLife.v0_1.getCell.view({
          client,
          address,
          args: { x: 10_000n, y: 0n },
        }),
      ).rejects.toThrow();
      await expect(
        wallets[0]!.executeAndWait({
          invocation: GameOfLife.v0_1.initialize.invocation(
            address,
            gasAmount(1_000_000n),
            { seed: 1n, maxQueueLen: 64n },
          ),
          gasLimit: gasAmount(2_000_000n),
        }),
      ).rejects.toBeInstanceOf(TransactionExecutionError);
      await wallets[0]!.executeAndWait({
        invocation: GameOfLife.v0_1.resize.invocation(
          address,
          gasAmount(10_000_000_000n),
          { size: 100n },
        ),
        gasLimit: gasAmount(10_010_000_000n),
        expiryBlocks: 64n,
      });
      const reset = (
        await GameOfLife.v0_1.getMetadata.view({ client, address })
      ).value;
      expect(reset.epoch).toBe(before.epoch + 1n);
      expect(reset.generation).toBe(0n);
      expect(reset.seed).toBe(before.seed);
      await expect(
        wallets[0]!.executeAndWait({
          invocation: GameOfLife.v0_1.resize.invocation(
            address,
            gasAmount(1_000_000n),
            { size: 101n },
          ),
          gasLimit: gasAmount(2_000_000n),
        }),
      ).rejects.toBeInstanceOf(TransactionExecutionError);
      const chunk = (
        await GameOfLife.v0_1.getChunk.view({
          client,
          address,
          args: { row: 0n, part: 0n },
        })
      ).value;
      await expect(
        wallets[0]!.executeAndWait({
          invocation: GameOfLife.v0_1.resize.invocation(
            address,
            gasAmount(1_000_000n),
            { size: 10_000n },
          ),
          gasLimit: gasAmount(2_000_000n),
        }),
      ).rejects.toBeInstanceOf(TransactionExecutionError);
      expect(
        (await GameOfLife.v0_1.getMetadata.view({ client, address })).value,
      ).toEqual(reset);
      expect(
        (
          await GameOfLife.v0_1.getChunk.view({
            client,
            address,
            args: { row: 0n, part: 0n },
          })
        ).value,
      ).toEqual(chunk);
    }, 420_000);
  },
);
