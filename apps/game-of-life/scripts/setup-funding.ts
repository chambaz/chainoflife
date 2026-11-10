import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  fromHex0x,
  hashFromBase58,
  parseAddress,
  toBase58,
  toHex0x,
  UnsupportedRpcValue,
  type RpcClient,
  type ThruputClient,
} from "@thruputchain/client";

export interface FundingRecord {
  faucet: string;
  rawAmount: string;
  nonce: string;
  hash: string | null;
  signedTransaction: string | null;
  complete: boolean;
}

// Enough for deployment storage, full-world cranks, and local acceptance checks.
const setupBalance = 100_000_000_000n;

export async function fundSetupAccount({
  client,
  rpc,
  recipient,
  faucet,
  records,
  save,
}: {
  client: Pick<ThruputClient, "getBalance" | "waitForTransactionReceipt">;
  rpc: Pick<RpcClient, "dev_fundAccount">;
  recipient: Uint8Array;
  faucet: Uint8Array;
  records: Record<string, FundingRecord>;
  save: () => Promise<void>;
}): Promise<void> {
  const address = toBase58(recipient);
  let record = records[address];
  if (!record) {
    const balance = await client.getBalance({ address: parseAddress(address) });
    if (balance.rawBalance >= setupBalance) return;
    record = {
      faucet: toBase58(faucet),
      rawAmount: (setupBalance - balance.rawBalance).toString(),
      nonce: toHex0x(randomBytes(16)),
      hash: null,
      signedTransaction: null,
      complete: false,
    };
    records[address] = record;
    // Save the exact idempotent request before the faucet can submit anything.
    await save();
  }
  assert.equal(
    record.faucet,
    toBase58(faucet),
    "Saved funding belongs to another faucet",
  );
  assert(
    typeof record.rawAmount === "string" &&
      /^[1-9][0-9]*$/.test(record.rawAmount),
    "Invalid saved funding amount",
  );
  assert(
    typeof record.nonce === "string" && /^0x[0-9a-f]{32}$/.test(record.nonce),
    "Invalid saved funding nonce",
  );
  assert(
    record.hash === null || typeof record.hash === "string",
    "Invalid saved funding hash",
  );
  assert.equal(
    typeof record.complete,
    "boolean",
    "Invalid saved funding status",
  );
  if (record.complete) {
    assert(record.hash, "Completed funding has no saved transaction hash");
    return;
  }
  if (!record.hash) {
    // An explicit setup --resume repeats this same nonce, never a new grant.
    const response = await rpc.dev_fundAccount({
      recipient: parseAddress(address),
      faucet: parseAddress(record.faucet),
      rawAmount: BigInt(record.rawAmount),
      clientNonce: fromHex0x(record.nonce),
    });
    record.hash = toBase58(response.transactionHash);
    record.signedTransaction = toHex0x(response.signedTransaction);
    await save();
  }
  const receipt = await client.waitForTransactionReceipt(
    hashFromBase58(record.hash),
    {
      timeoutMs: 120_000,
    },
  );
  assert(
    !(receipt.execution instanceof UnsupportedRpcValue),
    "Unsupported funding result",
  );
  assert.equal(
    receipt.execution.result,
    "return",
    `Funding failed for ${address}`,
  );
  record.complete = true;
  await save();
  console.log(`Funded setup account: ${address}`);
}
