import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createPubkeyAccount,
  createThruputClient,
  createWalletClient,
  createRpcClient,
  defineCluster,
  Ed25519Signer,
  gasAmount,
  HttpTransport,
  parseAddress,
  prepareContractDeployment,
  toBase58,
  toHex0x,
  UnsupportedRpcValue,
  TransactionExecutionError,
  type SubmissionEvidence,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
} from "../src/contracts/game-of-life";

const { values } = parseArgs({
  options: {
    "rpc-url": { type: "string", default: "http://127.0.0.1:9558" },
    sizes: { type: "string", default: "2500,2800,3000,3100" },
    seeds: { type: "string", default: "0,1,42" },
    generations: { type: "string", default: "5" },
    "gas-limit": { type: "string", default: "1000000000" },
    "target-gas-limit": { type: "string" },
    "runtime-manifest": { type: "string" },
    output: { type: "string", default: "../../.tmp/benchmarks" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Benchmark deployed worlds. Options: --rpc-url URL --sizes 2500,2800 --seeds 0,1,42 --generations 5 --gas-limit 1000000000 --target-gas-limit 995000000 --runtime-manifest PATH --output DIR\nEach run saves private accounts, funding intent, signed evidence, and receipts. Runs never retry or resubmit uncertain transactions. Inspect saved hashes before starting another run. Timings include signing, submission, scheduling, and receipt polling; they are not executor duration.",
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
  targetInput === undefined ? rootGas - 5_000_000n : BigInt(targetInput);
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
const artifact = await readFile(
  resolve("../../target/thruput/game_of_life.rv32a"),
);
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
let faucet: ReturnType<typeof parseAddress> | undefined;
if (values["runtime-manifest"]) {
  const manifest = JSON.parse(
    await readFile(resolve(values["runtime-manifest"]), "utf8"),
  );
  assert.equal(manifest.networkHash, networkHash);
  const faucets = manifest.bootstrapAccounts.filter(
    (account: { role: string }) => account.role === "faucet",
  );
  assert.equal(faucets.length, 1);
  faucet = parseAddress(faucets[0].walletAddress);
}
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
    const nonce = randomBytes(16);
    await save(`${name}-funding.json`, {
      recipient: toBase58(account.address),
      nonce: toHex0x(nonce),
      rawAmount: faucet ? "100000000000" : null,
      faucet: faucet ? toBase58(faucet) : null,
    });
    const funded = faucet
      ? await rpc.dev_fundAccount({
          faucet,
          recipient: account.address,
          rawAmount: 100_000_000_000n,
          clientNonce: nonce,
        })
      : await client.requestAirdropAttempt({
          recipient: account.address,
          clientNonce: nonce,
        });
    await save(`${name}-funding-response.json`, funded);
    assert(
      !(funded instanceof UnsupportedRpcValue),
      "Unsupported funding response",
    );
    assert(
      funded.transactionHash,
      "Funding has no transaction hash; inspect the saved attempt before continuing",
    );
    const fundingReceipt = await client.waitForTransactionReceipt(
      funded.transactionHash,
      { timeoutMs: 120_000 },
    );
    assert(
      !(fundingReceipt.execution instanceof UnsupportedRpcValue) &&
        fundingReceipt.execution.result === "return",
      "Funding did not succeed",
    );
    // Reserve both banks, code, queue, and metadata; round chunk storage upward.
    const rowBytes = Math.ceil(size / 8);
    const chunks = Math.ceil(rowBytes / 1000);
    const storage =
      BigInt(2 * size * chunks + 4) * costs.baseDataItemCost +
      BigInt(
        2 *
          size *
          chunks *
          (chunks === 1 ? Math.ceil(rowBytes / 32) * 32 : 1024) +
          1024,
      ) *
        costs.bytestringCostPerByte +
      64n * costs.rcqCostPerEntry +
      costs.baseContractDeploymentCost +
      BigInt(artifact.length) * costs.contractDeploymentCostPerByte +
      costs.balanceCost;
    const balance = await wallet.getBalance();
    assert(
      balance.rawBalance >= rootGas + storage + 100_000n,
      `Faucet balance ${balance.rawBalance} cannot cover ${rootGas} gas reservation plus ${storage} storage`,
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
      wallet.deployContractAndWait(
        deployment,
        {
          amount: storage,
          gasLimit: gasAmount(rootGas),
          initializer: GameOfLife.v0_1.initializeSized.invocation(
            address,
            gasAmount(childGas),
            { size: BigInt(size), seed, maxQueueLen: 64n },
          ),
        },
        { timeoutMs: 120_000 },
      ),
    );
    if (
      deployed.execution instanceof UnsupportedRpcValue ||
      deployed.execution.result !== "return"
    )
      continue;
    const initial = await GameOfLife.v0_1.getMetadata.view({
      client,
      address,
      minStateBlockHeight: deployed.blockHeight,
    });
    assert.equal(initial.value.width, BigInt(size));
    assert.equal(initial.value.generation, 0n);
    assert.equal(initial.value.seed, seed);
    for (let generation = 1; generation <= generations; generation++) {
      step = `request-${generation}`;
      const requestReceipt = await measure(() =>
        wallet.executeAndWait(
          {
            invocation: GameOfLife.v0_1.requestTick.invocation(
              address,
              gasAmount(1_000_000n),
            ),
            gasLimit: gasAmount(2_000_000n),
            expiryBlocks: 64n,
          },
          { timeoutMs: 120_000 },
        ),
      );
      const request = TickRequested.singleFromReceipt(requestReceipt, {
        address,
      });
      assert(request, "Request did not emit queue admission");
      step = `crank-${generation}`;
      const receipt = await measure(() =>
        wallet.executeAndWait(
          {
            invocation: GameOfLife.v0_1.processNextTick.invocation(
              address,
              gasAmount(childGas),
            ),
            gasLimit: gasAmount(rootGas),
            expiryBlocks: 64n,
          },
          { timeoutMs: 120_000 },
        ),
      );
      if (
        receipt.execution instanceof UnsupportedRpcValue ||
        receipt.execution.result !== "return"
      )
        break;
      const advanced = GenerationAdvanced.singleFromReceipt(receipt, {
        address,
      });
      assert(advanced, "Crank did not advance the world");
      assert.equal(advanced.fields.generation, BigInt(generation));
      assert.deepEqual(advanced.topics.request_id, request.topics.request_id);
      const metadata = await GameOfLife.v0_1.getMetadata.view({
        client,
        address,
        minStateBlockHeight: receipt.blockHeight,
      });
      assert.equal(metadata.value.generation, BigInt(generation));
      assert.deepEqual(
        metadata.value.state_digest,
        advanced.fields.state_digest,
      );
    }
  }
}
