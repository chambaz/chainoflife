import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcDecodingError } from "@thruputchain/client/transport";
import { rpcDiscovery } from "../test/rpc-discovery";
import { createReadOnlyClient } from "./read-only-client";

const config = {
  rpcUrl: new URL("http://127.0.0.1:9547"),
  rpcProxyPath: "/thruput-rpc" as const,
  networkId: "aa".repeat(32),
};
const invocation = {
  address: new Uint8Array(32),
  entrypoint: new Uint8Array(8),
  calldata: new Uint8Array([3, 4]),
};
afterEach(() => vi.unstubAllGlobals());

describe("read-only Thruput client", () => {
  test("uses native named parameters and exposes only reads", async () => {
    const requests = stubRpc({
      output: { result: "return", returnData: "0x0102" },
      events: [],
      gasUsed: "100",
      stateBlockHeight: "9",
    });
    const client = createReadOnlyClient(config);
    const result = await client.simulateInvocation(invocation);
    expect(result.stateBlockHeight).toBe(9n);
    expect(result.output).toEqual({
      result: "return",
      returnData: new Uint8Array([1, 2]),
    });
    expect(requests.at(-1)).toMatchObject({
      method: "simulateInvocation",
      params: {
        address: "11111111111111111111111111111111",
        entrypoint: "0x0000000000000000",
        calldata: "0x0304",
      },
    });
    expect(Object.keys(client).sort()).toEqual([
      "getEvents",
      "simulateInvocation",
    ]);
  });

  test("decodes native event pagination", async () => {
    stubRpc({
      events: [],
      nextCursor: "0xaabb",
      latestIndexedBlockHeight: "15",
      oldestIndexedBlockHeight: "2",
    });
    const page = await createReadOnlyClient(config).getEvents({
      filters: [{ addresses: [new Uint8Array(32)] }],
      start: {
        order: "ascending",
        anchor: { kind: "atHeight", blockHeight: 10n },
      },
      limit: 20,
    });
    expect(page.nextCursor).toBe("0xaabb");
    expect(page.latestIndexedBlockHeight).toBe(15n);
  });

  test.each([
    {
      output: { result: "return", returnData: "0x" },
      events: "invalid",
      gasUsed: "1",
      stateBlockHeight: "9",
    },
    {
      output: { result: "return", returnData: "0x" },
      events: [],
      gasUsed: "1",
      stateBlockHeight: "9.5",
    },
  ])("rejects malformed known simulation data %#", async (result) => {
    stubRpc(result);
    await expect(
      createReadOnlyClient(config).simulateInvocation(invocation),
    ).rejects.toBeInstanceOf(RpcDecodingError);
  });
});

function stubRpc(result: unknown) {
  const requests: { method: string; params: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: rpcDiscovery(request.method) ?? result,
      });
    }),
  );
  return requests;
}
