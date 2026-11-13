import {
  addressFromHex,
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
import { contractEventPages } from "./events";

export interface ChainMetadata {
  readonly epoch: string;
  readonly width: number;
  readonly height: number;
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
  readonly blockHeight: string;
  readonly transactionHash: string;
  readonly sequenceNumber: number;
}

export interface LifeReadAdapter {
  metadata(): Promise<ContractView<ChainMetadata>>;
  /** Generation events in ascending chain order. */
  generations(fromBlock: bigint): Promise<readonly GenerationEvent[]>;
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
        value.width < 100n ||
        value.width > BigInt(WORLD_SIZE) ||
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
          stateDigest: toHex0x(value.state_digest),
          resizable: value.resizable,
        },
      };
    },
    async generations(fromBlock) {
      const output: GenerationEvent[] = [];
      for await (const { events } of contractEventPages(
        params.client,
        contract,
        [
          WorldInitialized.filter({ addresses: [contract] }),
          GenerationAdvanced.filter({ addresses: [contract] }),
        ],
        fromBlock,
      )) {
        for (const identified of events) {
          const event = decodeEvent(identified.event);
          if (!event || event.name === "TickRequested") continue;
          const generation =
            event.name === "WorldInitialized" ? 0n : event.fields.generation;
          if (event.name === "GenerationAdvanced" && generation === 0n)
            throw new Error("Invalid GenerationAdvanced event");
          output.push({
            epoch: event.fields.epoch.toString(),
            generation: generation.toString(),
            blockHeight: identified.blockHeight.toString(),
            transactionHash: toHex0x(identified.transactionHash),
            sequenceNumber: identified.sequenceNumber,
          });
        }
      }
      return output;
    },
  };
}
