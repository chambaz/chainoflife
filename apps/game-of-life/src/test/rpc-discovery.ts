export function rpcDiscovery(method: string) {
  switch (method) {
    case "getVersionInfo":
      return {
        implementation: "chain-of-life-test",
        wireFormat: "14.1.1",
        supportedMethods: [
          "getVersionInfo",
          "getNetworkInfo",
          "getServerLimits",
          "getChainConfig",
          "getChainTip",
          "simulateInvocation",
          "getEvents",
          "getBalance",
          "faucet_requestAirdrop",
          "sendTransaction",
          "getTransactionReceipt",
          "getTransactionStatus",
        ],
      };
    case "getNetworkInfo":
      return { networkHash: toBase58(new Uint8Array(32).fill(0xaa)) };
    case "getServerLimits":
      return {
        maxCursorBytes: "4096",
        maxEventsPerPage: 200,
        maxTransactionsPerPage: 200,
        maxSimulationCalldataBytes: "1000000",
        maxSimulationGas: "1000000000",
      };
    case "getChainConfig":
      return { stated: {} };
    case "getChainTip":
      return {
        blockHeight: "9",
        blockHash: "11111111111111111111111111111111",
      };
    default:
      return undefined;
  }
}
import { toBase58 } from "@thruputchain/client";
