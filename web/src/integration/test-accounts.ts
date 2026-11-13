import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  createRpcClient,
  createThruputClient,
  createWalletClient,
  HttpTransport,
  localnet,
  toBase58,
  toHex0x,
  type SubmissionEvidence,
} from "@thruputchain/client";
import { loadAccounts } from "../../../scripts/local-accounts";
import { repoPath } from "../../../scripts/paths.mjs";
import type { FundingRecord } from "../../../scripts/setup-funding";
import { fundAccount, runtimeFaucet } from "../../../scripts/world";

export const rpcUrl = process.env.THRUPUT_RPC_URL ?? "http://127.0.0.1:9545";
const evidenceRoot = resolve(
  process.env.CHAIN_OF_LIFE_LOCAL_DIR ?? repoPath(".local/deployments/local"),
  "integration",
);

/**
 * Creates `count` new accounts for one test run and funds them from the local
 * faucet. Keys, funding intent, and signed transactions are saved in a new
 * directory before each request. A failed run is never resumed or retried.
 */
export async function fundedTestAccounts(count: number) {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve(evidenceRoot, "run-"));
  const client = await createThruputClient({ cluster: localnet({ rpcUrl }) });
  const rpc = await createRpcClient({ transport: new HttpTransport(rpcUrl) });
  const networkHash = toBase58(client.network.networkHash);
  const faucet = await runtimeFaucet(
    process.env.THRUPUT_RUNTIME_MANIFEST ??
      repoPath("data/runtime/runtime-manifest.json"),
    networkHash,
  );
  const accounts = await loadAccounts(
    resolve(directory, "accounts.json"),
    count,
    true,
  );
  const records: Record<string, FundingRecord> = {};
  const fundingPath = resolve(directory, "funding.json");
  const save = async () => {
    await writeFile(`${fundingPath}.tmp`, JSON.stringify(records), {
      mode: 0o600,
    });
    await rename(`${fundingPath}.tmp`, fundingPath);
  };
  for (const { account } of accounts)
    await fundAccount({
      client,
      rpc,
      faucet,
      recipient: account.address,
      records,
      save,
    });
  const onSigned = async (evidence: SubmissionEvidence) => {
    const hash = toBase58(evidence.transactionHash);
    await writeFile(
      resolve(directory, `transaction-${hash}.json`),
      JSON.stringify({
        hash,
        networkHash: toBase58(evidence.networkHash),
        signedTransaction: toHex0x(evidence.signedTransaction),
      }),
      { mode: 0o600, flag: "wx" },
    );
  };
  return {
    client,
    accounts: accounts.map(({ account }) => ({
      account,
      wallet: createWalletClient({ client, account, onSigned }),
    })),
  };
}

/** Reads the public settings written by deployment. */
export async function deployedEnvironment() {
  return parseEnv(await readFile(repoPath(".env.local"), "utf8"));
}
