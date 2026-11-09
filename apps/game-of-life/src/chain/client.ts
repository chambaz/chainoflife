import {
  createThruputClient,
  HttpTransport,
  hashFromHex,
  createRpcClient,
  addressFromBase58,
  type RpcClient,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";

export type AppClient = Awaited<ReturnType<typeof createAppClient>>;

export async function createAppClient(
  config: Pick<
    AppConfig,
    "rpcUrl" | "rpcProxyPath" | "networkId" | "localFaucetAddress"
  >,
) {
  const url =
    typeof window === "undefined"
      ? config.rpcUrl.href
      : new URL(config.rpcProxyPath, window.location.origin).href;
  const transport = new HttpTransport(url, { timeoutMs: 10_000 });
  const client = await createThruputClient({
    cluster: {
      capabilities: ["airdrop"],
      networkHash: networkHash(hashFromHex(`0x${config.networkId}`)),
    },
    transport,
  });
  const faucet = config.localFaucetAddress
    ? addressFromBase58(config.localFaucetAddress)
    : null;
  let rpc: Promise<RpcClient> | undefined;
  return Object.assign(client, {
    requestFunding: faucet
      ? async (
          request: Omit<Parameters<RpcClient["dev_fundAccount"]>[0], "faucet">,
        ) => {
          rpc ??= createRpcClient({ transport });
          return (await rpc).dev_fundAccount({ ...request, faucet });
        }
      : undefined,
  });
}
