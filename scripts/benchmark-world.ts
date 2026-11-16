import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createPubkeyAccount,
  createThruputClient,
  createWalletClient,
  createRpcClient,
  defineCluster,
  Ed25519Signer,
  HttpTransport,
  prepareContractDeployment,
  toBase58,
  toHex0x,
  UnsupportedRpcValue,
  TransactionExecutionError,
  type ContractAddress,
  type SubmissionEvidence,
  type TransactionReceipt,
} from "@thruputchain/client";
import { GenerationAdvanced } from "../web/src/contracts/game-of-life";
import { repoPath } from "./paths.mjs";
import type { FundingRecord } from "./setup-funding";
import {
  advance,
  contractArtifact,
  deployAndInitialize,
  fundAccount,
  metadataAfter,
  runtimeFaucet,
  storageDeposit,
  succeeded,
} from "./world";

const { values } = parseArgs({
  options: {
    "rpc-url": { type: "string", default: "http://127.0.0.1:9558" },
    sizes: { type: "string", default: "8000,10000" },
    seeds: { type: "string", default: "0,1,42" },
    generations: { type: "string", default: "5" },
    "gas-limit": { type: "string", default: "1000000000" },
    "target-gas-limit": { type: "string" },
    "runtime-manifest": { type: "string" },
    output: { type: "string", default: repoPath(".tmp/benchmarks") },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Benchmark deployed worlds. Options: --rpc-url URL --sizes 8000,10000 --seeds 0,1,42 --generations 5 --gas-limit 1000000000 --target-gas-limit 999000000 --runtime-manifest PATH --output DIR\nEach run saves private accounts, funding intent, signed evidence, and receipts. Runs never retry or resubmit uncertain transactions. Inspect saved hashes before starting another run. Timings include signing, submission, scheduling, and receipt polling; they are not executor duration.",
  );
  process.exit(0);
}
const sizes = values.sizes.split(",").map(Number);
assert(
  sizes.length &&
    sizes.every(
      (size) =>
        Number.isInteger(size) &&
        size >= 100 &&
        size <= 10_000 &&
        size % 100 === 0,
    ),
  "Sizes must be multiples of 100 between 100 and 10000",
);
const seeds = values.seeds.split(",").map((value) => {
  assert(/^\d+$/.test(value), "Seeds must be unsigned decimal integers");
  const seed = BigInt(value);
  assert(seed <= 0xffff_ffff_ffff_ffffn, "Seed exceeds u64");
  return seed;
});
assert(
  new Set(sizes).size === sizes.length && new Set(seeds).size === seeds.length,
  "Sizes and seeds must not contain duplicates",
);
const generations = Number(values.generations);
assert(
  Number.isInteger(generations) && generations >= 2 && generations <= 100,
  "Use 2–100 generations to exercise both banks",
);
assert(/^\d+$/.test(values["gas-limit"]));
const rootGas = BigInt(values["gas-limit"]);
assert(
  rootGas > 10_000_000n && rootGas <= 1_000_000_000n,
  "Benchmark gas limit must be at most Futurenet's one-billion cap",
);
const targetInput = values["target-gas-limit"];
assert(
  targetInput === undefined || /^\d+$/.test(targetInput),
  "Target gas must be an unsigned decimal integer",
);
const childGas =
  targetInput === undefined ? rootGas - 1_000_000n : BigInt(targetInput);
assert(
  childGas > 0n && childGas < rootGas,
  "Target gas must be positive and below the root budget",
);
const rpcUrl = values["rpc-url"];
const transport = new HttpTransport(rpcUrl, { timeoutMs: 30_000 });
const client = await createThruputClient({
  cluster: defineCluster({
    name: "benchmark",
    rpcUrl,
    capabilities: ["airdrop"] as const,
  }),
  transport,
});
const config = await client.getChainConfig({});
assert(
  config.stated.maxTxGas !== undefined && rootGas <= config.stated.maxTxGas,
  "Gas budget exceeds endpoint cap",
);
const costs = config.execution?.storageCosts;
assert(costs, "Endpoint must publish storage costs");
const artifact = await contractArtifact();
await mkdir(resolve(values.output), { recursive: true });
const directory = await mkdtemp(resolve(values.output, "run-"));
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_, item: unknown) =>
      typeof item === "bigint"
        ? item.toString()
        : item instanceof Uint8Array
          ? toHex0x(item)
          : item,
    2,
  );
async function save(name: string, value: unknown) {
  const path = resolve(directory, name);
  await writeFile(`${path}.tmp`, serialize(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
const networkHash = toBase58(client.network.networkHash);
await save("run.json", {
  rpcUrl,
  networkHash,
  startedAt: new Date().toISOString(),
  sizes,
  seeds,
  generations,
  rootGas,
  childGas,
  config,
  version: await client.getVersionInfo({}),
  artifactSha256: createHash("sha256").update(artifact).digest("hex"),
  timing: "operation-to-receipt, not executor duration",
});
console.log(`Evidence: ${directory}`);
const rpc = await createRpcClient({ transport });
const faucet: ContractAddress | undefined = values["runtime-manifest"]
  ? await runtimeFaucet(resolve(values["runtime-manifest"]), networkHash)
  : undefined;
const results: unknown[] = [];
for (const size of sizes) {
  for (const seed of seeds) {
    const name = `${size}-${seed}`;
    const privateSeed = randomBytes(32);
    const account = createPubkeyAccount({
      signer: Ed25519Signer.fromSeed(privateSeed),
    });
    await save(`${name}-account.json`, {
      seed: toHex0x(privateSeed),
      address: toBase58(account.address),
      networkHash,
    });
    let step = "deploy";
    const onSigned = async (evidence: SubmissionEvidence) => {
      await save(`${name}-${step}-signed.json`, {
        hash: toBase58(evidence.transactionHash),
        networkHash,
        signedTransaction: toHex0x(evidence.signedTransaction),
      });
    };
    const wallet = createWalletClient({ client, account, onSigned });
    // Funding intent is saved before the request; a failed run is not retried.
    const funding: Record<string, FundingRecord> = {};
    await fundAccount({
      client,
      rpc,
      faucet,
      recipient: account.address,
      records: funding,
      save: () => save(`${name}-funding.json`, funding),
    });
    const storage = storageDeposit(costs, artifact.length, size);
    const balance = await wallet.getBalance();
    assert(
      balance.rawBalance >= rootGas + storage + 100_000n,
      `Balance ${balance.rawBalance} cannot cover ${rootGas} gas reservation plus ${storage} storage`,
    );
    const deployment = prepareContractDeployment({
      deployer: account.address,
      contract: artifact,
    });
    const address = deployment.address;
    await save(`${name}-deployment.json`, {
      address: toBase58(address),
      nonce: toHex0x(deployment.deploymentNonce),
      size,
      seed,
      storage,
    });
    async function measure(
      operation: () => Promise<{ receipt: TransactionReceipt }>,
    ) {
      const started = performance.now();
      let receipt: TransactionReceipt;
      try {
        receipt = (await operation()).receipt;
      } catch (error) {
        if (!(error instanceof TransactionExecutionError)) throw error;
        receipt = error.receipt;
      }
      const operationToReceiptMs = performance.now() - started;
      await save(`${name}-${step}-receipt.json`, receipt);
      assert(
        !(receipt.execution instanceof UnsupportedRpcValue),
        "Unsupported execution result",
      );
      const result = {
        size,
        seed,
        address: toBase58(address),
        transactionHash: toBase58(receipt.transactionHash),
        step,
        gasUsed: receipt.gasUsed,
        outcome: receipt.execution.result,
        operationToReceiptMs,
      };
      results.push(result);
      await save("results.json", results);
      console.log(
        `${size}×${size} seed ${seed} ${step}: ${receipt.execution.result}, ${receipt.gasUsed} gas, ${operationToReceiptMs.toFixed(0)} ms to receipt`,
      );
      return receipt;
    }
    const deployed = await measure(() =>
      deployAndInitialize(
        wallet,
        deployment,
        { seed, size, resizable: false },
        storage,
        { root: rootGas, target: childGas },
      ),
    );
    if (!succeeded(deployed)) continue;
    const initial = await metadataAfter(client, address, deployed.blockHeight);
    assert.equal(initial.size, BigInt(size));
    assert.equal(initial.generation, 0n);
    assert.equal(initial.seed, seed);
    for (let generation = 1; generation <= generations; generation++) {
      step = `advance-${generation}`;
      const receipt = await measure(() =>
        advance(wallet, address, { root: rootGas, target: childGas }),
      );
      if (!succeeded(receipt)) break;
      const advanced = GenerationAdvanced.singleFromReceipt(receipt, {
        address,
      });
      assert(advanced, "Advance did not emit GenerationAdvanced");
      assert.equal(advanced.fields.generation, BigInt(generation));
      assert.deepEqual(advanced.topics.advanced_by, account.address);
      const metadata = await metadataAfter(
        client,
        address,
        receipt.blockHeight,
      );
      assert.equal(metadata.generation, BigInt(generation));
      assert.deepEqual(metadata.state_digest, advanced.fields.state_digest);
    }
  }
}
