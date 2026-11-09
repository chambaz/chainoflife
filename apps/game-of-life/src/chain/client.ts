import {
  createThruputClient,
  HttpTransport,
  hashFromHex,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";

export function createReadClient(
  config: Pick<AppConfig, "rpcUrl" | "rpcProxyPath" | "networkId">,
) {
  const url =
    typeof window === "undefined"
      ? config.rpcUrl.href
      : new URL(config.rpcProxyPath, window.location.origin).href;
  return createThruputClient({
    cluster: {
      capabilities: [],
      networkHash: networkHash(hashFromHex(`0x${config.networkId}`)),
    },
    transport: new HttpTransport(url, { timeoutMs: 10_000 }),
  });
}
