import {
  addressFromHex,
  bytesEqual,
  toHex0x,
  type ContractView,
  type CoreThruputClient,
} from "@thruputchain/client";
import {
  GameOfLife,
  GenerationAdvanced,
  WorldInitialized,
  decodeEvent,
} from "@/contracts/game-of-life";
import { WORLD_SIZE } from "@/indexer/schema";
import { isHex32 } from "@/lib/validation";

export interface ChainMetadata {
  readonly epoch: string;
  readonly size: number;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
  readonly resizable: boolean;
}

/** A transaction that produced a generation: a reset (0) or an advance. */
export interface GenerationEvent {
  readonly epoch: string;
  readonly generation: string;
  /** The wallet that advanced the world; null for a reset. */
  readonly advancedBy: string | null;
  readonly transactionHash: string;
}

export interface LifeReadAdapter {
  metadata(): Promise<ContractView<ChainMetadata>>;
  /** The newest generation events, newest first. */
  recentGenerations(limit: number): Promise<readonly GenerationEvent[]>;
}

export function createLifeReadAdapter(params: {
  readonly client:
    | Pick<CoreThruputClient, "simulateInvocation" | "getEvents">
    | Promise<CoreThruputClient>;
  readonly contractAddress: string;
}): LifeReadAdapter {
  if (!isHex32(params.contractAddress))
    throw new Error("Contract address must be canonical lowercase hex32");
  const contract = addressFromHex(params.contractAddress);
  return {
    async metadata() {
      const result = await GameOfLife.v0_1.getMetadata.view({
        client: await params.client,
        address: contract,
      });
      const value = result.value;
      if (
        value.size < 100n ||
        value.size > BigInt(WORLD_SIZE) ||
        value.size % 100n !== 0n ||
        value.population > value.size * value.size
      )
        throw new Error("Contract returned an unsupported world");
      return {
        ...result,
        value: {
          epoch: value.epoch.toString(),
          size: Number(value.size),
          generation: value.generation.toString(),
          seed: value.seed.toString(),
          population: value.population.toString(),
          stateDigest: toHex0x(value.state_digest),
          resizable: value.resizable,
        },
      };
    },
    async recentGenerations(limit) {
      const page = await (
        await params.client
      ).getEvents({
        filters: [
          WorldInitialized.filter({ addresses: [contract] }),
          GenerationAdvanced.filter({ addresses: [contract] }),
        ],
        limit,
        start: { order: "descending", anchor: { kind: "atEnd" } },
      });
      return page.events.flatMap((identified) => {
        if (!bytesEqual(identified.event.address, contract)) return [];
        const event = decodeEvent(identified.event);
        if (!event) return [];
        const advance = event.name === "GenerationAdvanced";
        return {
          epoch: event.fields.epoch.toString(),
          generation: advance ? event.fields.generation.toString() : "0",
          advancedBy: advance ? toHex0x(event.topics.advanced_by) : null,
          transactionHash: toHex0x(identified.transactionHash),
        };
      });
    },
  };
}
