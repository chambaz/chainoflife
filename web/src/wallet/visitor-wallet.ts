import {
  createPubkeyAccount,
  Ed25519Signer,
  fromHex0x,
  hashFromBase58,
  hashFromHex,
  toBase58,
  toHex0x,
  UnsupportedRpcValue,
  type ThruputClient,
} from "@thruputchain/client";
import type { AppClient } from "@/chain/client";

export interface VisitorWallet {
  readonly account: ReturnType<typeof createPubkeyAccount>;
  readonly address: string;
  readonly addressHex: string;
}

interface WalletRecord {
  version: 1;
  seed: string;
  funding: {
    nonce: string;
    hash: string | null;
    complete: boolean;
    rawAmount?: string;
    signedTransaction?: string;
  } | null;
}

export type FundingClient = Pick<
  ThruputClient,
  "getBalance" | "requestAirdropAttempt" | "waitForTransactionReceipt"
> &
  Pick<Partial<AppClient>, "requestFunding">;

export function visitorWalletKey(networkId: string): string {
  return `chain-of-life:wallet:v1:${networkId}`;
}

export function walletFromSeed(seed: string): VisitorWallet {
  const account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(fromHex0x(seed)),
  });
  return {
    account,
    address: toBase58(account.address),
    addressHex: toHex0x(account.address),
  };
}

// One browser wallet per network, shared across reloads and tabs. Never replace
// malformed saved keys or repeat an airdrop whose outcome is still unknown.
export async function prepareVisitorWallet(
  networkId: string,
  client: FundingClient,
  minimumBalance = 1n,
): Promise<VisitorWallet> {
  if (!navigator.locks)
    throw new Error(
      "Wallet setup needs a secure browser connection with Web Locks support.",
    );
  const key = visitorWalletKey(networkId);
  return navigator.locks.request(key, { mode: "exclusive" }, async () => {
    const record = readWallet(key);
    const wallet = walletFromSeed(record.seed);
    const balance = await client.getBalance({
      address: wallet.account.address,
    });
    if (balance.rawBalance < minimumBalance) {
      if (!record.funding || record.funding.complete) {
        record.funding = {
          nonce: toHex0x(crypto.getRandomValues(new Uint8Array(16))),
          hash: null,
          complete: false,
          rawAmount: (minimumBalance * 10n + 1_000_000n).toString(),
        };
        saveWallet(key, record);
        if (client.requestFunding) {
          const response = await client.requestFunding({
            recipient: wallet.account.address,
            clientNonce: fromHex0x(record.funding.nonce),
            rawAmount: BigInt(record.funding.rawAmount!),
          });
          record.funding.hash = toBase58(response.transactionHash);
          record.funding.signedTransaction = toHex0x(
            response.signedTransaction,
          );
          saveWallet(key, record);
        } else {
          const response = await client.requestAirdropAttempt({
            recipient: wallet.account.address,
            clientNonce: fromHex0x(record.funding.nonce),
          });
          if (response instanceof UnsupportedRpcValue)
            throw new Error(
              "The funding service returned an unsupported response.",
            );
          record.funding.hash = response.transactionHash
            ? toBase58(response.transactionHash)
            : null;
          saveWallet(key, record);
          if (
            response.attemptStatus === "succeeded" &&
            !(response.execution instanceof UnsupportedRpcValue)
          ) {
            if (response.execution.result !== "return")
              throw new Error("Wallet funding failed.");
            record.funding.complete = true;
          }
          saveWallet(key, record);
        }
      }

      if (record.funding.hash && !record.funding.complete) {
        const receipt = await client.waitForTransactionReceipt(
          hashFromBase58(record.funding.hash),
          {
            expectedNetworkHash: hashFromHex(`0x${networkId}`),
            timeoutMs: 60_000,
          },
        );
        if (receipt.execution instanceof UnsupportedRpcValue)
          throw new Error(
            "The funding result could not be read. Check funding again.",
          );
        if (receipt.execution.result !== "return")
          throw new Error(
            "Wallet funding failed. The funding transaction is saved for inspection.",
          );
      }
      const funded = await client.getBalance({
        address: wallet.account.address,
      });
      if (funded.rawBalance <= 0n)
        throw new Error(
          "Funding is not confirmed yet. Check funding to look for the original airdrop.",
        );
      if (record.funding.hash || funded.rawBalance >= minimumBalance)
        record.funding.complete = true;
      saveWallet(key, record);
      if (funded.rawBalance < minimumBalance)
        throw new Error(
          "The faucet did not provide enough funds for a world update.",
        );
    }
    return wallet;
  });
}

function readWallet(key: string): WalletRecord {
  const saved = localStorage.getItem(key);
  if (saved === null) {
    const record: WalletRecord = {
      version: 1,
      seed: toHex0x(crypto.getRandomValues(new Uint8Array(32))),
      funding: null,
    };
    saveWallet(key, record);
    return record;
  }
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    throw invalidWallet();
  }
  if (!value || typeof value !== "object") throw invalidWallet();
  const record = value as Partial<WalletRecord>;
  if (
    record.version !== 1 ||
    typeof record.seed !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(record.seed) ||
    !(
      record.funding === null ||
      (record.funding &&
        /^0x[0-9a-f]{32}$/.test(record.funding.nonce) &&
        typeof record.funding.complete === "boolean" &&
        (record.funding.hash === null ||
          typeof record.funding.hash === "string"))
    )
  )
    throw invalidWallet();
  if (record.funding?.hash) hashFromBase58(record.funding.hash);
  return record as WalletRecord;
}

function saveWallet(key: string, record: WalletRecord): void {
  localStorage.setItem(key, JSON.stringify(record));
}

function invalidWallet(): Error {
  return new Error(
    "The saved browser wallet is invalid. It has not been replaced.",
  );
}
