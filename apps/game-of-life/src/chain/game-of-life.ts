import type {
  ContractView,
  EventPage,
  CoreThruputClient,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
  WorldInitialized,
  decodeEvent,
  type GameOfLifeEvent,
} from "@/contracts/game-of-life";

export interface ChainMetadata {
  readonly epoch: string;
  readonly width: number;
  readonly height: number;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
  readonly chunkBytes: 1_000;
  readonly chunksPerRow: number;
  readonly maxQueueLength: number;
}

export type LifeChainEvent =
  | {
      readonly kind: "WorldInitialized";
      readonly epoch: string;
      readonly size: number;
      readonly blockHeight: string;
      readonly transactionHash: string;
      readonly sequenceNumber: number;
      readonly seed: string;
      readonly maxQueueLength: number;
      readonly population: string;
      readonly stateDigest: string;
    }
  | {
      readonly kind: "TickRequested";
      readonly epoch: string;
      readonly blockHeight: string;
      readonly transactionHash: string;
      readonly sequenceNumber: number;
      readonly requestId: string;
      readonly requester: string;
    }
  | {
      readonly kind: "GenerationAdvanced";
      readonly epoch: string;
      readonly blockHeight: string;
      readonly transactionHash: string;
      readonly sequenceNumber: number;
      readonly requestId: string;
      readonly requester: string;
      readonly generation: string;
      readonly population: string;
      readonly stateDigest: string;
    };

export interface LifeReadAdapter {
  metadata(): Promise<ContractView<ChainMetadata>>;
  events(fromBlock: bigint): Promise<readonly LifeChainEvent[]>;
  decodeEvent(event: {
    topics: Uint8Array[];
    data: Uint8Array;
  }): GameOfLifeEvent | null;
}

export function createLifeReadAdapter(params: {
  readonly client:
    | Pick<CoreThruputClient, "simulateInvocation" | "getEvents">
    | Promise<CoreThruputClient>;
  readonly contractAddress: string;
}): LifeReadAdapter {
  const contract = contractAddressFromHex(params.contractAddress);
  return {
    async metadata() {
      const result = await GameOfLife.v0_1.getMetadata.view({
        client: await params.client,
        address: contract,
      });
      const value = result.value;
      if (
        value.width < 100n ||
        value.width > 10_000n ||
        value.width % 100n !== 0n ||
        value.height !== value.width ||
        value.chunk_bytes !== 1_000n ||
        value.chunks_per_row !== ((value.width + 7n) / 8n + 999n) / 1_000n ||
        value.population > value.width * value.height ||
        value.max_queue_len <= 0n ||
        value.max_queue_len > 0xffff_ffffn
      ) {
        throw new Error("Contract returned an unsupported world schema");
      }
      return {
        ...result,
        value: {
          epoch: value.epoch.toString(),
          width: Number(value.width),
          height: Number(value.height),
          generation: value.generation.toString(),
          seed: value.seed.toString(),
          population: value.population.toString(),
          stateDigest: hex(value.state_digest),
          chunkBytes: 1_000,
          chunksPerRow: Number(value.chunks_per_row),
          maxQueueLength: Number(value.max_queue_len),
        },
      };
    },
    async events(fromBlock) {
      if (fromBlock < 0n)
        throw new RangeError("event anchor must be nonnegative");
      const output: LifeChainEvent[] = [];
      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page: EventPage = await (
          await params.client
        ).getEvents({
          filters: [
            WorldInitialized.filter({ addresses: [contract] }),
            TickRequested.filter({ addresses: [contract] }),
            GenerationAdvanced.filter({ addresses: [contract] }),
          ],
          limit: 200,
          ...(cursor
            ? { cursor }
            : {
                start: {
                  order: "ascending",
                  anchor: { kind: "atHeight", blockHeight: fromBlock },
                },
              }),
        });
        for (const identified of page.events) {
          if (
            !sameAddress(identified.event.address as ContractAddress, contract)
          )
            continue;
          const key = `${hex(identified.transactionHash)}:${identified.sequenceNumber}`;
          if (seenEvents.has(key)) continue;
          seenEvents.add(key);
          const event = decodeEvent(identified.event);
          if (!event) continue;
          const common = {
            epoch: event.fields.epoch.toString(),
            blockHeight: identified.blockHeight.toString(),
            transactionHash: hex(identified.transactionHash),
            sequenceNumber: identified.sequenceNumber,
          };
          if (event.name === "WorldInitialized") {
            if (
              event.fields.max_queue_len <= 0n ||
              event.fields.max_queue_len > 0xffff_ffffn ||
              event.fields.population > 100_000_000n
            )
              throw new Error("Invalid WorldInitialized event");
            output.push({
              kind: "WorldInitialized",
              size: Number(event.fields.size),
              ...common,
              seed: event.fields.seed.toString(),
              maxQueueLength: Number(event.fields.max_queue_len),
              population: event.fields.population.toString(),
              stateDigest: hex(event.fields.state_digest),
            });
          } else if (event.name === "TickRequested") {
            output.push({
              kind: "TickRequested",
              ...common,
              requestId: hex(event.topics.request_id),
              requester: hex(event.topics.requested_by),
            });
          } else {
            if (
              event.fields.generation === 0n ||
              event.fields.population > 100_000_000n
            )
              throw new Error("Invalid GenerationAdvanced event");
            output.push({
              kind: "GenerationAdvanced",
              ...common,
              requestId: hex(event.topics.request_id),
              requester: hex(event.fields.requested_by),
              generation: event.fields.generation.toString(),
              population: event.fields.population.toString(),
              stateDigest: hex(event.fields.state_digest),
            });
          }
        }
        if (page.nextCursor === null) break;
        const cursorKey = page.nextCursor;
        if (seenCursors.has(cursorKey))
          throw new Error("Event query returned a repeated cursor");
        seenCursors.add(cursorKey);
        cursor = page.nextCursor;
      }
      return output;
    },
    decodeEvent,
  };
}

export function sameAddress(
  left: ContractAddress,
  right: ContractAddress,
): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function hex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function contractAddressFromHex(value: string): ContractAddress {
  if (!/^0x[0-9a-f]{64}$/.test(value))
    throw new Error("Contract address must be canonical lowercase hex32");
  return Uint8Array.from(
    value
      .slice(2)
      .match(/../g)!
      .map((byte) => Number.parseInt(byte, 16)),
  ) as ContractAddress;
}
