import {
  bytesEqual,
  toHex0x,
  type CoreThruputClient,
  type EventFilter,
  type EventPage,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";

export type EventClient =
  Pick<CoreThruputClient, "getEvents"> | Promise<CoreThruputClient>;

export interface ContractEventPage {
  readonly page: EventPage;
  /** Events from the contract that no earlier page returned. */
  readonly events: EventPage["events"];
}

/** Walk event pages in ascending order from a block, following cursors. */
export async function* contractEventPages(
  client: EventClient,
  contract: ContractAddress,
  filters: readonly EventFilter[],
  fromBlock: bigint,
): AsyncGenerator<ContractEventPage> {
  if (fromBlock < 0n) throw new RangeError("event anchor must be nonnegative");
  const seenEvents = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await (
      await client
    ).getEvents({
      filters: [...filters],
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
    const events = page.events.filter((identified) => {
      const key = `${toHex0x(identified.transactionHash)}:${identified.sequenceNumber}`;
      if (
        !bytesEqual(identified.event.address, contract) ||
        seenEvents.has(key)
      )
        return false;
      seenEvents.add(key);
      return true;
    });
    yield { page, events };
    if (page.nextCursor === null) return;
    if (seenCursors.has(page.nextCursor))
      throw new Error("Event query returned a repeated cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
