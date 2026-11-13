import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { normalizeNetworkId } from "../web/src/config-values";

const RPC_METHODS = new Set([
  "getVersionInfo",
  "getNetworkInfo",
  "getChainConfig",
  "getServerLimits",
  "getChainTip",
  "getEvents",
  "simulateInvocation",
  "getBalance",
  "sendTransaction",
  "getTransactionReceipt",
  "getTransactionStatus",
  "getTransactionsByRootAddress",
  "faucet_requestAirdrop",
  "dev_fundAccount",
]);
const MAX_BODY = 1_000_000;
const MAX_INDEXER_JSON = 1_000_000;
const MAX_INDEXER_TILE = 131_072;

export function validateRpcTarget(input: string): void {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "The RPC proxy requires a credential-free HTTP(S) target without a hash",
    );
  }
}

export function validateIndexerTarget(input: string): void {
  try {
    validateRpcTarget(input);
    const url = new URL(input);
    if (
      !isLoopback(url.hostname) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      "The indexer proxy requires a credential-free loopback HTTP(S) origin root without a path, query, or hash",
    );
  }
}

export function indexerProxyScope(
  environment: Record<string, string | undefined>,
): {
  readonly networkId: string;
  readonly contractAddress: string;
} {
  const networkId = normalizeNetworkId(
    environment.VITE_THRUPUT_NETWORK_ID ?? "",
  );
  const contractAddress = environment.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS ?? "";
  if (!/^0x[0-9a-f]{64}$/.test(contractAddress))
    throw new Error(
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS must be canonical lowercase hex32",
    );
  return { networkId, contractAddress };
}

export function isAllowedRpcRequest(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return false;
  const value = input as Record<string, unknown>;
  return (
    value.jsonrpc === "2.0" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.method === "string" &&
    RPC_METHODS.has(value.method) &&
    Object.keys(value).every((key) =>
      ["jsonrpc", "id", "method", "params"].includes(key),
    )
  );
}

export function isSameOriginLoopback(
  headers: IncomingMessage["headers"],
): boolean {
  if (!headers.host || headers["sec-fetch-site"] === "cross-site") return false;
  try {
    const source = headers.origin ?? headers.referer;
    if (!source) return false;
    const origin = new URL(source);
    return (
      isLoopback(origin.hostname) &&
      ["http:", "https:"].includes(origin.protocol) &&
      origin.host === headers.host
    );
  } catch {
    return false;
  }
}

export interface IndexerRoute {
  readonly contentType: string;
  readonly maxBytes: number;
}

export function allowedIndexerRoute(
  requestUrl: string,
  networkId: string,
  contractAddress: string,
): IndexerRoute | null {
  if (
    !/^[0-9a-f]{64}$/.test(networkId) ||
    !/^0x[0-9a-f]{64}$/.test(contractAddress) ||
    requestUrl.includes("?") ||
    requestUrl.includes("#") ||
    requestUrl.includes("%")
  )
    return null;
  const base = `/v1/worlds/${networkId}/${contractAddress}`;
  if (requestUrl === `${base}/latest.json`)
    return { contentType: "application/json", maxBytes: MAX_INDEXER_JSON };
  if (
    new RegExp(`^${base}/0x[0-9a-f]{64}/(?:manifest|provenance)\\.json$`).test(
      requestUrl,
    )
  )
    return { contentType: "application/json", maxBytes: MAX_INDEXER_JSON };
  const tile = requestUrl.match(
    new RegExp(`^${base}/0x[0-9a-f]{64}/tiles/([0-6])/(\\d+)/(\\d+)\\.bin$`),
  );
  if (!tile) return null;
  const z = Number(tile[1]);
  const tilesPerSide = Math.ceil(10_000 / (256 * 2 ** (6 - z)));
  if (Number(tile[2]) >= tilesPerSide || Number(tile[3]) >= tilesPerSide)
    return null;
  return {
    contentType:
      z === 6
        ? "application/vnd.chain-of-life.cells-v1"
        : "application/vnd.chain-of-life.density-u16le",
    maxBytes: MAX_INDEXER_TILE,
  };
}

export function rpcProxy(target: string): Plugin {
  const targetUrl = new URL(target);
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method !== "POST")
      return error(response, 405, "POST is required");
    if (!isSameOriginLoopback(request.headers))
      return error(response, 403, "Same-origin loopback request required");
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.toLowerCase() !==
      "application/json"
    )
      return error(response, 415, "application/json is required");
    try {
      const body = await readBody(request);
      const envelope: unknown = JSON.parse(body);
      if (!isAllowedRpcRequest(envelope))
        return error(
          response,
          403,
          "RPC method is not available through this local proxy",
        );
      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (
        mediaType(upstream.headers.get("content-type")) !== "application/json"
      )
        return error(
          response,
          502,
          "RPC upstream returned an unsafe content type",
        );
      const bytes = await readBoundedResponse(upstream, MAX_BODY);
      response.statusCode = upstream.status;
      response.setHeader("content-type", "application/json");
      response.setHeader("content-length", bytes.length);
      response.end(bytes);
    } catch (cause) {
      return error(
        response,
        502,
        cause instanceof Error ? cause.message : "RPC proxy failed",
      );
    }
  };
  return {
    name: "thruput-local-rpc",
    configureServer(server) {
      server.middlewares.use("/thruput-rpc", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/thruput-rpc", middleware);
    },
  };
}

export function readOnlyIndexerProxy(
  target: string,
  networkId: string,
  contractAddress: string,
): Plugin {
  const targetUrl = new URL(target);
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method !== "GET")
      return error(response, 405, "GET is required");
    if (!isSameOriginLoopback(request.headers))
      return error(response, 403, "Same-origin loopback request required");
    const route = allowedIndexerRoute(
      request.url ?? "",
      networkId,
      contractAddress,
    );
    if (!route)
      return error(
        response,
        404,
        "Indexer path is not available through this proxy",
      );
    try {
      const upstream = await fetch(new URL(request.url!, targetUrl.origin), {
        method: "GET",
        headers: { accept: route.contentType },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (isIndexerArtifactNotFound(upstream.status)) {
        await upstream.body?.cancel().catch(() => undefined);
        return error(response, 404, "Indexer artifact not found");
      }
      if (mediaType(upstream.headers.get("content-type")) !== route.contentType)
        return error(
          response,
          502,
          "Indexer upstream returned an unsafe content type",
        );
      const bytes = await readBoundedResponse(upstream, route.maxBytes);
      response.statusCode = upstream.status;
      response.setHeader("content-type", route.contentType);
      response.setHeader("content-length", bytes.length);
      response.setHeader("x-content-type-options", "nosniff");
      copySafeArtifactHeader(
        upstream,
        response,
        "etag",
        /^W\/"[^"\r\n]*"$|^"[^"\r\n]*"$/,
      );
      copySafeArtifactHeader(
        upstream,
        response,
        "cache-control",
        /^[a-zA-Z0-9_\s=,";*-]+$/,
      );
      response.end(bytes);
    } catch (cause) {
      return error(
        response,
        502,
        cause instanceof Error ? cause.message : "Indexer proxy failed",
      );
    }
  };
  return {
    name: "thruput-read-only-indexer",
    configureServer(server) {
      server.middlewares.use("/thruput-indexer", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/thruput-indexer", middleware);
    },
  };
}

export function isIndexerArtifactNotFound(status: number): boolean {
  return status === 404;
}

async function readBoundedResponse(
  upstream: Response,
  maximum: number,
): Promise<Buffer> {
  if (!upstream.body) return Buffer.alloc(0);
  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error("Upstream response is too large");
      chunks.push(Buffer.from(value));
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  }
  return Buffer.concat(chunks, length);
}

function mediaType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function copySafeArtifactHeader(
  upstream: Response,
  response: ServerResponse,
  name: string,
  pattern: RegExp,
): void {
  const value = upstream.headers.get(name);
  if (value && pattern.test(value)) response.setHeader(name, value);
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY) throw new Error("RPC request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function error(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: message }));
}
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
