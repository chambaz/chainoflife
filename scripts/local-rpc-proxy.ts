import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { RPC_PROXY_PATH } from "../web/src/config";

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

/** Dev-server proxy to a local node, which does not allow cross-origin requests. */
export function localRpcProxy(target: string): Plugin {
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
      server.middlewares.use(RPC_PROXY_PATH, middleware);
    },
  };
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
