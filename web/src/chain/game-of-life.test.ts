import type { ThruputClient } from "@thruputchain/client";
import { describe, expect, test, vi } from "vitest";
import { createLifeReadAdapter } from "./game-of-life";

const contract = `0x${"22".repeat(32)}`;

describe("typed Life read adapter", () => {
  test("reads one bounded page of the newest generation events", async () => {
    const getEvents = vi.fn(async () => ({
      nextCursor: "0x01",
      events: [],
      latestIndexedBlockHeight: 10n,
      oldestIndexedBlockHeight: 0n,
    }));
    const adapter = createLifeReadAdapter({
      client: { getEvents } as unknown as Pick<
        ThruputClient,
        "simulateInvocation" | "getEvents"
      >,
      contractAddress: contract,
    });
    await expect(adapter.recentGenerations(50)).resolves.toEqual([]);
    expect(getEvents).toHaveBeenCalledOnce();
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        start: { order: "descending", anchor: { kind: "atEnd" } },
        limit: 50,
      }),
    );
  });
});
