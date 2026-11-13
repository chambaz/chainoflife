import { addressFromHex, toHex0x } from "@thruputchain/client";
import { contractEventPages, type EventClient } from "@/chain/events";
import { GenerationAdvanced } from "@/contracts/game-of-life";
import type {
  AcceptedRequest,
  TickRequestRecord,
} from "@/transactions/records";

export interface CompletionBatch {
  /** Local IDs of the accepted requests that this scan covered. */
  readonly scanned: ReadonlySet<string>;
  /** Scanned requests whose GenerationAdvanced event was found. */
  readonly completed: ReadonlySet<string>;
  /** Scanned requests whose event history is no longer retained. */
  readonly retentionGaps: ReadonlySet<string>;
  readonly observedThroughBlock: string | null;
}

/** Find GenerationAdvanced events for this wallet's accepted requests. */
export async function observeCompletions(params: {
  readonly client: EventClient;
  readonly contractAddress: string;
  readonly requester: string;
  readonly requests: readonly TickRequestRecord[];
}): Promise<CompletionBatch> {
  const requests = params.requests.filter(
    (request): request is AcceptedRequest => request.status === "accepted",
  );
  const scanned = new Set(requests.map(({ localId }) => localId));
  const completed = new Set<string>();
  if (requests.length === 0)
    return {
      scanned,
      completed,
      retentionGaps: new Set(),
      observedThroughBlock: null,
    };
  const contract = addressFromHex(params.contractAddress);
  const byRequest = new Map(
    requests.map((request) => [
      `${request.epoch}:${request.requestId}`,
      request,
    ]),
  );
  const requiredFrom = (request: AcceptedRequest): bigint =>
    request.observedThroughBlock === null
      ? BigInt(request.receiptBlock)
      : BigInt(request.observedThroughBlock) + 1n;
  const anchor = requests
    .map(requiredFrom)
    .reduce((minimum, value) => (value < minimum ? value : minimum));
  let scanThrough: bigint | null = null;
  let oldest = 0n;
  for await (const { page, events } of contractEventPages(
    params.client,
    contract,
    [GenerationAdvanced.filter({ addresses: [contract] })],
    anchor,
  )) {
    if (scanThrough === null) scanThrough = page.latestIndexedBlockHeight;
    else if (page.latestIndexedBlockHeight < scanThrough)
      throw new Error("Event pagination terminal block regressed");
    if (page.oldestIndexedBlockHeight > oldest)
      oldest = page.oldestIndexedBlockHeight;
    for (const identified of events) {
      const event = GenerationAdvanced.decode(identified.event);
      if (
        !event ||
        event.fields.generation === 0n ||
        toHex0x(event.fields.requested_by) !== params.requester
      )
        continue;
      const request = byRequest.get(
        `${event.fields.epoch}:${toHex0x(event.topics.request_id)}`,
      );
      if (request && identified.blockHeight >= BigInt(request.receiptBlock))
        completed.add(request.localId);
    }
  }
  return {
    scanned,
    completed,
    retentionGaps: new Set(
      requests
        .filter(
          (request) =>
            !completed.has(request.localId) && oldest > requiredFrom(request),
        )
        .map(({ localId }) => localId),
    ),
    observedThroughBlock: scanThrough?.toString() ?? null,
  };
}

export function applyCompletionBatch(
  records: readonly TickRequestRecord[],
  batch: CompletionBatch,
): TickRequestRecord[] {
  return records.map((record) => {
    if (record.status !== "accepted" || !batch.scanned.has(record.localId))
      return record;
    const { localId, transactionHash } = record;
    if (batch.completed.has(localId))
      return { localId, status: "advanced", transactionHash };
    if (batch.retentionGaps.has(localId))
      return { localId, status: "completionUnknown", transactionHash };
    return batch.observedThroughBlock === null
      ? record
      : { ...record, observedThroughBlock: batch.observedThroughBlock };
  });
}
