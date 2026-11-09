import {
  addressFromHex,
  bytesEqual,
  defaultWalletAdapter,
  toHex0x,
  type ThruputClient,
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
  hasBlockingCrank,
  loadCranks,
  loadRequests,
  saveCranks,
  saveRequests,
  transactionScope,
  upsert,
  withTransactionLock,
  type CrankRecord,
  type TickRequestRecord,
} from "@/transactions/records";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

export interface WorkflowResult {
  readonly requests: readonly TickRequestRecord[];
  readonly cranks: readonly CrankRecord[];
}

export async function requestTick(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
  readonly automaticCrank: boolean;
}): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    let requests: readonly TickRequestRecord[] = loadRequests(scope);
    let cranks: readonly CrankRecord[] = loadCranks(scope);
    const submittedAt = new Date().toISOString();
    let record: TickRequestRecord = {
      schemaVersion: 1,
      localId: crypto.randomUUID(),
      requester: params.wallet.addressHex,
      status: "signing",
      transactionHash: null,
      requestId: null,
      receiptBlock: null,
      submittedAt,
      acceptedAt: null,
      observedThroughBlock: null,
      resultingGeneration: null,
      resultingPopulation: null,
      resultingStateDigest: null,
      advancedTransactionHash: null,
      diagnostic: null,
    };
    requests = saveRequests(scope, [...requests, record]);
    const target = GameOfLife.v0_1.requestTick.invocation(
      addressFromHex(params.config.contractAddress),
      gasAmount(params.profiles.request.targetGasLimit),
    );
    const result = await params.boundary.execute(
      target,
      params.profiles.request,
      {
        onSigned(hash) {
          record = { ...record, transactionHash: hash };
          requests = saveRequests(scope, upsert(loadRequests(scope), record));
        },
      },
    );
    record = admissionRecord(
      record,
      result,
      params.config.contractAddress,
      params.wallet,
    );
    requests = saveRequests(scope, upsert(loadRequests(scope), record));
    if (record.status === "accepted" && params.automaticCrank) {
      const processed = await crankWhileLocked({ ...params, scope });
      requests = processed.requests;
      cranks = processed.cranks;
    }
    return { requests, cranks };
  });
}

export async function processOneTick(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
}): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () =>
    crankWhileLocked({ ...params, scope }),
  );
}

export async function recoverRequest(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
  readonly localId: string;
}): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    let requests = loadRequests(scope);
    const record = requests.find(({ localId }) => localId === params.localId);
    if (!record?.transactionHash)
      throw new Error(
        "This request has no durable transaction hash to observe",
      );
    const result = await params.boundary.observe(
      record.transactionHash,
      params.profiles.request.observationTimeoutMs,
    );
    const recovered =
      record.status === "acceptedUntracked" && result.kind === "indeterminate"
        ? {
            ...record,
            diagnostic:
              "Committed acceptance remains untracked; receipt observation is still unavailable",
          }
        : admissionRecord(
            record,
            result,
            params.config.contractAddress,
            params.wallet,
          );
    requests = saveRequests(scope, upsert(requests, recovered));
    return { requests, cranks: loadCranks(scope) };
  });
}

export async function recoverCrank(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
  readonly localId: string;
}): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    const requests = loadRequests(scope);
    let cranks = loadCranks(scope);
    const crank = cranks.find(({ localId }) => localId === params.localId);
    if (!crank?.transactionHash)
      throw new Error("This crank has no durable transaction hash to observe");
    const result = await params.boundary.observe(
      crank.transactionHash,
      params.profiles.crank.observationTimeoutMs,
    );
    const applied = crankResult(
      crank,
      requests,
      result,
      params.config.contractAddress,
    );
    const savedRequests = saveRequests(scope, applied.requests);
    cranks = saveCranks(scope, upsert(cranks, applied.crank));
    return { requests: savedRequests, cranks };
  });
}

export async function abandonUnsignedRequest(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly wallet: VisitorWallet;
  readonly localId: string;
}): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    let requests = loadRequests(scope);
    const record = requests.find(({ localId }) => localId === params.localId);
    if (
      !record ||
      record.status !== "signing" ||
      record.transactionHash !== null
    )
      throw new Error(
        "Only a restored hashless signing request can be abandoned",
      );
    requests = saveRequests(
      scope,
      upsert(requests, {
        ...record,
        status: "failed",
        diagnostic: "User confirmed that signing did not complete",
      }),
    );
    return { requests, cranks: loadCranks(scope) };
  });
}

export async function abandonUnsignedCrank(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly wallet: VisitorWallet;
  readonly localId: string;
}): Promise<WorkflowResult> {
  const scope = transactionScope(params.config, params.wallet.addressHex);
  return withTransactionLock(scope, async () => {
    const requests = loadRequests(scope);
    let cranks = loadCranks(scope);
    const crank = cranks.find(({ localId }) => localId === params.localId);
    if (!crank || crank.status !== "signing" || crank.transactionHash !== null)
      throw new Error(
        "Only a restored hashless signing crank can be abandoned",
      );
    cranks = saveCranks(
      scope,
      upsert(cranks, {
        ...crank,
        status: "failed",
        completedAt: new Date().toISOString(),
        diagnostic: "User confirmed that signing did not complete",
      }),
    );
    return { requests, cranks };
  });
}

async function crankWhileLocked(params: {
  readonly config: Pick<AppConfig, "networkId" | "contractAddress">;
  readonly profiles: LifeTransactionProfiles;
  readonly wallet: VisitorWallet;
  readonly boundary: WriteBoundary;
  readonly scope: ReturnType<typeof transactionScope>;
}): Promise<WorkflowResult> {
  let requests = loadRequests(params.scope);
  let cranks = loadCranks(params.scope);
  if (hasBlockingCrank(cranks))
    throw new Error(
      "Resolve the existing crank attempt before signing another",
    );
  let crank: CrankRecord = {
    schemaVersion: 1,
    localId: crypto.randomUUID(),
    submittedBy: params.wallet.addressHex,
    status: "signing",
    transactionHash: null,
    submittedAt: new Date().toISOString(),
    completedAt: null,
    receiptBlock: null,
    consumedRequestId: null,
    resultingGeneration: null,
    resultingPopulation: null,
    resultingStateDigest: null,
    diagnostic: null,
  };
  cranks = saveCranks(params.scope, [...cranks, crank]);
  const target = GameOfLife.v0_1.processNextTick.invocation(
    addressFromHex(params.config.contractAddress),
    gasAmount(params.profiles.crank.targetGasLimit),
  );
  const result = await params.boundary.execute(target, params.profiles.crank, {
    onSigned(hash) {
      crank = { ...crank, transactionHash: hash };
      cranks = saveCranks(
        params.scope,
        upsert(loadCranks(params.scope), crank),
      );
    },
  });
  const applied = crankResult(
    crank,
    requests,
    result,
    params.config.contractAddress,
  );
  requests = saveRequests(params.scope, applied.requests);
  cranks = saveCranks(
    params.scope,
    upsert(loadCranks(params.scope), applied.crank),
  );
  return { requests, cranks };
}

function admissionRecord(
  record: TickRequestRecord,
  result: WriteResult,
  contractAddress: string,
  wallet: VisitorWallet,
): TickRequestRecord {
  const classified = writeFailure(record, result);
  if (classified) return classified;
  if (result.kind !== "committedSuccess")
    throw new Error("Unreachable request transaction result");
  const receipt = result.receipt;
  const events = TickRequested.allFromReceipt(receipt, {
    address: addressFromHex(contractAddress),
  }).filter(({ topics }) =>
    bytesEqual(topics.requested_by, wallet.account.address),
  );
  const common = {
    ...record,
    receiptBlock: receipt.blockHeight.toString(),
    acceptedAt: new Date().toISOString(),
  };
  if (events.length !== 1)
    return {
      ...common,
      status: "acceptedUntracked",
      diagnostic:
        "Committed receipt did not contain exactly one matching TickRequested event",
    };
  return {
    ...common,
    status: "accepted",
    requestId: toHex0x(events[0]!.topics.request_id),
  };
}

function crankResult(
  crank: CrankRecord,
  requests: readonly TickRequestRecord[],
  result: WriteResult,
  contractAddress: string,
): { readonly crank: CrankRecord; readonly requests: TickRequestRecord[] } {
  const failure = crankFailure(crank, result);
  if (failure) return { crank: failure, requests: [...requests] };
  if (result.kind !== "committedSuccess")
    throw new Error("Unreachable crank transaction result");
  const receipt = result.receipt;
  const completedAt = new Date().toISOString();
  try {
    const decoded = decodeCrankReturn(receipt);
    const events = GenerationAdvanced.allFromReceipt(receipt, {
      address: addressFromHex(contractAddress),
    });
    if (decoded === null && events.length === 0)
      return {
        crank: {
          ...crank,
          status: "noWork",
          completedAt,
          receiptBlock: receipt.blockHeight.toString(),
          diagnostic: "Crank found no work",
        },
        requests: [...requests],
      };
    if (decoded === null || events.length !== 1)
      throw new Error("Crank return and GenerationAdvanced event disagree");
    const event = events[0]!;
    if (
      !bytesEqual(decoded.request_id, event.topics.request_id) ||
      !bytesEqual(decoded.requested_by, event.fields.requested_by) ||
      decoded.metadata.generation !== event.fields.generation ||
      decoded.metadata.population !== event.fields.population ||
      !bytesEqual(decoded.metadata.state_digest, event.fields.state_digest)
    )
      throw new Error("Crank return does not match GenerationAdvanced event");
    const requestId = toHex0x(event.topics.request_id);
    const requester = toHex0x(event.fields.requested_by);
    const advancedHash = toHex0x(receipt.transactionHash);
    return {
      crank: {
        ...crank,
        status: "advanced",
        completedAt,
        receiptBlock: receipt.blockHeight.toString(),
        consumedRequestId: requestId,
        resultingGeneration: event.fields.generation.toString(),
        resultingPopulation: event.fields.population.toString(),
        resultingStateDigest: toHex0x(event.fields.state_digest),
        diagnostic: `Advanced a request from ${requester}`,
      },
      requests: requests.map((request) =>
        request.requestId === requestId && request.requester === requester
          ? {
              ...request,
              status: "advanced",
              resultingGeneration: event.fields.generation.toString(),
              resultingPopulation: event.fields.population.toString(),
              resultingStateDigest: toHex0x(event.fields.state_digest),
              advancedTransactionHash: advancedHash,
            }
          : request,
      ),
    };
  } catch (cause) {
    return {
      crank: {
        ...crank,
        status: "incompatible",
        completedAt,
        receiptBlock: receipt.blockHeight.toString(),
        diagnostic: describe(cause),
      },
      requests: [...requests],
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
  record: TickRequestRecord,
  result: WriteResult,
): TickRequestRecord | null {
  switch (result.kind) {
    case "committedSuccess":
      return null;
    case "preSubmissionFailure":
      return { ...record, status: "failed", diagnostic: result.message };
    case "invalid":
      return {
        ...record,
        status: "invalid",
        transactionHash: result.hash,
        diagnostic: result.reason,
      };
    case "committedFailure":
      return {
        ...record,
        status: "failed",
        transactionHash: result.hash,
        receiptBlock: result.receipt.blockHeight.toString(),
        diagnostic: "Request transaction committed with a contract failure",
      };
    case "indeterminate":
      return {
        ...record,
        status: "indeterminate",
        transactionHash: result.hash ?? record.transactionHash,
        diagnostic: `Transaction outcome is ${result.reason}`,
      };
  }
}

function crankFailure(
  crank: CrankRecord,
  result: WriteResult,
): CrankRecord | null {
  const completedAt = new Date().toISOString();
  switch (result.kind) {
    case "committedSuccess":
      return null;
    case "preSubmissionFailure":
      return {
        ...crank,
        status: "failed",
        completedAt,
        diagnostic: result.message,
      };
    case "invalid":
      return {
        ...crank,
        status: "invalid",
        transactionHash: result.hash,
        completedAt,
        diagnostic: result.reason,
      };
    case "committedFailure":
      return {
        ...crank,
        status: "failed",
        transactionHash: result.hash,
        completedAt,
        receiptBlock: result.receipt.blockHeight.toString(),
        diagnostic: "Crank transaction committed with a contract failure",
      };
    case "indeterminate":
      return {
        ...crank,
        status: "indeterminate",
        transactionHash: result.hash ?? crank.transactionHash,
        diagnostic: `Transaction outcome is ${result.reason}`,
      };
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Crank receipt is incompatible";
}
