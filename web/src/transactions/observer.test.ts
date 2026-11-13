import { addressFromHex, type ThruputClient } from "@thruputchain/client";
import { describe, expect, test, vi } from "vitest";
import {
  applyCompletionBatch,
  observeCompletions,
  type CompletionBatch,
} from "./observer";
import type { AcceptedRequest } from "./records";

const contract = `0x${"22".repeat(32)}`;
const requester = `0x${"33".repeat(32)}`;

describe("completion observer", () => {
  test("detects retention gaps without inventing an advanced outcome", async () => {
    const record = request();
    const client = {
      getEvents: vi.fn(async () => ({
        events: [],
        nextCursor: null,
        oldestIndexedBlockHeight: 9n,
        latestIndexedBlockHeight: 12n,
      })),
    } as unknown as Pick<ThruputClient, "getEvents">;
    const batch = await observeCompletions({
      client,
      contractAddress: contract,
      requester,
      requests: [record],
    });
    expect(applyCompletionBatch([record], batch)).toEqual([
      {
        localId: record.localId,
        status: "completionUnknown",
        transactionHash: record.transactionHash,
      },
    ]);
  });

  test("applies completion only to scanned accepted requests", () => {
    const record = request();
    const later = { ...request(), localId: "request-2" };
    const batch: CompletionBatch = {
      scanned: new Set([record.localId]),
      completed: new Set([record.localId]),
      retentionGaps: new Set(),
      observedThroughBlock: "12",
    };
    expect(applyCompletionBatch([record, later], batch)).toEqual([
      {
        localId: record.localId,
        status: "advanced",
        transactionHash: record.transactionHash,
      },
      later,
    ]);
  });

  test("ignores events from other contracts", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      events: [
        {
          event: { address: addressFromHex(`0x${"99".repeat(32)}`) },
          transactionHash: new Uint8Array(32),
          sequenceNumber: 0,
          blockHeight: 8n,
        },
      ],
      nextCursor: null,
      oldestIndexedBlockHeight: 0n,
      latestIndexedBlockHeight: 10n,
    });
    const batch = await observeCompletions({
      client: { getEvents } as unknown as Pick<ThruputClient, "getEvents">,
      contractAddress: contract,
      requester,
      requests: [request()],
    });
    expect(batch.completed.size).toBe(0);
    expect(batch.observedThroughBlock).toBe("10");
  });

  test("watermarks only through the first page's confirmed terminal block", async () => {
    const cursor = "0x01";
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: cursor,
        oldestIndexedBlockHeight: 0n,
        latestIndexedBlockHeight: 10n,
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: null,
        oldestIndexedBlockHeight: 0n,
        latestIndexedBlockHeight: 12n,
      });
    const batch = await observeCompletions({
      client: { getEvents } as unknown as Pick<ThruputClient, "getEvents">,
      contractAddress: contract,
      requester,
      requests: [request()],
    });
    expect(batch.observedThroughBlock).toBe("10");
  });

  test("rejects repeated pagination cursors", async () => {
    const page = {
      events: [],
      nextCursor: "0x01",
      oldestIndexedBlockHeight: 0n,
      latestIndexedBlockHeight: 10n,
    };
    const getEvents = vi.fn().mockResolvedValue(page);
    await expect(
      observeCompletions({
        client: { getEvents } as unknown as Pick<ThruputClient, "getEvents">,
        contractAddress: contract,
        requester,
        requests: [request()],
      }),
    ).rejects.toThrow(/repeated cursor/);
  });
});

function request(): AcceptedRequest {
  return {
    localId: "request-1",
    status: "accepted",
    transactionHash: `0x${"44".repeat(32)}`,
    requestId: `0x${"55".repeat(32)}`,
    epoch: "0",
    receiptBlock: "7",
    observedThroughBlock: null,
  };
}
