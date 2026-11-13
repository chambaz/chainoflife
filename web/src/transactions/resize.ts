import {
  addressFromHex,
  defaultWalletAdapter,
  toHex0x,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import { GameOfLife, WorldInitialized } from "@/contracts/game-of-life";
import { worldSize } from "@/indexer/schema";
import { isDecimal, isHex32 } from "@/lib/validation";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import {
  isPending,
  isPendingRequest,
  loadCranks,
  loadRequests,
  resizeStorageKey,
  transactionScope,
  withTransactionLock,
  type TransactionScope,
} from "./records";
import type { WriteBoundary, WriteResult } from "./write-boundary";

/** An "interrupted" reset was never broadcast, so it can be retried. */
export type ResizeRecord =
  | { readonly size: number; readonly status: "signing" }
  | {
      readonly size: number;
      readonly status: "indeterminate";
      readonly hash: string;
    }
  | {
      readonly size: number;
      readonly status: "committed";
      readonly hash: string;
      readonly epoch: string;
    }
  | { readonly size: number; readonly status: "failed" | "interrupted" };

export { resizeStorageKey };

export function subscribeResize(
  scope: TransactionScope,
  listener: () => void,
): () => void {
  const key = resizeStorageKey(scope);
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key) listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener("chain-of-life:resize", local);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener("chain-of-life:resize", local);
  };
}

export function loadResize(scope: TransactionScope): ResizeRecord | null {
  const raw = localStorage.getItem(resizeStorageKey(scope));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Record<string, unknown> | null;
  if (
    !value ||
    !(
      value.status === "signing" ||
      value.status === "failed" ||
      value.status === "interrupted" ||
      (value.status === "indeterminate" && isHex32(value.hash)) ||
      (value.status === "committed" &&
        isHex32(value.hash) &&
        isDecimal(value.epoch))
    )
  )
    throw new Error("Stored resize evidence is invalid");
  worldSize(value.size);
  return value as unknown as ResizeRecord;
}

function save(scope: TransactionScope, record: ResizeRecord): ResizeRecord {
  localStorage.setItem(resizeStorageKey(scope), JSON.stringify(record));
  window.dispatchEvent(
    new CustomEvent("chain-of-life:resize", {
      detail: resizeStorageKey(scope),
    }),
  );
  return record;
}

export function isPendingResize(record: ResizeRecord | null): boolean {
  return record?.status === "signing" || record?.status === "indeterminate";
}

export function assertNoPendingResize(scope: TransactionScope): void {
  if (isPendingResize(loadResize(scope)))
    throw new Error("Observe the pending resize before submitting more work.");
}

interface Parameters {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
}

export async function resizeWorld(
  params: Parameters,
  size: number,
): Promise<ResizeRecord> {
  worldSize(size);
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    assertNoPendingResize(scope);
    if (
      loadCranks(scope).some(isPending) ||
      loadRequests(scope).some(isPendingRequest)
    )
      throw new Error(
        "Finish or observe pending tick requests before resizing.",
      );
    save(scope, { size, status: "signing" });
    const result = await params.boundary.execute(
      GameOfLife.v0_1.resize.invocation(
        addressFromHex(params.config.contractAddress),
        gasAmount(params.profiles.crank.targetGasLimit),
        { size: BigInt(size) },
      ),
      {
        ...params.profiles.crank,
        observationTimeoutMs: Math.min(
          30_000,
          params.profiles.crank.observationTimeoutMs,
        ),
      },
      {
        onSigned: (hash) => {
          save(scope, { size, status: "indeterminate", hash });
        },
      },
    );
    return save(
      scope,
      applyResult(size, result, params.config.contractAddress),
    );
  });
}

export async function recoverResize(params: Parameters): Promise<ResizeRecord> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    const record = loadResize(scope);
    if (!record) throw new Error("No reset is available to recover.");
    // The SDK awaits onSigned, including saving this hash, before broadcast.
    // Holding the write lock ensures another tab is no longer submitting it.
    if (record.status === "signing")
      return save(scope, { size: record.size, status: "interrupted" });
    if (record.status !== "indeterminate") return record;
    return save(
      scope,
      applyResult(
        record.size,
        await params.boundary.observe(record.hash),
        params.config.contractAddress,
      ),
    );
  });
}

function applyResult(
  size: number,
  result: WriteResult,
  contract: string,
): ResizeRecord {
  if (result.kind === "indeterminate")
    return { size, status: "indeterminate", hash: result.hash };
  if (result.kind !== "committedSuccess") return { size, status: "failed" };
  try {
    const returns = defaultWalletAdapter.decodeExecutionReturns?.(
      result.receipt,
    );
    if (returns?.length !== 1) throw new Error("Missing resize return");
    const metadata = GameOfLife.v0_1.resize.decodeReturn(returns[0]!);
    const events = WorldInitialized.allFromReceipt(result.receipt, {
      address: addressFromHex(contract),
    });
    if (
      metadata.width !== BigInt(size) ||
      metadata.height !== BigInt(size) ||
      metadata.generation !== 0n ||
      events.length !== 1 ||
      events[0]!.fields.epoch !== metadata.epoch ||
      events[0]!.fields.size !== metadata.width ||
      toHex0x(events[0]!.fields.state_digest) !== toHex0x(metadata.state_digest)
    )
      throw new Error("Resize return and reset event disagree");
    return {
      size,
      status: "committed",
      hash: result.hash,
      epoch: metadata.epoch.toString(),
    };
  } catch {
    // The reset committed, but its receipt cannot be verified here.
    return { size, status: "indeterminate", hash: result.hash };
  }
}
