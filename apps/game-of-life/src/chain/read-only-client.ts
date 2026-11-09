import {
  createRpcClient,
  HttpTransport,
  type RpcClient,
} from "@thruputchain/client/transport";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { ReadAppConfig } from "@/config";

export type ReadOnlyClient = Pick<
  RpcClient,
  "simulateInvocation" | "getEvents"
>;

export function createReadOnlyClient(
  config: Pick<ReadAppConfig, "rpcUrl" | "rpcProxyPath" | "networkId">,
): ReadOnlyClient {
  const url =
    typeof window === "undefined"
      ? config.rpcUrl.href
      : new URL(config.rpcProxyPath, window.location.origin).href;
  const client = createRpcClient({
    transport: new HttpTransport(url, { timeoutMs: 10_000 }),
    expectedNetworkHash: hexToBytes(config.networkId),
  });
  return {
    simulateInvocation: async (...args) =>
      (await client).simulateInvocation(...args),
    getEvents: async (...args) => (await client).getEvents(...args),
  };
}
