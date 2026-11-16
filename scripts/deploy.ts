import assert from "node:assert/strict";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  createThruputClient,
  createRpcClient,
  HttpTransport,
  createWalletClient,
  defineCluster,
  prepareContractDeployment,
  toBase58,
  toHex0x,
  parseAddress,
  hashFromBase58,
  fromHex0x,
  type ContractAddress,
  type SubmissionEvidence,
  type TransactionReceipt,
} from "@thruputchain/client";
import { loadAccounts } from "./local-accounts";
import { deploymentConfig } from "./deployment-config";
import type { FundingRecord } from "./setup-funding";
import {
  contractArtifact,
  deployAndInitialize,
  fundAccount,
  runtimeFaucet,
  storageDeposit,
  succeeded,
  verifyInitialized,
} from "./world";

const options = deploymentConfig(process.argv.slice(2));
if (options.help) {
  console.log(
    "Deploy Chain of Life: --preset local|futurenet --rpc-url URL --mode configurable|fixed --size 10000 --seed 0 --output FILE --state-dir DIR --runtime-manifest FILE --resume\nFlags override preset defaults. The node must already be running. Use a separate state directory for each deployment.",
  );
  process.exit(0);
}
const { stateDir, rpcUrl, journal } = options;
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
    config.stated.maxTxGas >= options.gasLimit,
  `This deployment needs a ${options.gasLimit} gas cap.`,
);
const world = {
  seed: BigInt(options.seed),
  size: options.size,
  resizable: options.mode === "configurable",
};
const configuration = {
  mode: options.mode,
  size: options.size,
  seed: options.seed,
  rpcUrl,
};
interface DeploymentJournal {
  networkHash: string;
  address: string;
  deploymentNonce: string;
  configuration: typeof configuration;
  funding: Record<string, FundingRecord>;
  /** Base58 hash of the signed deploy-and-initialize transaction. */
  deployHash: string | null;
  initializedVerified: boolean;
}
let state: DeploymentJournal;
async function saveJournal() {
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
  await writeFile(`${journal}.tmp`, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  await rename(`${journal}.tmp`, journal);
}
// Save signed evidence and its hash before the wallet broadcasts it.
const persist = async (evidence: SubmissionEvidence) => {
  const hash = toBase58(evidence.transactionHash);
  await writeFile(
    resolve(stateDir, `transaction-${hash}.json`),
    JSON.stringify({
      hash,
      networkHash: toBase58(evidence.networkHash),
      signedTransaction: toHex0x(evidence.signedTransaction),
    }),
    { mode: 0o600, flag: "wx" },
  );
  state.deployHash = hash;
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
const [deployer] = await loadAccounts(
  resolve(stateDir, "accounts.json"),
  1,
  existing === null,
);
const { account } = deployer!;
const wallet = createWalletClient({ client, account, onSigned: persist });
const artifact = await contractArtifact();
const saved: DeploymentJournal | null = existing ? JSON.parse(existing) : null;
if (saved)
  assert.deepEqual(
    saved.configuration,
    configuration,
    "Saved deployment configuration differs. Resume with its original flags.",
  );
const deployment = prepareContractDeployment({
  deployer: account.address,
  contract: artifact,
  deploymentNonce: saved ? fromHex0x(saved.deploymentNonce) : undefined,
});
state = saved ?? {
  networkHash: toBase58(client.network.networkHash),
  address: toBase58(deployment.address),
  deploymentNonce: toHex0x(deployment.deploymentNonce),
  configuration,
  funding: {},
  deployHash: null,
  initializedVerified: false,
};
assert.equal(
  state.networkHash,
  toBase58(client.network.networkHash),
  "Deployment belongs to another network",
);
assert.equal(
  state.address,
  toBase58(deployment.address),
  "Saved deployment does not match the deployment account and contract artifact",
);
const address = parseAddress(state.address);
let faucet: ContractAddress | undefined;
if (options.manifest)
  faucet = await runtimeFaucet(options.manifest, state.networkHash);
await saveJournal();

const rpc = await createRpcClient({ transport: new HttpTransport(rpcUrl) });
await fundAccount({
  client,
  rpc,
  faucet,
  recipient: account.address,
  records: state.funding,
  save: saveJournal,
});

const costs = config.execution?.storageCosts;
if (!costs) throw new Error("The node did not publish its storage cost model");
// Configurable worlds can grow to the maximum size.
const deposit = storageDeposit(
  costs,
  artifact.length,
  world.resizable ? 10_000 : world.size,
);
let receipt: TransactionReceipt;
if (state.deployHash) {
  // Observe the saved transaction; never sign or submit it again.
  receipt = await client.waitForTransactionReceipt(
    hashFromBase58(state.deployHash),
    { timeoutMs: 1_200_000 },
  );
} else {
  const balance = await wallet.getBalance();
  const needed = options.gasLimit + deposit + 100_000n;
  assert(
    balance.rawBalance >= needed,
    `Account ${toBase58(account.address)} needs ${needed} raw units; available ${balance.rawBalance}. Fund this account before explicit resume.`,
  );
  ({ receipt } = await deployAndInitialize(wallet, deployment, world, deposit, {
    root: options.gasLimit,
    target: options.targetGasLimit,
  }));
}
assert(succeeded(receipt), "Deployment did not execute successfully");
if (!state.initializedVerified) {
  await verifyInitialized(client, address, world, receipt.blockHeight);
  state.initializedVerified = true;
  await saveJournal();
}

const env = {
  VITE_THRUPUT_LOCAL_FAUCET_ADDRESS: faucet ? toBase58(faucet) : "",
  VITE_THRUPUT_RPC_URL: rpcUrl,
  VITE_THRUPUT_NETWORK_ID: toHex0x(client.network.networkHash).slice(2),
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: toHex0x(address),
  VITE_GAME_OF_LIFE_INDEXER_URL:
    process.env.GAME_OF_LIFE_INDEXER_URL ?? "http://127.0.0.1:8787",
  VITE_GAME_OF_LIFE_GAS_LIMIT: options.gasLimit.toString(),
  VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT: options.targetGasLimit.toString(),
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
