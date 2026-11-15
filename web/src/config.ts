import { normalizeNetworkId } from "./config-values";
import { isHex32 } from "./lib/validation";

export interface AppConfig {
  readonly rpcUrl: URL;
  readonly localFaucetAddress?: string | undefined;
  /** True when the dev server proxies a local node that does not allow CORS. */
  readonly rpcProxied: boolean;
  readonly networkId: string;
  readonly contractAddress: string;
  readonly indexerUrl: URL;
  readonly transactionPolicy: TransactionPolicy;
}

/** Gas budget for one world write: an advance or a resize. */
export interface TransactionPolicy {
  readonly transactionGasLimit: bigint;
  readonly targetGasLimit: bigint;
}

export type Environment = Readonly<
  Record<string, string | boolean | undefined>
>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadAppConfig(environment: Environment): Readonly<AppConfig> {
  const networkInput = required(environment, "VITE_THRUPUT_NETWORK_ID");
  let networkId: string;
  try {
    networkId = normalizeNetworkId(networkInput);
  } catch (cause) {
    throw new ConfigurationError(
      cause instanceof Error ? cause.message : "Invalid network ID",
    );
  }
  const contractAddress = required(
    environment,
    "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS",
  );
  if (!isHex32(contractAddress)) {
    throw new ConfigurationError(
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS must be canonical lowercase 0x-prefixed hexadecimal",
    );
  }

  const rpcUrl = httpUrl(
    required(environment, "VITE_THRUPUT_RPC_URL"),
    "VITE_THRUPUT_RPC_URL",
  );
  return Object.freeze({
    rpcUrl,
    rpcProxied: isLoopback(rpcUrl),
    localFaucetAddress:
      typeof environment.VITE_THRUPUT_LOCAL_FAUCET_ADDRESS === "string"
        ? environment.VITE_THRUPUT_LOCAL_FAUCET_ADDRESS || undefined
        : undefined,
    networkId,
    contractAddress,
    indexerUrl: rootHttpUrl(
      required(environment, "VITE_GAME_OF_LIFE_INDEXER_URL"),
      "VITE_GAME_OF_LIFE_INDEXER_URL",
    ),
    transactionPolicy: transactionPolicy(environment),
  });
}

const GAS_LIMIT = "VITE_GAME_OF_LIFE_GAS_LIMIT";
const TARGET_GAS_LIMIT = "VITE_GAME_OF_LIFE_TARGET_GAS_LIMIT";

function transactionPolicy(environment: Environment): TransactionPolicy {
  const transactionGasLimit = decimalBigInt(environment, GAS_LIMIT);
  const targetGasLimit = decimalBigInt(environment, TARGET_GAS_LIMIT);
  if (targetGasLimit > transactionGasLimit)
    throw new ConfigurationError(
      `${TARGET_GAS_LIMIT} must not exceed ${GAS_LIMIT}`,
    );
  return Object.freeze({ transactionGasLimit, targetGasLimit });
}

function decimalBigInt(environment: Environment, key: string): bigint {
  const value = required(environment, key);
  if (!/^[1-9][0-9]*$/.test(value))
    throw new ConfigurationError(`${key} must be a positive decimal integer`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn)
    throw new ConfigurationError(`${key} exceeds the supported u64 range`);
  return parsed;
}

function rootHttpUrl(value: string, key: string): URL {
  const url = httpUrl(value, key);
  if (url.pathname !== "/" || url.search || url.hash)
    throw new ConfigurationError(
      `${key} must use the origin root without a path, query, or hash`,
    );
  return url;
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${key} is required`);
  }
  return value;
}

function httpUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${key} must be a valid URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConfigurationError(
      `${key} must be an HTTP(S) URL without credentials`,
    );
  }
  return url;
}

export const RPC_PROXY_PATH = "/thruput-rpc";

export function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
