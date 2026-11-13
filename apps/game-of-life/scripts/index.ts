import assert from "node:assert/strict";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  createThruputClient,
  createRpcClient,
  HttpTransport,
  createWalletClient,
  gasAmount,
  defineCluster,
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
import { localAccounts } from "./local-accounts";
import { deploymentConfig } from "./deployment-config";
import {
  fundSetupAccount,
  fundPublicSetupAccount,
  type FundingRecord,
} from "./setup-funding";

const options = deploymentConfig(process.argv.slice(2));
if (options.help) {
  console.log(
    "Deploy Chain of Life: --preset local|futurenet --rpc-url URL --mode configurable|fixed --size 2900 --seed 0 --output FILE --state-dir DIR --runtime-manifest FILE --resume\nFlags override preset defaults. The node must already be running. Use a separate state directory for each deployment.",
  );
  process.exit(0);
}
const { stateDir: localRoot, rpcUrl, journal } = options;
const client = await createThruputClient({
  cluster: defineCluster({
    name: options.preset,
    rpcUrl,
    capabilities: ["airdrop"] as const,
  }),
});
const config = await client.getChainConfig({});
assert(
  config.stated.maxTxGas !== undefined &&
    config.stated.maxTxGas >= options.deploymentGas,
  `This deployment needs a ${options.deploymentGas} gas cap. For a local configurable world, start thruput node with --network-config max_tx_gas=60000000000. For Futurenet, use --preset futurenet.`,
);
const network = toHex0x(client.network.networkHash).slice(2);
const identity = {
  mode: options.mode,
  size: options.size,
  seed: options.seed,
  rpcUrl,
};
interface SetupJournal {
  networkHash: string;
  address: string;
  steps: Record<string, string>;
  initializedVerified: boolean;
  funding?: Record<string, FundingRecord>;
  deploymentNonce?: string;
  configuration?: typeof identity;
}
let state: SetupJournal;
let activeStep: string;
async function saveJournal() {
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
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
if (existing && !options.resume)
  throw new Error(
    `Deployment evidence exists at ${journal}. Use --resume to observe its saved transactions and complete setup.`,
  );
const accounts = await localAccounts(existing === null, localRoot);
const wallets = accounts.map(({ account }) =>
  createWalletClient({ client, account, onSigned: persist }),
);

const artifact = await readFile(
  resolve("../../target/thruput/game_of_life.rv32a"),
);
const saved: SetupJournal | null = existing ? JSON.parse(existing) : null;
assert(
  !saved || saved.configuration,
  "This journal predates deployment modes. Use a fresh --state-dir and deploy the new contract.",
);
if (saved)
  assert.deepEqual(
    saved.configuration,
    identity,
    "Saved deployment configuration differs. Resume with its original flags.",
  );
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
      configuration: identity,
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
let faucet: ReturnType<typeof parseAddress> | undefined;
if (options.manifest) {
  const runtime = JSON.parse(await readFile(options.manifest, "utf8"));
  assert.equal(
    runtime.networkHash,
    state.networkHash,
    "Runtime manifest belongs to another network",
  );
  const faucets = runtime.bootstrapAccounts.filter(
    (account: { role: string }) => account.role === "faucet",
  );
  assert.equal(faucets.length, 1, "The local runtime must have one faucet");
  faucet = parseAddress(faucets[0].walletAddress);
}
state.funding ??= {};
assert(
  typeof state.funding === "object" && !Array.isArray(state.funding),
  "Invalid saved funding records",
);
await saveJournal();
const rpc = await createRpcClient({ transport: new HttpTransport(rpcUrl) });
for (const { account } of accounts) {
  const params = {
    client,
    recipient: account.address,
    records: state.funding,
    save: saveJournal,
  };
  if (faucet) await fundSetupAccount({ ...params, rpc, faucet });
  else await fundPublicSetupAccount(params);
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
const storageSize = options.mode === "configurable" ? 10_000 : options.size;
const chunks = storageSize * Math.ceil(Math.ceil(storageSize / 8) / 1000) * 2;
const funding =
  BigInt(chunks + 4) * costs.baseDataItemCost +
  // Resizes retain old slots. Reserve every slot at the maximum chunk length.
  (BigInt(chunks) * 1_024n + 1_024n) * costs.bytestringCostPerByte +
  64n * costs.rcqCostPerEntry +
  costs.baseContractDeploymentCost +
  BigInt(artifact.length) * costs.contractDeploymentCostPerByte +
  costs.balanceCost;
for (const [index, wallet] of wallets.entries()) {
  const balance = await wallet.getBalance();
  const needed =
    index === 0 && !state.steps.deploy
      ? options.deploymentGas + funding + 100_000n
      : options.crankGas + 100_000n;
  assert(
    balance.rawBalance >= needed,
    `Account ${toBase58(wallet.account.address)} needs ${needed} raw units; available ${balance.rawBalance}. Fund this account before explicit resume.`,
  );
}
await step("deploy", () =>
  wallets[0]!.deployContractAndWait(
    deployment,
    {
      amount: funding,
      gasLimit: gasAmount(options.deploymentGas),
      initializer: GameOfLife.v0_1.initializeConfigured.invocation(
        address,
        gasAmount(options.deploymentTargetGas),
        {
          seed: BigInt(options.seed),
          maxQueueLen: 64n,
          size: BigInt(options.size),
          resizable: options.mode === "configurable",
        },
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
  assert.equal(initialized.value.width, BigInt(options.size));
  assert.equal(initialized.value.height, BigInt(options.size));
  assert.equal(initialized.value.seed, BigInt(options.seed));
  assert.equal(initialized.value.resizable, options.mode === "configurable");
  if (options.size === 10_000 && options.seed === "0") {
    assert.equal(initialized.value.population, 49_999_272n);
    assert.equal(
      toHex0x(initialized.value.state_digest),
      "0x5bc29c418cd47f0d7b3d479a7b70d70ed66521c3881a2610f3d0c5652d7e1927",
    );
  }
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
          gasAmount(options.crankTargetGas),
        ),
        gasLimit: gasAmount(options.crankGas),
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
  if (index === 0 && options.size === 10_000 && options.seed === "0") {
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
  VITE_THRUPUT_LOCAL_FAUCET_ADDRESS: faucet ? toBase58(faucet) : "",
  VITE_THRUPUT_RPC_URL: rpcUrl,
  VITE_THRUPUT_NETWORK_ID: network,
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: toHex0x(address),
  VITE_GAME_OF_LIFE_INDEXER_URL:
    process.env.GAME_OF_LIFE_INDEXER_URL ?? "http://127.0.0.1:8787",
  VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "2000000",
  VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT: "1000000",
  VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS: "64",
  VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS: "30000",
  VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT: options.crankGas.toString(),
  VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: options.crankTargetGas.toString(),
  VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS: "64",
  VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS: "300000",
};
await mkdir(dirname(options.output), { recursive: true });
await writeFile(
  `${options.output}.tmp`,
  Object.entries(env)
    .map(([key, value]) => {
      assert(!/[\r\n']/.test(value), `Invalid environment value for ${key}`);
      return `${key}='${value}'`;
    })
    .join("\n") + "\n",
  { mode: 0o600 },
);
await rename(`${options.output}.tmp`, options.output);
console.log(
  `Chain of Life ${options.mode} world initialized at ${toBase58(address)}.\nConfiguration: ${options.output}\nRun npm run dev -- --config ${options.output}`,
);
