import {
  addressFromHex,
  bytesEqual,
  toHex0x,
  type EventPage,
  type CoreThruputClient,
} from "@thruputchain/client";
import { GenerationAdvanced } from "@/contracts/game-of-life";
import type { TickRequestRecord } from "@/transactions/records";

export interface CompletionObservation {
  readonly epoch?: string;
  readonly requestId: string;
  readonly requester: string;
  readonly transactionHash: string;
  readonly blockHeight: string;
  readonly generation: string;
  readonly population: string;
  readonly stateDigest: string;
}

export interface CompletionBatch {
  readonly observations: readonly CompletionObservation[];
  readonly observedThroughBlock: string | null;
  readonly retentionGapRequestIds: ReadonlySet<string>;
}

export async function observeCompletions(params: {
  readonly client:
    Pick<CoreThruputClient, "getEvents"> | Promise<CoreThruputClient>;
  readonly contractAddress: string;
  readonly requests: readonly TickRequestRecord[];
}): Promise<CompletionBatch> {
  const requests = params.requests.filter(
    (request) => request.status === "accepted" && request.requestId !== null,
  );
  if (requests.length === 0)
    return {
      observations: [],
      observedThroughBlock: null,
      retentionGapRequestIds: new Set(),
    };
  const contract = addressFromHex(params.contractAddress);
  const byId = new Map(
    requests.map((request) => [request.requestId!, request]),
  );
  const requiredFrom = (request: TickRequestRecord): bigint =>
    request.observedThroughBlock === null
      ? BigInt(request.receiptBlock!)
      : BigInt(request.observedThroughBlock) + 1n;
  const anchor = requests.reduce((minimum, request) => {
    const value = requiredFrom(request);
    return value < minimum ? value : minimum;
  }, requiredFrom(requests[0]!));
  const observations: CompletionObservation[] = [];
  const completed = new Set<string>();
  const seenEvents = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scanThrough: bigint | null = null;
  let oldest: bigint | null = null;
  for (;;) {
    const page: EventPage = await (
      await params.client
    ).getEvents({
      filters: [GenerationAdvanced.filter({ addresses: [contract] })],
      limit: 200,
      ...(cursor
        ? { cursor }
        : {
            start: {
              order: "ascending",
              anchor: { kind: "atHeight", blockHeight: anchor },
            },
          }),
    });
    if (scanThrough === null) scanThrough = page.latestIndexedBlockHeight;
    else if (page.latestIndexedBlockHeight < scanThrough)
      throw new Error("Event pagination terminal block regressed");
    oldest =
      oldest === null || page.oldestIndexedBlockHeight > oldest
        ? page.oldestIndexedBlockHeight
        : oldest;
    for (const identified of page.events) {
      if (!bytesEqual(identified.event.address, contract)) continue;
      const key = `${toHex0x(identified.transactionHash)}:${identified.sequenceNumber}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      const event = GenerationAdvanced.decode(identified.event);
      if (!event) continue;
      const requestId = toHex0x(event.topics.request_id);
      const request = byId.get(requestId);
      if (
        !request ||
        (request.epoch !== undefined &&
          request.epoch !== event.fields.epoch.toString()) ||
        completed.has(requestId) ||
        request.requester !== toHex0x(event.fields.requested_by) ||
        identified.blockHeight < BigInt(request.receiptBlock!) ||
        event.fields.generation === 0n ||
        event.fields.population > 100_000_000n
      )
        continue;
      completed.add(requestId);
      observations.push({
        epoch: event.fields.epoch.toString(),
        requestId,
        requester: request.requester,
        transactionHash: toHex0x(identified.transactionHash),
        blockHeight: identified.blockHeight.toString(),
        generation: event.fields.generation.toString(),
        population: event.fields.population.toString(),
        stateDigest: toHex0x(event.fields.state_digest),
      });
    }
    if (page.nextCursor === null) break;
    const key = page.nextCursor;
    if (seenCursors.has(key))
      throw new Error("Event query returned a repeated pagination cursor");
    seenCursors.add(key);
    cursor = page.nextCursor;
  }
  const retentionGapRequestIds = new Set(
    oldest === null
      ? []
      : requests
          .filter(
            (request) =>
              !completed.has(request.requestId!) &&
              oldest! > requiredFrom(request),
          )
          .map((request) => request.requestId!),
  );
  return {
    observations,
    observedThroughBlock: scanThrough?.toString() ?? null,
    retentionGapRequestIds,
  };
}

export function applyCompletionBatch(
  records: readonly TickRequestRecord[],
  scanned: readonly TickRequestRecord[],
  batch: CompletionBatch,
): TickRequestRecord[] {
  const scannedIds = new Set(scanned.map(({ localId }) => localId));
  const observations = new Map(
    batch.observations.map((observation) => [
      observation.requestId,
      observation,
    ]),
  );
  return records.map((record) => {
    if (!scannedIds.has(record.localId) || record.status !== "accepted")
      return record;
    if (record.requestId && batch.retentionGapRequestIds.has(record.requestId))
      return {
        ...record,
        status: "completionUnknown",
        diagnostic:
          "Completion permanently unknown because event history is unavailable",
      };
    const observation = record.requestId
      ? observations.get(record.requestId)
      : undefined;
    if (
      observation &&
      (record.epoch === undefined || record.epoch === observation.epoch)
    )
      return {
        ...record,
        status: "advanced",
        observedThroughBlock: batch.observedThroughBlock,
        resultingGeneration: observation.generation,
        resultingPopulation: observation.population,
        resultingStateDigest: observation.stateDigest,
        advancedTransactionHash: observation.transactionHash,
      };
    if (batch.observedThroughBlock === null) return record;
    return { ...record, observedThroughBlock: batch.observedThroughBlock };
  });
}
