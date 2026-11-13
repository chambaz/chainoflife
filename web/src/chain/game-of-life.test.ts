import type { ThruputClient } from "@thruputchain/client";
import { describe, expect, test, vi } from "vitest";
import { createLifeReadAdapter } from "./game-of-life";

const contract = `0x${"22".repeat(32)}`;

describe("typed Life event read adapter", () => {
  test("queries generated event filters from a bounded anchor", async () => {
    const getEvents = vi.fn(async () => page());
    const adapter = createLifeReadAdapter({
      client: { getEvents } as unknown as Pick<
        ThruputClient,
        "simulateInvocation" | "getEvents"
      >,
      contractAddress: contract,
    });
    await expect(adapter.events(9n)).resolves.toEqual([]);
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        start: {
          order: "ascending",
          anchor: { kind: "atHeight", blockHeight: 9n },
        },
        limit: 200,
      }),
    );
  });

  test("rejects repeated pagination cursors", async () => {
    const cursor = "0x01";
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(page(cursor))
      .mockResolvedValueOnce(page(cursor));
    const adapter = createLifeReadAdapter({
      client: { getEvents } as unknown as Pick<
        ThruputClient,
        "simulateInvocation" | "getEvents"
      >,
      contractAddress: contract,
    });
    await expect(adapter.events(0n)).rejects.toThrow(/repeated cursor/);
  });
});

function page(cursor: string | null = null) {
  return {
    nextCursor: cursor,
    events: [],
    latestIndexedBlockHeight: 10n,
    oldestIndexedBlockHeight: 0n,
  };
}
