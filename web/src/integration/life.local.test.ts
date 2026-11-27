// @vitest-environment node
import {
  addressFromHex,
  gasAmount,
  isThruputError,
  prepareContractDeployment,
  toHex0x,
  type ContractAddress,
  type TransactionReceipt,
} from "@thruputchain/client";
import { beforeAll, describe, expect, test } from "vitest";
import { GameOfLife, GenerationAdvanced } from "@/contracts/game-of-life";
import {
  advance,
  contractArtifact,
  deployAndInitialize,
  referenceWorlds,
  type GasBudget,
} from "../../../scripts/world";
import { deployedEnvironment, fundedTestAccounts } from "./test-accounts";

type Harness = Awaited<ReturnType<typeof fundedTestAccounts>>;
type TestWallet = Harness["accounts"][number]["wallet"];

// Enough for any operation on a 100- or 200-cell world.
const smallGas: GasBudget = { root: 50_000_000n, target: 45_000_000n };
const smallDeposit = 100_000_000n;
const underGassed: GasBudget = { root: 2_000_000n, target: 100_000n };

// A transaction that committed and then failed on-chain.
const COMMITTED_FAILURE = { name: "ThruputError", code: "transactionFailed" };

describe.skipIf(process.env.RUN_GAME_OF_LIFE_LOCAL_INTEGRATION !== "1")(
  "live atomic world",
  () => {
    let harness: Harness;
    let deployed: ContractAddress;
    let deployedGas: GasBudget;

    beforeAll(async () => {
      harness = await fundedTestAccounts(3);
      const env = await deployedEnvironment();
      deployed = addressFromHex(env.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS!);
      deployedGas = {
        root: BigInt(env.VITE_GAME_OF_LIFE_GAS_LIMIT!),
        target: BigInt(env.VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT!),
      };
    }, 300_000);

    const metadata = async (address: ContractAddress) =>
      (
        await GameOfLife.v0_1.getMetadata.view({
          client: harness.client,
          address,
        })
      ).value;
    // A receipt can be visible before the read endpoint serves its block.
    const pollMetadata = (address: ContractAddress) =>
      expect.poll(() => metadata(address), { timeout: 30_000 });
    const advancedEvent = (
      receipt: TransactionReceipt,
      address: ContractAddress,
    ) => {
      const event = GenerationAdvanced.singleFromReceipt(receipt, { address });
      expect(event).toBeTruthy();
      return event!;
    };
    const resize = (
      wallet: TestWallet,
      address: ContractAddress,
      size: bigint,
      gas: GasBudget,
    ) =>
      wallet.executeAndWait(
        {
          invocation: GameOfLife.v0_1.resize.invocation(
            address,
            gasAmount(gas.target),
            { size },
          ),
          gasLimit: gasAmount(gas.root),
          expiryBlocks: 64n,
        },
        { timeoutMs: 1_200_000 },
      );
    const initialize = (
      wallet: TestWallet,
      address: ContractAddress,
      size: bigint,
      resizable: boolean,
    ) =>
      wallet.executeAndWait({
        invocation: GameOfLife.v0_1.initialize.invocation(
          address,
          gasAmount(smallGas.target),
          { seed: 42n, size, resizable },
        ),
        gasLimit: gasAmount(smallGas.root),
      });

    test.each([true, false])(
      "initialization validation and resize policy (resizable=%s)",
      async (resizable) => {
        const { account, wallet } = harness.accounts[0]!;
        const deployment = prepareContractDeployment({
          deployer: account.address,
          contract: await contractArtifact(),
        });
        const address = deployment.address;
        await wallet.deployContractAndWait(deployment, {
          amount: smallDeposit,
          gasLimit: gasAmount(20_000_000n),
        });
        for (const size of [0n, 99n, 101n, 10_100n]) {
          await expect(
            initialize(wallet, address, size, resizable),
          ).rejects.toMatchObject(COMMITTED_FAILURE);
        }
        await initialize(wallet, address, 100n, resizable);
        await pollMetadata(address).toMatchObject({
          size: 100n,
          seed: 42n,
          epoch: 0n,
          generation: 0n,
          resizable,
        });
        const before = await metadata(address);
        await expect(
          initialize(wallet, address, 200n, resizable),
        ).rejects.toMatchObject(COMMITTED_FAILURE);
        expect(await metadata(address)).toEqual(before);

        const reset = resize(wallet, address, 200n, smallGas);
        if (resizable) {
          await reset;
          await pollMetadata(address).toMatchObject({
            size: 200n,
            seed: 42n,
            epoch: 1n,
            generation: 0n,
            resizable: true,
          });
        } else {
          await expect(reset).rejects.toMatchObject(COMMITTED_FAILURE);
          expect(await metadata(address)).toEqual(before);
        }
      },
      120_000,
    );

    test("concurrent advances commit distinct generations", async () => {
      const [first, second] = harness.accounts;
      const deployment = prepareContractDeployment({
        deployer: first!.account.address,
        contract: await contractArtifact(),
      });
      const address = deployment.address;
      await deployAndInitialize(
        first!.wallet,
        deployment,
        { seed: 42n, size: 100, resizable: false },
        smallDeposit,
        smallGas,
      );
      await pollMetadata(address).toMatchObject({ generation: 0n });

      // Expiry is 64 one-second blocks, so a dropped transaction cannot
      // commit after this wait ends.
      const receiptWaitMs = 120_000;
      const results = await Promise.allSettled([
        advance(first!.wallet, address, smallGas, receiptWaitMs),
        advance(second!.wallet, address, smallGas, receiptWaitMs),
      ]);
      const generations: bigint[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          generations.push(
            advancedEvent(result.value.receipt, address).fields.generation,
          );
        } else if (isThruputError(result.reason, "transactionOutcomeUnknown")) {
          // The lock loser is dropped without a receipt. Its 64-block expiry
          // passed during the wait, so it can never commit.
          expect(result.reason.transaction?.receipt).toBeUndefined();
          expect(result.reason.context.knownCommitment).toBeUndefined();
        } else {
          expect(isThruputError(result.reason, "transactionFailed")).toBe(true);
        }
      }
      expect(generations.length).toBeGreaterThan(0);
      expect(new Set(generations).size).toBe(generations.length);
      await pollMetadata(address).toMatchObject({
        generation: BigInt(generations.length),
      });
      console.log(
        `Concurrent advances: ${generations.length} of 2 committed successfully`,
      );
    }, 400_000);

    test("full-size advance matches the core reference vector", async () => {
      const { account, wallet } = harness.accounts[0]!;
      const before = await metadata(deployed);
      const reference =
        before.epoch === 0n && before.generation === 0n
          ? referenceWorlds.find(
              (world) =>
                before.size === BigInt(world.size) &&
                before.seed === BigInt(world.seed),
            )
          : undefined;
      // The clean-ledger harness deploys a fresh reference world.
      if (process.env.GAME_OF_LIFE_EXPECT_REFERENCE_WORLD === "1")
        expect(reference).toBeDefined();

      const { receipt } = await advance(wallet, deployed, deployedGas);
      const event = advancedEvent(receipt, deployed);
      expect(event.topics.advanced_by).toEqual(account.address);
      expect(event.fields.epoch).toBe(before.epoch);
      expect(event.fields.generation).toBe(before.generation + 1n);
      if (reference) {
        expect(event.fields.population).toBe(
          reference.generationOne.population,
        );
        expect(toHex0x(event.fields.state_digest)).toBe(
          reference.generationOne.stateDigest,
        );
      }
      await pollMetadata(deployed).toMatchObject({
        generation: event.fields.generation,
        population: event.fields.population,
        state_digest: event.fields.state_digest,
      });
      console.log(`Full-world advance used ${receipt.gasUsed} root gas`);
    }, 1_200_000);

    test("failed advance leaves the world unchanged; another caller advances", async () => {
      const [first, second] = harness.accounts;
      const before = await metadata(deployed);
      await expect(
        advance(first!.wallet, deployed, underGassed),
      ).rejects.toMatchObject(COMMITTED_FAILURE);
      expect(await metadata(deployed)).toEqual(before);

      const { receipt } = await advance(second!.wallet, deployed, deployedGas);
      const event = advancedEvent(receipt, deployed);
      expect(event.topics.advanced_by).toEqual(second!.account.address);
      expect(event.fields.generation).toBe(before.generation + 1n);
      await pollMetadata(deployed).toMatchObject({
        generation: event.fields.generation,
      });
    }, 1_200_000);

    test("deployed configurable world resizes atomically", async (context) => {
      const before = await metadata(deployed);
      if (!before.resizable) context.skip();
      const { wallet } = harness.accounts[2]!;
      await expect(
        initialize(wallet, deployed, 100n, true),
      ).rejects.toMatchObject(COMMITTED_FAILURE);
      await expect(
        resize(wallet, deployed, 101n, smallGas),
      ).rejects.toMatchObject(COMMITTED_FAILURE);
      expect(await metadata(deployed)).toEqual(before);

      await resize(wallet, deployed, 100n, deployedGas);
      await pollMetadata(deployed).toMatchObject({
        size: 100n,
        seed: before.seed,
        epoch: before.epoch + 1n,
        generation: 0n,
      });
      const reset = await metadata(deployed);
      const chunk = async () =>
        (
          await GameOfLife.v0_1.getChunk.view({
            client: harness.client,
            address: deployed,
            args: { row: 0n, part: 0n },
          })
        ).value;
      const resetChunk = await chunk();
      // Growing to full size needs far more gas than this.
      await expect(
        resize(wallet, deployed, 10_000n, smallGas),
      ).rejects.toMatchObject(COMMITTED_FAILURE);
      expect(await metadata(deployed)).toEqual(reset);
      expect(await chunk()).toEqual(resetChunk);
    }, 1_200_000);
  },
);
