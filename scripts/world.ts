// Deployment, funding, and transaction helpers shared by deploy, benchmark,
// and live checks.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  gasAmount,
  parseAddress,
  toHex0x,
  UnsupportedRpcValue,
  type ContractAddress,
  type ContractDeployment,
  type RpcClient,
  type StorageCosts,
  type ThruputClient,
  type TransactionReceipt,
  type WalletActions,
  type WalletExecutionActions,
} from "@thruputchain/client";
import { GameOfLife } from "../web/src/contracts/game-of-life";
import { repoPath } from "./paths.mjs";
import {
  fundPublicSetupAccount,
  fundSetupAccount,
  type FundingRecord,
} from "./setup-funding";

export const contractArtifact = () =>
  readFile(repoPath("target/thruput/game_of_life.rv32a"));

/** Core reference vectors for the seed-0, 10,000² world at epoch zero. */
export const referenceWorld = {
  size: 10_000,
  seed: "0",
  generationZero: {
    population: 49_999_272n,
    stateDigest:
      "0x64a81a157cfb3bd83276eaab7a15b0a44a9ec7d8eac04bc117b78a01212cf4e5",
  },
  generationOne: {
    population: 27_336_807n,
    stateDigest:
      "0x1ea48941caa8c1614bbb00c80ed6903855c174778d45725522439cc875ccde71",
  },
} as const;

export interface GasBudget {
  root: bigint;
  target: bigint;
}

/** Reads the local faucet address from a runtime manifest. */
export async function runtimeFaucet(
  manifestPath: string,
  networkHash: string,
): Promise<ContractAddress> {
  const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(
    runtime.networkHash,
    networkHash,
    "Runtime manifest belongs to another network",
  );
  const faucets = runtime.bootstrapAccounts.filter(
    (account: { role: string }) => account.role === "faucet",
  );
  assert.equal(faucets.length, 1, "The local runtime must have one faucet");
  return parseAddress(faucets[0].walletAddress);
}

/**
 * Funds one account from the local faucet, or by public airdrop without a
 * faucet. Funding intent is saved before each request; see setup-funding.ts.
 */
export async function fundAccount({
  client,
  rpc,
  faucet,
  recipient,
  records,
  save,
}: {
  client: ThruputClient;
  rpc: Pick<RpcClient, "dev_fundAccount">;
  faucet: ContractAddress | undefined;
  recipient: Uint8Array;
  records: Record<string, FundingRecord>;
  save: () => Promise<void>;
}) {
  if (faucet)
    await fundSetupAccount({ client, rpc, recipient, faucet, records, save });
  else await fundPublicSetupAccount({ client, recipient, records, save });
}

/**
 * Storage deposit for the contract code, metadata, and both cell banks.
 * `storageSize` is the largest size the world can reach. Resizes keep old
 * slots, so every slot is reserved at the maximum chunk length.
 */
export function storageDeposit(
  costs: StorageCosts,
  artifactBytes: number,
  storageSize: number,
): bigint {
  const worldBytes = storageSize * Math.ceil(storageSize / 8);
  const chunks = Math.ceil(worldBytes / 4096) * 2;
  return (
    BigInt(chunks + 4) * costs.baseDataItemCost +
    (BigInt(chunks) * 4_096n + 1_024n) * costs.bytestringCostPerByte +
    costs.baseContractDeploymentCost +
    BigInt(artifactBytes) * costs.contractDeploymentCostPerByte +
    costs.balanceCost
  );
}

/** Deploys the contract and initializes the world in one atomic transaction. */
export function deployAndInitialize(
  wallet: Pick<WalletActions, "deployContractAndWait">,
  deployment: ContractDeployment,
  world: { seed: bigint; size: number; resizable: boolean },
  deposit: bigint,
  gas: GasBudget,
) {
  return wallet.deployContractAndWait(
    deployment,
    {
      amount: deposit,
      gasLimit: gasAmount(gas.root),
      initializer: GameOfLife.v0_1.initialize.invocation(
        deployment.address,
        gasAmount(gas.target),
        {
          seed: world.seed,
          size: BigInt(world.size),
          resizable: world.resizable,
        },
      ),
    },
    { timeoutMs: 1_200_000 },
  );
}

/**
 * Submits one `advance` transaction and waits for its receipt. If another
 * advance or resize takes the world lock in the same block, the node drops
 * this transaction without a receipt, and the wait times out.
 */
export function advance(
  wallet: Pick<WalletExecutionActions, "executeAndWait">,
  address: ContractAddress,
  gas: GasBudget,
  timeoutMs = 1_200_000,
) {
  return wallet.executeAndWait(
    {
      invocation: GameOfLife.v0_1.advance.invocation(
        address,
        gasAmount(gas.target),
      ),
      gasLimit: gasAmount(gas.root),
      expiryBlocks: 64n,
    },
    { timeoutMs },
  );
}

export function succeeded(receipt: TransactionReceipt) {
  return (
    !(receipt.execution instanceof UnsupportedRpcValue) &&
    receipt.execution.result === "return"
  );
}

/**
 * Reads world metadata at or after a receipt's block. A receipt can be visible
 * before the node serves that block's state, so wait briefly for it.
 */
export async function metadataAfter(
  client: ThruputClient,
  address: ContractAddress,
  minStateBlockHeight: TransactionReceipt["blockHeight"],
) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return (
        await GameOfLife.v0_1.getMetadata.view({
          client,
          address,
          minStateBlockHeight,
        })
      ).value;
    } catch (error) {
      const unavailable =
        (error as { decoded?: { data?: { kind?: string } } }).decoded?.data
          ?.kind === "stateHeightUnavailable";
      if (!unavailable || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Checks committed generation-zero metadata. The seed-0, 10,000² world must
 * also match the core reference vector.
 */
export async function verifyInitialized(
  client: ThruputClient,
  address: ContractAddress,
  world: { seed: bigint; size: number; resizable: boolean },
  minStateBlockHeight: TransactionReceipt["blockHeight"],
) {
  const value = await metadataAfter(client, address, minStateBlockHeight);
  assert.equal(value.size, BigInt(world.size));
  assert.equal(value.seed, world.seed);
  assert.equal(value.epoch, 0n);
  assert.equal(value.generation, 0n);
  assert.equal(value.resizable, world.resizable);
  if (
    world.size === referenceWorld.size &&
    world.seed === BigInt(referenceWorld.seed)
  ) {
    assert.equal(value.population, referenceWorld.generationZero.population);
    assert.equal(
      toHex0x(value.state_digest),
      referenceWorld.generationZero.stateDigest,
    );
  }
  return value;
}
