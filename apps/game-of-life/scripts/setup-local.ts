import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createThruputClient,
  createRpcClient,
  HttpTransport,
  createWalletClient,
  gasAmount,
  localnet,
  prepareContractDeployment,
  toBase58,
  toHex0x,
  parseAddress,
  hashFromBase58,
  fromHex0x,
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
import { fundSetupAccount, type FundingRecord } from "./setup-funding";

const client = await createThruputClient({ cluster: localnet({ rpcUrl }) });
const config = await client.getChainConfig({});
assert(
  config.stated.maxTxGas !== undefined &&
    config.stated.maxTxGas >= 60_000_000_000n,
  "Start thruput node with --network-config max_tx_gas=60000000000 before setup.",
);
const network = toHex0x(client.network.networkHash).slice(2);
const journal = resolve(
  localRoot,
  process.env.GAME_OF_LIFE_DEPLOYMENT_JOURNAL ?? "deployment.json",
);
interface SetupJournal {
  networkHash: string;
  address: string;
  steps: Record<string, string>;
  initializedVerified: boolean;
  funding?: Record<string, FundingRecord>;
  deploymentNonce?: string;
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
const accounts = await localAccounts(existing === null);
const wallets = accounts.map(({ account }) =>
  createWalletClient({ client, account, onSigned: persist }),
);

const artifact = await readFile(
  resolve("../../target/thruput/game_of_life.rv32a"),
);
const saved: SetupJournal | null = existing ? JSON.parse(existing) : null;
assert(
  !saved || saved.deploymentNonce || saved.steps?.deploy,
  "No deployment nonce or signed deployment is recorded. Inspect the journal before continuing.",
);
const deployment = prepareContractDeployment({
  deployer: accounts[0]!.account.address,
  contract: artifact,
  deploymentNonce: saved?.deploymentNonce
    ? fromHex0x(saved.deploymentNonce)
    : undefined,
});
state = saved
  ? saved
  : {
      networkHash: toBase58(client.network.networkHash),
      address: toBase58(deployment.address),
      deploymentNonce: toHex0x(deployment.deploymentNonce),
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
// Older journals have signed deployment evidence but no saved nonce.
// Their deployment step is observed by hash and is never submitted again.
if (state.deploymentNonce) {
  assert.equal(
    state.address,
    toBase58(deployment.address),
    "Saved deployment does not match the setup accounts and contract artifact",
  );
}
const address = parseAddress(state.address);
const manifestPath =
  process.env.THRUPUT_RUNTIME_MANIFEST ??
  resolve("../../data/runtime/runtime-manifest.json");
const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(
  runtime.networkHash,
  state.networkHash,
  "Runtime manifest belongs to another network",
);
const faucets = runtime.bootstrapAccounts.filter(
  (account: { role: string }) => account.role === "faucet",
);
assert.equal(faucets.length, 1, "The local runtime must have one faucet");
const faucet = parseAddress(faucets[0].walletAddress);
state.funding ??= {};
assert(
  typeof state.funding === "object" && !Array.isArray(state.funding),
  "Invalid saved funding records",
);
await saveJournal();
const rpc = await createRpcClient({ transport: new HttpTransport(rpcUrl) });
for (const { account } of accounts) {
  await fundSetupAccount({
    client,
    rpc,
    recipient: account.address,
    faucet,
    records: state.funding,
    save: saveJournal,
  });
}
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
const costs = config.execution?.storageCosts;
if (!costs) throw new Error("The node did not publish its storage cost model");
const funding =
  40_004n * costs.baseDataItemCost +
  // Resizes retain old slots. Reserve every slot at the maximum chunk length.
  (40_000n * 1_024n + 1_024n) * costs.bytestringCostPerByte +
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
    "0x5bc29c418cd47f0d7b3d479a7b70d70ed66521c3881a2610f3d0c5652d7e1927",
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
          gasAmount(59_000_000_000n),
        ),
        gasLimit: gasAmount(60_000_000_000n),
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
      "0xe2d4fa05fcd2d12e661c7d4487748d3b31705b329026209b0cb9f1c7135b0613",
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

const env = {
  VITE_THRUPUT_LOCAL_FAUCET_ADDRESS: toBase58(faucet),
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
