import {
  addressFromHex,
  bytesEqual,
  defaultWalletAdapter,
  toHex0x,
  type TransactionReceipt,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import type { AppConfig, LifeTransactionProfiles } from "@/config";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
} from "@/contracts/game-of-life";
import type { VisitorWallet } from "@/wallet/visitor-wallet";
import {
  isPending,
  loadCranks,
  loadRequests,
  saveCranks,
  saveRequests,
  transactionScope,
  upsert,
  withTransactionLock,
  type CrankRecord,
  type Outcome,
  type Submission,
  type TickRequestRecord,
  type TransactionScope,
} from "@/transactions/records";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import { assertNoPendingResize } from "./resize";

export interface WorkflowResult {
  readonly requests: readonly TickRequestRecord[];
  readonly cranks: readonly CrankRecord[];
  /** Explains why the action did not advance the world, when it did not. */
  readonly message: string | null;
}

interface Parameters {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
}

interface Transition<T> {
  readonly record: T;
  readonly message: string | null;
}

interface CrankTransition extends Transition<CrankRecord> {
  /** This wallet's accepted request that the crank processed. */
  readonly processed?: { readonly requestId: string; readonly epoch: string };
}

const INTERRUPTED = "Signing was interrupted. Try again.";

/** Process an accepted request, or submit a new request and process it. */
export async function advance(params: Parameters): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    assertNoPendingResize(scope);
    if (loadRequests(scope).some(({ status }) => status === "accepted"))
      return crankWhileLocked(params, scope);
    let record: TickRequestRecord = {
      localId: crypto.randomUUID(),
      status: "signing",
    };
    saveRequests(scope, [...loadRequests(scope), record]);
    const result = await params.boundary.execute(
      GameOfLife.v0_1.requestTick.invocation(
        addressFromHex(params.config.contractAddress),
        gasAmount(params.profiles.request.targetGasLimit),
      ),
      params.profiles.request,
      {
        onSigned(hash) {
          record = {
            localId: record.localId,
            status: "indeterminate",
            transactionHash: hash,
          };
          saveRequests(scope, upsert(loadRequests(scope), record));
        },
      },
    );
    const outcome = requestOutcome(record, result, params);
    const saved = saveRequest(scope, outcome);
    return outcome.record.status === "accepted"
      ? crankWhileLocked(params, scope)
      : saved;
  });
}

/**
 * Resolve a pending request. Under the lock, a record without a hash was never
 * broadcast, so it fails. Otherwise, observe the original transaction.
 */
export async function recoverRequest(
  params: Parameters,
  localId: string,
): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    const record = loadRequests(scope).find(
      (request) => request.localId === localId,
    );
    if (!record || !isPending(record))
      throw new Error("This request is no longer pending");
    // Checking only observes. The next Advance processes an accepted request.
    return saveRequest(
      scope,
      record.status === "signing"
        ? interrupted(record)
        : requestOutcome(
            record,
            await params.boundary.observe(record.transactionHash),
            params,
          ),
    );
  });
}

/** Resolve a pending crank with the same rules as {@link recoverRequest}. */
export async function recoverCrank(
  params: Parameters,
  localId: string,
): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    const crank = loadCranks(scope).find(
      (record) => record.localId === localId,
    );
    if (!crank || !isPending(crank))
      throw new Error("This crank is no longer pending");
    return finishCrank(
      scope,
      crank.status === "signing"
        ? interrupted(crank)
        : crankOutcome(
            crank,
            await params.boundary.observe(crank.transactionHash),
            params,
          ),
    );
  });
}

function saveRequest(
  scope: TransactionScope,
  outcome: Transition<TickRequestRecord>,
): WorkflowResult {
  return {
    requests: saveRequests(scope, upsert(loadRequests(scope), outcome.record)),
    cranks: loadCranks(scope),
    message: outcome.message,
  };
}

function finishCrank(
  scope: TransactionScope,
  outcome: CrankTransition,
): WorkflowResult {
  const { processed } = outcome;
  const requests = loadRequests(scope);
  return {
    requests: processed
      ? saveRequests(
          scope,
          requests.map((request) =>
            request.status === "accepted" &&
            request.requestId === processed.requestId &&
            request.epoch === processed.epoch
              ? {
                  localId: request.localId,
                  status: "advanced",
                  transactionHash: request.transactionHash,
                }
              : request,
          ),
        )
      : requests,
    cranks: saveCranks(scope, upsert(loadCranks(scope), outcome.record)),
    message: outcome.message,
  };
}

async function crankWhileLocked(
  params: Parameters,
  scope: TransactionScope,
): Promise<WorkflowResult> {
  assertNoPendingResize(scope);
  if (loadCranks(scope).some(isPending))
    throw new Error(
      "Resolve the existing crank attempt before signing another",
    );
  let crank: CrankRecord = { localId: crypto.randomUUID(), status: "signing" };
  saveCranks(scope, [...loadCranks(scope), crank]);
  const result = await params.boundary.execute(
    GameOfLife.v0_1.processNextTick.invocation(
      addressFromHex(params.config.contractAddress),
      gasAmount(params.profiles.crank.targetGasLimit),
    ),
    params.profiles.crank,
    {
      onSigned(hash) {
        crank = {
          localId: crank.localId,
          status: "indeterminate",
          transactionHash: hash,
        };
        saveCranks(scope, upsert(loadCranks(scope), crank));
      },
    },
  );
  return finishCrank(scope, crankOutcome(crank, result, params));
}

function interrupted(record: {
  readonly localId: string;
}): Transition<Outcome<"failed">> {
  return {
    record: {
      localId: record.localId,
      status: "failed",
      transactionHash: null,
    },
    message: INTERRUPTED,
  };
}

function requestOutcome(
  record: TickRequestRecord,
  result: WriteResult,
  params: Parameters,
): Transition<TickRequestRecord> {
  const { localId } = record;
  if (result.kind !== "committedSuccess")
    return writeFailure(localId, result, "Request");
  const events = TickRequested.allFromReceipt(result.receipt, {
    address: addressFromHex(params.config.contractAddress),
  }).filter(({ topics }) =>
    bytesEqual(topics.requested_by, params.wallet.account.address),
  );
  if (events.length !== 1)
    return {
      record: {
        localId,
        status: "completionUnknown",
        transactionHash: result.hash,
      },
      message:
        "The request committed, but its receipt did not identify one queued request.",
    };
  return {
    record: {
      localId,
      status: "accepted",
      transactionHash: result.hash,
      requestId: toHex0x(events[0]!.topics.request_id),
      epoch: events[0]!.fields.epoch.toString(),
      receiptBlock: result.receipt.blockHeight.toString(),
      observedThroughBlock: null,
    },
    message: null,
  };
}

function crankOutcome(
  crank: CrankRecord,
  result: WriteResult,
  params: Parameters,
): CrankTransition {
  const { localId } = crank;
  if (result.kind !== "committedSuccess")
    return writeFailure(localId, result, "Crank");
  const transactionHash = result.hash;
  try {
    const decoded = decodeCrankReturn(result.receipt);
    const events = GenerationAdvanced.allFromReceipt(result.receipt, {
      address: addressFromHex(params.config.contractAddress),
    });
    if (decoded === null && events.length === 0)
      return {
        record: { localId, status: "noWork", transactionHash },
        message: "No queued request remained to process.",
      };
    if (decoded === null || events.length !== 1)
      throw new Error("Crank return and GenerationAdvanced event disagree");
    const event = events[0]!;
    if (
      !bytesEqual(decoded.request_id, event.topics.request_id) ||
      !bytesEqual(decoded.requested_by, event.fields.requested_by) ||
      decoded.metadata.generation !== event.fields.generation ||
      decoded.metadata.epoch !== event.fields.epoch ||
      decoded.metadata.population !== event.fields.population ||
      !bytesEqual(decoded.metadata.state_digest, event.fields.state_digest)
    )
      throw new Error("Crank return does not match GenerationAdvanced event");
    return {
      record: { localId, status: "advanced", transactionHash },
      message: null,
      ...(bytesEqual(event.fields.requested_by, params.wallet.account.address)
        ? {
            processed: {
              requestId: toHex0x(event.topics.request_id),
              epoch: event.fields.epoch.toString(),
            },
          }
        : {}),
    };
  } catch (cause) {
    return {
      record: { localId, status: "failed", transactionHash },
      message:
        cause instanceof Error
          ? cause.message
          : "Crank receipt is incompatible",
    };
  }
}

function decodeCrankReturn(receipt: TransactionReceipt) {
  const returns = defaultWalletAdapter.decodeExecutionReturns?.(receipt);
  if (!returns || returns.length !== 1)
    throw new Error("Crank receipt must contain one wallet child return");
  return GameOfLife.v0_1.processNextTick.decodeReturn(returns[0]!);
}

function writeFailure(
  localId: string,
  result: Exclude<WriteResult, { kind: "committedSuccess" }>,
  label: "Request" | "Crank",
): Transition<Submission | Outcome<"failed">> {
  switch (result.kind) {
    case "preSubmissionFailure":
      return {
        record: { localId, status: "failed", transactionHash: null },
        message: result.message,
      };
    case "invalid":
      return {
        record: { localId, status: "failed", transactionHash: result.hash },
        message: result.message,
      };
    case "committedFailure":
      return {
        record: { localId, status: "failed", transactionHash: result.hash },
        message: `${label} transaction committed with a contract failure`,
      };
    case "indeterminate":
      return {
        record: {
          localId,
          status: "indeterminate",
          transactionHash: result.hash,
        },
        message: result.message,
      };
  }
}
