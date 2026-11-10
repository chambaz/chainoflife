import {
  addressFromHex,
  defaultWalletAdapter,
  toHex0x,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import { GameOfLife, WorldInitialized } from "@/contracts/game-of-life";
import { worldSize } from "@/indexer/schema";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import {
  hasBlockingCrank,
  loadCranks,
  loadRequests,
  transactionScope,
  transactionLockName,
  withTransactionLock,
  type TransactionScope,
} from "./records";
import type { WriteBoundary, WriteResult } from "./write-boundary";
import { recordMeasurement } from "./measurements";

export interface ResizeRecord {
  readonly version: 1;
  readonly size: number;
  readonly status: "signing" | "indeterminate" | "committed" | "failed";
  readonly hash: string | null;
  readonly submittedAt: number;
  readonly confirmedAt: number | null;
  readonly epoch: string | null;
  readonly digest: string | null;
  readonly gasUsed: string | null;
  readonly message: string | null;
}

export function resizeStorageKey(scope: TransactionScope): string {
  return `${transactionLockName(scope)}:resize`;
}

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
  const value = JSON.parse(raw) as Partial<ResizeRecord>;
  const decimal = (entry: unknown) =>
    entry === null ||
    (typeof entry === "string" && /^(0|[1-9][0-9]*)$/.test(entry));
  const hash = (entry: unknown) =>
    entry === null ||
    (typeof entry === "string" && /^0x[0-9a-f]{64}$/.test(entry));
  if (
    !value ||
    value.version !== 1 ||
    !["signing", "indeterminate", "committed", "failed"].includes(
      value.status ?? "",
    ) ||
    !hash(value.hash) ||
    !hash(value.digest) ||
    !decimal(value.epoch) ||
    !decimal(value.gasUsed) ||
    typeof value.submittedAt !== "number" ||
    !Number.isFinite(value.submittedAt) ||
    !(
      value.confirmedAt === null ||
      (typeof value.confirmedAt === "number" &&
        Number.isFinite(value.confirmedAt))
    ) ||
    !(value.message === null || typeof value.message === "string")
  )
    throw new Error("Stored resize evidence is invalid");
  worldSize(value.size);
  if (
    value.status === "committed" &&
    (!value.hash ||
      !value.digest ||
      value.epoch === null ||
      value.confirmedAt === null)
  )
    throw new Error("Stored resize receipt is incomplete");
  return value as ResizeRecord;
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

export function assertNoPendingResize(scope: TransactionScope): void {
  const record = loadResize(scope);
  if (
    record &&
    (record.status === "signing" || record.status === "indeterminate")
  )
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
      hasBlockingCrank(loadCranks(scope)) ||
      loadRequests(scope).some(({ status }) =>
        [
          "signing",
          "indeterminate",
          "accepted",
          "acceptedUntracked",
          "completionUnknown",
        ].includes(status),
      )
    )
      throw new Error(
        "Finish or observe pending tick requests before resizing.",
      );
    let record = save(scope, {
      version: 1,
      size,
      status: "signing",
      hash: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      epoch: null,
      digest: null,
      gasUsed: null,
      message: null,
    });
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
          record = save(scope, { ...record, hash, status: "indeterminate" });
        },
      },
    );
    const applied = save(
      scope,
      applyResult(record, result, params.config.contractAddress),
    );
    measure(params.config, applied);
    return applied;
  });
}

export async function recoverResize(params: Parameters): Promise<ResizeRecord> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    const record = loadResize(scope);
    if (!record) throw new Error("No reset is available to recover.");
    if (record.status === "committed" || record.status === "failed")
      return record;
    // The SDK awaits onSigned, including saving this hash, before broadcast.
    // Holding the write lock ensures another tab is no longer submitting it.
    if (!record.hash)
      return save(scope, {
        ...record,
        status: "failed",
        message: "Reset interrupted. Try again.",
      });
    const applied = save(
      scope,
      applyResult(
        record,
        await params.boundary.observe(
          record.hash,
          params.profiles.crank.observationTimeoutMs,
        ),
        params.config.contractAddress,
      ),
    );
    measure(params.config, applied);
    return applied;
  });
}

function measure(config: Parameters["config"], record: ResizeRecord): void {
  if (record.status !== "committed") return;
  recordMeasurement(config, {
    kind: "reset",
    size: record.size,
    epoch: record.epoch!,
    generation: "0",
    digest: record.digest!,
    hash: record.hash!,
    submittedAt: record.submittedAt,
    confirmedAt: record.confirmedAt!,
    gasUsed: record.gasUsed!,
    readyAt: null,
  });
}

function applyResult(
  record: ResizeRecord,
  result: WriteResult,
  contract: string,
): ResizeRecord {
  if (result.kind === "committedSuccess") {
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
        metadata.width !== BigInt(record.size) ||
        metadata.height !== BigInt(record.size) ||
        metadata.generation !== 0n ||
        events.length !== 1 ||
        events[0]!.fields.epoch !== metadata.epoch ||
        events[0]!.fields.size !== metadata.width ||
        toHex0x(events[0]!.fields.state_digest) !==
          toHex0x(metadata.state_digest)
      )
        throw new Error("Resize return and reset event disagree");
      return {
        ...record,
        hash: result.hash,
        status: "committed",
        confirmedAt: Date.now(),
        epoch: metadata.epoch.toString(),
        digest: toHex0x(metadata.state_digest),
        gasUsed: result.receipt.gasUsed.toString(),
        message: null,
      };
    } catch (error) {
      return {
        ...record,
        hash: result.hash,
        status: "indeterminate",
        message:
          error instanceof Error
            ? error.message
            : "Cannot verify resize receipt",
      };
    }
  }
  if (result.kind === "indeterminate")
    return {
      ...record,
      hash: result.hash ?? record.hash,
      status: "indeterminate",
      message:
        result.message ??
        "Resize outcome is uncertain. Observe the original transaction.",
    };
  return {
    ...record,
    status: "failed",
    message:
      result.kind === "invalid"
        ? result.reason
        : result.kind === "preSubmissionFailure"
          ? result.message
          : "Resize failed. Queued requests must finish before reset.",
  };
}
