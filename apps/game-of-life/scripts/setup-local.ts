import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createThruputClient,
  createWalletClient,
  gasAmount,
  localnet,
  prepareContractDeployment,
  toBase58,
  toHex0x,
  parseAddress,
  hashFromBase58,
  defaultWalletAdapter,
  UnsupportedRpcValue,
  type SubmissionEvidence,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
} from "../src/contracts/game-of-life";
import { localAccounts, localRoot, rpcUrl } from "./local-accounts";

const client = await createThruputClient({ cluster: localnet({ rpcUrl }) });
const accounts = await localAccounts();
const network = toHex0x(client.network.networkHash).slice(2);
const journal = resolve(localRoot, "deployment.json");
interface SetupJournal {
  networkHash: string;
  address: string;
  steps: Record<string, string>;
  initializedVerified: boolean;
}
let state: SetupJournal;
let activeStep: string;
async function saveJournal() {
  await writeFile(`${journal}.tmp`, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  await rename(`${journal}.tmp`, journal);
}
const persist = async (evidence: SubmissionEvidence) => {
  const hash = toBase58(evidence.transactionHash);
  await writeFile(
    resolve(localRoot, `transaction-${hash}.json`),
    JSON.stringify({
      hash,
      networkHash: toBase58(evidence.networkHash),
      signedTransaction: toHex0x(evidence.signedTransaction),
    }),
    { mode: 0o600, flag: "wx" },
  );
  state.steps[activeStep] = hash;
  await saveJournal();
  console.log(`Signed transaction: ${hash}`);
};
const wallets = accounts.map(({ account }) =>
  createWalletClient({ client, account, onSigned: persist }),
);
const existing = await readFile(journal, "utf8").catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  },
);
if (existing && !process.argv.includes("--resume"))
  throw new Error(
    `Deployment evidence exists at ${journal}. Use --resume to observe its saved transactions and complete setup.`,
  );

const artifact = await readFile(
  resolve("../../target/thruput/game_of_life.rv32a"),
);
const deployment = prepareContractDeployment({
  deployer: accounts[0]!.account.address,
  contract: artifact,
});
state = existing
  ? JSON.parse(existing)
  : {
      networkHash: toBase58(client.network.networkHash),
      address: toBase58(deployment.address),
      steps: {},
      initializedVerified: false,
    };
assert.equal(
  state.networkHash,
  toBase58(client.network.networkHash),
  "Deployment belongs to another network",
);
assert(
  state.steps && typeof state.steps === "object",
  "Deployment journal has no transaction steps",
);
assert(
  !existing || state.steps.deploy,
  "No signed deployment is recorded. Inspect the journal before starting a new deployment.",
);
const address = parseAddress(state.address);
await saveJournal();
async function step(
  name: string,
  run: () => Promise<{ receipt: TransactionReceipt }>,
) {
  activeStep = name;
  const hash = state.steps[name];
  const result = hash
    ? {
        receipt: await client.waitForTransactionReceipt(hashFromBase58(hash), {
          timeoutMs: 1_200_000,
        }),
      }
    : await run();
  assert(
    !(result.receipt.execution instanceof UnsupportedRpcValue),
    `${name} has an unsupported execution result`,
  );
  assert.equal(
    result.receipt.execution.result,
    "return",
    `${name} did not execute successfully`,
  );
  return result;
}
const config = await client.getChainConfig({});
const costs = config.execution?.storageCosts;
if (!costs) throw new Error("The node did not publish its storage cost model");
const funding =
  40_004n * costs.baseDataItemCost +
  25_001_024n * costs.bytestringCostPerByte +
  64n * costs.rcqCostPerEntry +
  costs.baseContractDeploymentCost +
  BigInt(artifact.length) * costs.contractDeploymentCostPerByte +
  costs.balanceCost;
await step("deploy", () =>
  wallets[0]!.deployContractAndWait(
    deployment,
    {
      amount: funding,
      gasLimit: gasAmount(60_000_000_000n),
      initializer: GameOfLife.v0_1.initialize.invocation(
        address,
        gasAmount(59_000_000_000n),
        { seed: 0n, maxQueueLen: 64n },
      ),
    },
    { timeoutMs: 1_200_000 },
  ),
);
if (!state.initializedVerified) {
  const initialized = await GameOfLife.v0_1.getMetadata.view({
    client,
    address,
  });
  assert.equal(initialized.value.population, 49_999_272n);
  assert.equal(
    toHex0x(initialized.value.state_digest),
    "0x18b9622140df6f9f0a03cbce4c18838f41e0a395f206f6290fb1e3182ede1623",
  );
  state.initializedVerified = true;
  await saveJournal();
}

for (const [index, wallet] of wallets.entries()) {
  const requested = await step(`request-${index}`, () =>
    wallet.executeAndWait({
      invocation: GameOfLife.v0_1.requestTick.invocation(
        address,
        gasAmount(1_000_000n),
      ),
      gasLimit: gasAmount(2_000_000n),
    }),
  );
  const request = TickRequested.singleFromReceipt(requested.receipt, {
    address,
  });
  assert(request);
  assert.deepEqual(
    request.topics.requested_by,
    accounts[index]!.account.address,
  );
  const advanced = await step(`crank-${index}`, () =>
    wallets[1]!.executeAndWait(
      {
        invocation: GameOfLife.v0_1.processNextTick.invocation(
          address,
          gasAmount(10_000_000_000n),
        ),
        gasLimit: gasAmount(10_010_000_000n),
        expiryBlocks: 64n,
      },
      { timeoutMs: 1_200_000 },
    ),
  );
  const event = GenerationAdvanced.singleFromReceipt(advanced.receipt, {
    address,
  });
  assert(event);
  assert.deepEqual(event.topics.request_id, request.topics.request_id);
  assert.deepEqual(event.fields.requested_by, accounts[index]!.account.address);
  if (index === 0) {
    assert.equal(event.fields.population, 27_336_807n);
    assert.equal(
      toHex0x(event.fields.state_digest),
      "0xe7a33dc03fc5ee1456056f0ffec5a589d32c048a8382acb8d4797a00ef2c4ff2",
    );
  }
  console.log(
    `Generation ${event.fields.generation}: ${event.fields.population} live cells; ${advanced.receipt.gasUsed} root gas`,
  );
}
const empty = await step("empty", () =>
  wallets[1]!.executeCallsAndWait({
    calls: [
      GameOfLife.v0_1.processNextTick.call({
        address,
        gasLimit: gasAmount(1_000_000n),
      }),
    ],
    gasLimit: gasAmount(2_000_000n),
  }),
);
const emptyReturns = defaultWalletAdapter.decodeExecutionReturns!(
  empty.receipt,
);
assert(emptyReturns?.length === 1, "Empty crank must return one child result");
assert.equal(
  GameOfLife.v0_1.processNextTick.decodeReturn(emptyReturns[0]!),
  null,
);

const personas = accounts.map(({ id, seed, signer, account }) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  privateKey: seed,
  signerPublicKey: toHex0x(signer.publicKey.ed25519),
  walletRoot: toHex0x(account.address),
  expectedCaller: toHex0x(account.address),
  callerVerified: true,
}));
const env = {
  VITE_THRUPUT_RPC_URL: rpcUrl,
  VITE_THRUPUT_NETWORK_ID: network,
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: toHex0x(address),
  VITE_GAME_OF_LIFE_INDEXER_URL:
    process.env.GAME_OF_LIFE_INDEXER_URL ?? "http://127.0.0.1:8787",
  VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "2000000",
  VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT: "1000000",
  VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS: "64",
  VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS: "30000",
  VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT: "10010000000",
  VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: "10000000000",
  VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS: "64",
  VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS: "300000",
  THRUPUT_DEV_PERSONAS: JSON.stringify(personas),
};
await writeFile(
  ".env.local",
  Object.entries(env)
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log(
  `Chain of Life initialized at ${toBase58(address)}. Run npm run dev.`,
);
