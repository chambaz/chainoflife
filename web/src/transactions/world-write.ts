import {
  addressFromHex,
  bytesEqual,
  defaultWalletAdapter,
  type TransactionReceipt,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";
import {
  GameOfLife,
  GenerationAdvanced,
  WorldInitialized,
} from "@/contracts/game-of-life";
import { worldSize } from "@/indexer/schema";
import { isDecimal, isHex32 } from "@/lib/validation";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import type { WriteBoundary, WriteResult } from "./write-boundary";

/** A world write: one advance or one resize transaction. */
export type WriteRequest =
  | { readonly kind: "advance" }
  | { readonly kind: "resize"; readonly size: number };

/**
 * The latest world write of one wallet. A "signing" write has no hash, so it
 * was never broadcast: the SDK awaits onSigned, which saves the hash, first.
 */
export type WorldWrite = WriteRequest &
  (
    | { readonly status: "signing" }
    | { readonly status: "indeterminate"; readonly transactionHash: string }
    | {
        readonly status: "committed";
        readonly transactionHash: string;
        readonly epoch: string;
      }
    | { readonly status: "failed"; readonly message: string }
  );

export interface WriteScope {
  readonly networkId: string;
  readonly contractAddress: string;
  readonly wallet: string;
}

export interface WriteParameters {
  readonly config: Pick<
    AppConfig,
    "networkId" | "contractAddress" | "transactionPolicy"
  >;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
}

const CHANGED = "chain-of-life:write";
const INTERRUPTED = "Signing was interrupted. Try again.";

export function writeScope(
  config: Pick<AppConfig, "networkId" | "contractAddress">,
  wallet: Pick<VisitorWallet, "addressHex">,
): WriteScope {
  return {
    networkId: config.networkId,
    contractAddress: config.contractAddress,
    wallet: wallet.addressHex,
  };
}

export function writeStorageKey(scope: WriteScope): string {
  return [
    "chain-of-life:write:v3",
    scope.networkId,
    scope.wallet,
    scope.contractAddress,
  ].join(":");
}

export type PendingWrite = Extract<
  WorldWrite,
  { readonly status: "signing" | "indeterminate" }
>;

export function isPending(write: WorldWrite | null): write is PendingWrite {
  return write?.status === "signing" || write?.status === "indeterminate";
}

export function loadWrite(scope: WriteScope): WorldWrite | null {
  const raw = localStorage.getItem(writeStorageKey(scope));
  if (raw === null) return null;
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // Reported below.
  }
  if (!isWorldWrite(value))
    throw new Error("Stored world-write evidence is invalid");
  return value;
}

/** Calls `listener` when this tab or another tab saves the scope's write. */
export function subscribeWrite(
  scope: WriteScope,
  listener: () => void,
): () => void {
  const key = writeStorageKey(scope);
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key) listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(CHANGED, local);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(CHANGED, local);
  };
}

/** Signs and submits one world write. Only one write per wallet can be pending. */
export async function submitWrite(
  params: WriteParameters,
  request: WriteRequest,
): Promise<WorldWrite> {
  if (request.kind === "resize") worldSize(request.size);
  const scope = writeScope(params.config, params.wallet);
  return withWriteLock(scope, async () => {
    if (isPending(loadWrite(scope)))
      throw new Error("Wait for the pending transaction to finish.");
    save(scope, { ...request, status: "signing" });
    const address = addressFromHex(params.config.contractAddress);
    const gas = gasAmount(params.config.transactionPolicy.targetGasLimit);
    const invocation =
      request.kind === "advance"
        ? GameOfLife.v0_1.advance.invocation(address, gas)
        : GameOfLife.v0_1.resize.invocation(address, gas, {
            size: BigInt(request.size),
          });
    const result = await params.boundary.execute(
      invocation,
      params.config.transactionPolicy,
      {
        onSigned(transactionHash) {
          save(scope, { ...request, status: "indeterminate", transactionHash });
        },
      },
    );
    return save(scope, outcome(request, result, params));
  });
}

/**
 * Resolves the pending write. Under the lock, a write without a hash was never
 * broadcast, so it fails. Otherwise, observe the original transaction. This
 * never signs or submits anything.
 */
export async function recoverWrite(
  params: WriteParameters,
): Promise<WorldWrite | null> {
  const scope = writeScope(params.config, params.wallet);
  return withWriteLock(scope, async () => {
    const write = loadWrite(scope);
    if (!write || !isPending(write)) return write;
    const request = requestOf(write);
    if (write.status === "signing")
      return save(scope, {
        ...request,
        status: "failed",
        message: INTERRUPTED,
      });
    return save(
      scope,
      outcome(
        request,
        await params.boundary.observe(write.transactionHash),
        params,
      ),
    );
  });
}

function withWriteLock<T>(
  scope: WriteScope,
  action: () => Promise<T>,
): Promise<T> {
  if (navigator.locks === undefined)
    throw new Error(
      "This browser must support Web Locks for safe local signing",
    );
  return navigator.locks.request(
    `${writeStorageKey(scope)}:lock`,
    { mode: "exclusive" },
    action,
  );
}

function save(scope: WriteScope, write: WorldWrite): WorldWrite {
  const key = writeStorageKey(scope);
  localStorage.setItem(key, JSON.stringify(write));
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
  return write;
}

function requestOf(write: WorldWrite): WriteRequest {
  return write.kind === "advance"
    ? { kind: "advance" }
    : { kind: "resize", size: write.size };
}

function outcome(
  request: WriteRequest,
  result: WriteResult,
  params: WriteParameters,
): WorldWrite {
  switch (result.kind) {
    case "indeterminate":
      return {
        ...request,
        status: "indeterminate",
        transactionHash: result.hash,
      };
    case "preSubmissionFailure":
    case "invalid":
      return { ...request, status: "failed", message: result.message };
    case "committedFailure":
      return {
        ...request,
        status: "failed",
        message:
          request.kind === "advance"
            ? "The advance failed on-chain. Try again."
            : "The reset failed on-chain. Try again.",
      };
    case "committedSuccess":
      try {
        return {
          ...request,
          status: "committed",
          transactionHash: result.hash,
          epoch: committedEpoch(request, result.receipt, params),
        };
      } catch (cause) {
        return {
          ...request,
          status: "failed",
          message: `The transaction committed, but its receipt is not valid: ${
            cause instanceof Error ? cause.message : "unknown error"
          }`,
        };
      }
  }
}

// Check that the return value and the single lifecycle event agree.
function committedEpoch(
  request: WriteRequest,
  receipt: TransactionReceipt,
  params: WriteParameters,
): string {
  const returns = defaultWalletAdapter.decodeExecutionReturns?.(receipt);
  if (returns?.length !== 1) throw new Error("missing return value");
  const address = addressFromHex(params.config.contractAddress);
  if (request.kind === "resize") {
    const metadata = GameOfLife.v0_1.resize.decodeReturn(returns[0]!);
    const events = WorldInitialized.allFromReceipt(receipt, { address });
    const event = events[0];
    if (
      events.length !== 1 ||
      metadata.size !== BigInt(request.size) ||
      metadata.generation !== 0n ||
      event!.fields.epoch !== metadata.epoch ||
      event!.fields.size !== metadata.size ||
      !bytesEqual(event!.fields.state_digest, metadata.state_digest)
    )
      throw new Error("reset return and event disagree");
    return metadata.epoch.toString();
  }
  const metadata = GameOfLife.v0_1.advance.decodeReturn(returns[0]!);
  const events = GenerationAdvanced.allFromReceipt(receipt, { address });
  const event = events[0];
  if (
    events.length !== 1 ||
    !bytesEqual(event!.topics.advanced_by, params.wallet.account.address) ||
    event!.fields.epoch !== metadata.epoch ||
    event!.fields.generation !== metadata.generation ||
    event!.fields.population !== metadata.population ||
    !bytesEqual(event!.fields.state_digest, metadata.state_digest)
  )
    throw new Error("advance return and event disagree");
  return metadata.epoch.toString();
}

function isWorldWrite(value: unknown): value is WorldWrite {
  if (typeof value !== "object" || value === null) return false;
  const write = value as Record<string, unknown>;
  const request =
    write.kind === "advance" ||
    (write.kind === "resize" &&
      typeof write.size === "number" &&
      Number.isSafeInteger(write.size));
  switch (write.status) {
    case "signing":
      return request;
    case "indeterminate":
      return request && isHex32(write.transactionHash);
    case "committed":
      return (
        request && isHex32(write.transactionHash) && isDecimal(write.epoch)
      );
    case "failed":
      return request && typeof write.message === "string";
    default:
      return false;
  }
}
