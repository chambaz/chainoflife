import type { AppConfig } from "@/config";
import { isDecimal, isHex32 } from "@/lib/validation";

// Bump the version in the storage keys when the stored record format changes.
const STORAGE_VERSION = "v2";
const HISTORY_LIMIT = 50;

/**
 * A submitted write. A "signing" record has no hash, so it was never
 * broadcast: the SDK awaits onSigned, which saves the hash, before broadcast.
 */
export type Submission =
  | { readonly localId: string; readonly status: "signing" }
  | {
      readonly localId: string;
      readonly status: "indeterminate";
      readonly transactionHash: string;
    };

export interface Outcome<Status extends string> {
  readonly localId: string;
  readonly status: Status;
  readonly transactionHash: string | null;
}

/** A committed request that waits in the contract queue. */
export interface AcceptedRequest {
  readonly localId: string;
  readonly status: "accepted";
  readonly transactionHash: string;
  readonly requestId: string;
  readonly epoch: string;
  readonly receiptBlock: string;
  readonly observedThroughBlock: string | null;
}

export type TickRequestRecord =
  | Submission
  | AcceptedRequest
  | Outcome<"advanced" | "failed" | "completionUnknown">;

export type CrankRecord =
  Submission | Outcome<"advanced" | "noWork" | "failed">;

export interface TransactionScope {
  readonly networkId: string;
  readonly expectedCaller: string;
  readonly contractAddress: string;
}

export function transactionScope(
  config: Pick<AppConfig, "networkId" | "contractAddress">,
  expectedCaller: string,
): TransactionScope {
  return {
    networkId: config.networkId,
    expectedCaller,
    contractAddress: config.contractAddress,
  };
}

export function requestStorageKey(scope: TransactionScope): string {
  return scopedKey("requests", scope);
}

export function crankStorageKey(scope: TransactionScope): string {
  return scopedKey("cranks", scope);
}

export function resizeStorageKey(scope: TransactionScope): string {
  return scopedKey("resize", scope);
}

export function transactionLockName(scope: TransactionScope): string {
  return scopedKey("lock", scope);
}

export function isTransactionStorageKey(
  scope: TransactionScope,
  key: string | null,
): boolean {
  return (
    key === null ||
    key === requestStorageKey(scope) ||
    key === crankStorageKey(scope)
  );
}

export function loadRequests(scope: TransactionScope): TickRequestRecord[] {
  return load(requestStorageKey(scope), isRequest);
}

export function loadCranks(scope: TransactionScope): CrankRecord[] {
  return load(crankStorageKey(scope), isCrank);
}

export function saveRequests(
  scope: TransactionScope,
  records: readonly TickRequestRecord[],
): TickRequestRecord[] {
  return save(requestStorageKey(scope), records, isRequest, isPendingRequest);
}

export function saveCranks(
  scope: TransactionScope,
  records: readonly CrankRecord[],
): CrankRecord[] {
  return save(crankStorageKey(scope), records, isCrank, isPending);
}

export async function withTransactionLock<T>(
  scope: TransactionScope,
  action: () => Promise<T>,
): Promise<T> {
  if (navigator.locks === undefined)
    throw new Error(
      "This browser must support Web Locks for safe local signing",
    );
  return navigator.locks.request(
    transactionLockName(scope),
    { mode: "exclusive" },
    action,
  );
}

export function upsert<T extends { readonly localId: string }>(
  records: readonly T[],
  record: T,
): T[] {
  const index = records.findIndex(({ localId }) => localId === record.localId);
  return index === -1
    ? [...records, record]
    : records.map((current, offset) => (offset === index ? record : current));
}

export function isPending(
  record: TickRequestRecord | CrankRecord,
): record is Submission {
  return record.status === "signing" || record.status === "indeterminate";
}

/** Requests that are unresolved or still wait in the contract queue. */
export function isPendingRequest(record: TickRequestRecord): boolean {
  return isPending(record) || record.status === "accepted";
}

function scopedKey(kind: string, scope: TransactionScope): string {
  return [
    `chain-of-life:${kind}:${STORAGE_VERSION}`,
    scope.networkId,
    scope.expectedCaller,
    scope.contractAddress,
  ].join(":");
}

function load<T>(key: string, valid: (value: unknown) => value is T): T[] {
  const value = localStorage.getItem(key);
  if (value === null) return [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Reported below as invalid storage.
  }
  if (!Array.isArray(parsed) || !parsed.every(valid)) throw invalidStorage(key);
  return parsed;
}

// Keep every pending record and the newest terminal records. Records are
// appended in submission order, so the first terminal records are the oldest.
function save<T>(
  key: string,
  records: readonly T[],
  valid: (value: unknown) => value is T,
  pending: (record: T) => boolean,
): T[] {
  let excess = records.filter((record) => !pending(record)).length;
  excess -= HISTORY_LIMIT;
  const kept = records.filter((record) => pending(record) || excess-- <= 0);
  if (!kept.every(valid)) throw invalidStorage(key);
  localStorage.setItem(key, JSON.stringify(kept));
  return kept;
}

function invalidStorage(key: string): Error {
  return new Error(`Stored transaction data is invalid at ${key}`);
}

function isRequest(value: unknown): value is TickRequestRecord {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case "accepted":
      return (
        validId(value.localId) &&
        isHex32(value.transactionHash) &&
        isHex32(value.requestId) &&
        isDecimal(value.epoch) &&
        isDecimal(value.receiptBlock) &&
        (value.observedThroughBlock === null ||
          (isDecimal(value.observedThroughBlock) &&
            BigInt(value.observedThroughBlock) >= BigInt(value.receiptBlock)))
      );
    case "advanced":
    case "failed":
    case "completionUnknown":
      return isOutcome(value);
    default:
      return isSubmission(value);
  }
}

function isCrank(value: unknown): value is CrankRecord {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case "advanced":
    case "noWork":
    case "failed":
      return isOutcome(value);
    default:
      return isSubmission(value);
  }
}

function isSubmission(value: Record<string, unknown>): boolean {
  return (
    validId(value.localId) &&
    (value.status === "signing" ||
      (value.status === "indeterminate" && isHex32(value.transactionHash)))
  );
}

function isOutcome(value: Record<string, unknown>): boolean {
  return (
    validId(value.localId) &&
    (value.transactionHash === null || isHex32(value.transactionHash))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
