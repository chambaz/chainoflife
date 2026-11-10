import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { buildNamedCodecs, resolveCodec } from "@thruputchain/client/contract";
import { serializeCxs } from "@thruputchain/xdr";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { normalizeNetworkId } from "./src/config-values";
import { spec as lifeSpec } from "./src/contracts/generated/game-of-life";
import { rpcDiscovery } from "./src/test/rpc-discovery";

const root = path.dirname(fileURLToPath(import.meta.url));
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
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self'; frame-ancestors 'none'",
};

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, root, "");
  const target = environment.VITE_THRUPUT_RPC_URL ?? "http://127.0.0.1:9545";
  const indexerTarget =
    environment.VITE_GAME_OF_LIFE_INDEXER_URL ?? "http://127.0.0.1:8787";
  const { networkId, contractAddress } = indexerProxyScope(
    mode === "test" || command === "build"
      ? {
          VITE_THRUPUT_NETWORK_ID:
            environment.VITE_THRUPUT_NETWORK_ID ?? "11".repeat(32),
          VITE_GAME_OF_LIFE_CONTRACT_ADDRESS:
            environment.VITE_GAME_OF_LIFE_CONTRACT_ADDRESS ??
            `0x${"22".repeat(32)}`,
        }
      : environment,
  );
  validateRpcTarget(target);
  validateIndexerTarget(indexerTarget);
  return {
    envPrefix: [
      "VITE_THRUPUT_RPC_URL",
      "VITE_THRUPUT_LOCAL_FAUCET_ADDRESS",
      "VITE_THRUPUT_NETWORK_ID",
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS",
      "VITE_GAME_OF_LIFE_INDEXER_URL",
      "VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT",
      "VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT",
      "VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS",
      "VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS",
      "VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT",
      "VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT",
      "VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS",
      "VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS",
    ],
    plugins: [
      react(),
      tailwindcss(),
      localRpcProxy(target),
      readOnlyIndexerProxy(indexerTarget, networkId, contractAddress),
      ...(mode === "e2e" ? [fixtureArtifacts(networkId, contractAddress)] : []),
    ],
    resolve: { alias: { "@": path.resolve(root, "src") } },
    server: {
      host: "127.0.0.1",
      cors: false,
      headers: SECURITY_HEADERS,
    },
    preview: { host: "127.0.0.1", cors: false, headers: SECURITY_HEADERS },
    test: {
      execArgv: ["--no-experimental-webstorage"],
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://127.0.0.1" } },
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "vite.config.test.ts"],
    },
  };
});

export function validateRpcTarget(input: string): void {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !isLoopback(url.hostname)
  ) {
    throw new Error(
      "The RPC proxy requires a credential-free loopback HTTP(S) target",
    );
  }
}

export function validateIndexerTarget(input: string): void {
  try {
    validateRpcTarget(input);
    const url = new URL(input);
    if (url.pathname !== "/" || url.search || url.hash) throw new Error();
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
  if (
    requestUrl === `${base}/latest.json` ||
    requestUrl === `${base}/status.json`
  )
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

function localRpcProxy(target: string): Plugin {
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

function readOnlyIndexerProxy(
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

async function readBody(request: IncomingMessage): Promise<string> {
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

function fixtureArtifacts(network: string, contract: string): Plugin {
  const fundedAccounts = new Set<string>();
  const digests = [
    `0x${"aa".repeat(32)}`,
    `0x${"dd".repeat(32)}`,
    `0x${"ee".repeat(32)}`,
  ] as const;
  const block = `0x${"bb".repeat(32)}`;
  const transaction = `0x${"cc".repeat(32)}`;
  const base = `/v1/worlds/${network}/${contract}`;
  const fixture = {
    chainGeneration: 0,
    publishedGeneration: 0,
    status: "idle" as
      "idle" | "preparing" | "error" | "unavailable" | "malformed",
    stale: false,
    tileDelay: 0,
    holdCandidateTiles: false,
    candidateTileHeld: false,
    latestState: "ready" as "ready" | "unavailable" | "malformed",
    rpcState: "ready" as
      | "ready"
      | "unavailable"
      | "malformed"
      | "malformed-schema"
      | "malformed-envelope",
    candidateEvidence: "event" as "event" | "metadata",
  };
  let heldCandidateTiles: Array<() => void> = [];
  const identity = (generation: number) => ({
    epoch: "0",
    networkId: network,
    contractAddress: contract,
    generation: String(generation),
    seed: "7",
    population: String(32768 + generation),
    stateDigest: digests[generation]!,
  });
  const artifact = (pathname: string): unknown => {
    const published = fixture.publishedGeneration;
    const digest = digests[published]!;
    if (pathname === `${base}/latest.json`) {
      if (fixture.latestState === "unavailable") return undefined;
      if (fixture.latestState === "malformed") return { schemaVersion: 2 };
      return {
        schemaVersion: 2,
        epoch: "0",
        generation: String(published),
        stateDigest: digest,
        manifestUrl: `${base}/${digest}/manifest.json`,
        sourceBlockHeight: String(9 + published),
        sourceBlockHash: block,
        publishedAt: "2026-08-28T01:02:03Z",
      };
    }
    if (pathname === `${base}/status.json`) {
      if (fixture.status === "unavailable") return undefined;
      if (fixture.status === "malformed") return { schemaVersion: 2 };
      const preparing = fixture.status === "preparing" ? 1 : null;
      return {
        schemaVersion: 2,
        state: fixture.status,
        observed: { epoch: "0", generation: "1", stateDigest: digests[1] },
        preparing:
          preparing === null
            ? null
            : {
                generation: "1",
                epoch: "0",
                stateDigest: digests[1],
                completedUnits: 7,
                totalUnits: 12,
                unit: "tiles",
              },
        published: {
          epoch: "0",
          generation: String(published),
          stateDigest: digest,
        },
        retry:
          fixture.status === "error"
            ? { attempt: 2, nextAt: "2026-08-29T01:03:00Z" }
            : null,
        errorCode: fixture.status === "error" ? "BUILD_FAILED" : null,
        heartbeatAt: fixture.stale
          ? "2026-08-28T01:02:03Z"
          : new Date().toISOString(),
      };
    }
    for (const generation of [0, 1]) {
      const value = identity(generation);
      const root = `${base}/${value.stateDigest}`;
      if (pathname === `${root}/manifest.json`)
        return {
          schemaVersion: 2,
          ...value,
          width: 10000,
          height: 10000,
          tileSize: 256,
          maxZoom: 6,
          densityEncoding: "u16le-live-count",
          cellEncoding: "row-major-lsb-first",
          tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
          verification: {
            canonicalDownloadVerified: true,
            individualTileProofs: false,
          },
        };
      if (pathname === `${root}/provenance.json`)
        return {
          schemaVersion: 2,
          ...value,
          sourceBlockHeight: String(9 + generation),
          sourceBlockHash: block,
          evidenceKind:
            generation === 1 && fixture.candidateEvidence === "metadata"
              ? "metadata-observation"
              : generation === 0
                ? "world-initialized-event"
                : "generation-advanced-event",
          transactionHash:
            generation === 1 && fixture.candidateEvidence === "metadata"
              ? null
              : transaction,
          eventIndex:
            generation === 1 && fixture.candidateEvidence === "metadata"
              ? null
              : generation,
          eventKind:
            generation === 1 && fixture.candidateEvidence === "metadata"
              ? null
              : generation === 0
                ? "WorldInitialized"
                : "GenerationAdvanced",
          requestId:
            generation === 0 || fixture.candidateEvidence === "metadata"
              ? null
              : `0x${"ef".repeat(32)}`,
          requester:
            generation === 0 || fixture.candidateEvidence === "metadata"
              ? null
              : contract,
          verifiedAt: "2026-08-28T01:02:03Z",
        };
    }
    return undefined;
  };
  const metadataMethod = lifeSpec.interfaces[0]!.methods.find(
    (method) => method.name === "get_metadata",
  )!;
  const metadataCodec = resolveCodec(
    metadataMethod.return_type,
    buildNamedCodecs([...lifeSpec.type_defs]),
  );
  const metadataBytes = (generation: number) =>
    serializeCxs(
      {
        width: 10_000n,
        epoch: 0n,
        height: 10_000n,
        generation: BigInt(generation),
        seed: 7n,
        population: BigInt(32_768 + generation),
        state_digest: new Uint8Array(32).fill(
          generation === 0 ? 0xaa : generation === 1 ? 0xdd : 0xee,
        ),
        chunk_bytes: 1_000n,
        chunks_per_row: 2n,
        max_queue_len: 16n,
      },
      metadataCodec,
    );
  return {
    name: "life-e2e-artifacts",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split("?", 1)[0] ?? "";
        if (request.method === "GET" && pathname === "/__life-fixture") {
          const url = new URL(request.url!, "http://127.0.0.1");
          if (url.searchParams.has("reset")) {
            fundedAccounts.clear();
            fixture.chainGeneration = 0;
            fixture.publishedGeneration = 0;
            fixture.status = "idle";
            fixture.stale = false;
            fixture.tileDelay = 0;
            fixture.holdCandidateTiles = false;
            fixture.candidateTileHeld = false;
            fixture.latestState = "ready";
            fixture.rpcState = "ready";
            fixture.candidateEvidence = "event";
            for (const release of heldCandidateTiles) release();
            heldCandidateTiles = [];
          }
          if (url.searchParams.has("chain")) {
            const chain = Number(url.searchParams.get("chain"));
            if (chain === 0 || chain === 1 || chain === 2)
              fixture.chainGeneration = chain;
          }
          if (url.searchParams.has("published")) {
            const published = Number(url.searchParams.get("published"));
            if (published === 0 || published === 1)
              fixture.publishedGeneration = published;
          }
          const status = url.searchParams.get("status");
          if (
            status === "idle" ||
            status === "preparing" ||
            status === "error" ||
            status === "unavailable" ||
            status === "malformed"
          )
            fixture.status = status;
          if (url.searchParams.has("stale"))
            fixture.stale = url.searchParams.get("stale") === "1";
          if (url.searchParams.has("tileDelay")) {
            const delay = Number(url.searchParams.get("tileDelay"));
            if (Number.isSafeInteger(delay) && delay >= 0 && delay <= 10_000)
              fixture.tileDelay = delay;
          }
          if (url.searchParams.has("holdCandidate"))
            fixture.holdCandidateTiles =
              url.searchParams.get("holdCandidate") === "1";
          if (url.searchParams.get("releaseCandidate") === "1") {
            fixture.holdCandidateTiles = false;
            fixture.candidateTileHeld = false;
            for (const release of heldCandidateTiles) release();
            heldCandidateTiles = [];
          }
          if (url.searchParams.has("latest"))
            fixture.latestState =
              url.searchParams.get("latest") === "unavailable"
                ? "unavailable"
                : url.searchParams.get("latest") === "malformed"
                  ? "malformed"
                  : "ready";
          if (url.searchParams.has("rpc"))
            fixture.rpcState =
              url.searchParams.get("rpc") === "unavailable"
                ? "unavailable"
                : url.searchParams.get("rpc") === "malformed"
                  ? "malformed"
                  : url.searchParams.get("rpc") === "malformed-schema"
                    ? "malformed-schema"
                    : url.searchParams.get("rpc") === "malformed-envelope"
                      ? "malformed-envelope"
                      : "ready";
          if (url.searchParams.has("evidence"))
            fixture.candidateEvidence =
              url.searchParams.get("evidence") === "metadata"
                ? "metadata"
                : "event";
          response.statusCode = 204;
          response.end();
          return;
        }
        if (request.method === "POST" && pathname === "/") {
          if (fixture.rpcState === "unavailable") {
            response.statusCode = 503;
            response.end("unavailable");
            return;
          }
          const envelope = JSON.parse(await readBody(request)) as {
            readonly id: string | number;
            readonly method: string;
            readonly params?: { address?: string; recipient?: string };
          };
          if (fixture.rpcState === "malformed-envelope") {
            response.statusCode = 200;
            response.setHeader("content-type", "application/json");
            response.end("not-json");
            return;
          }
          let walletResult: unknown;
          if (envelope.method === "getBalance") {
            const address = envelope.params!.address!;
            walletResult = {
              address,
              stateBlockHeight: "9",
              rawBalance: fundedAccounts.has(address) ? "20000000000" : "0",
            };
          } else if (envelope.method === "faucet_requestAirdrop") {
            const recipient = envelope.params!.recipient!;
            fundedAccounts.add(recipient);
            walletResult = {
              attemptStatus: "succeeded",
              recipient,
              rawAmount: "20000000000",
              transactionHash: "11111111111111111111111111111111",
              blockHeight: "9",
              execution: { result: "return", returnData: "0x0100" },
            };
          }
          const body = JSON.stringify({
            jsonrpc: "2.0",
            id: envelope.id,
            result:
              walletResult ??
              rpcDiscovery(envelope.method) ??
              (envelope.method === "getEvents"
                ? {
                    events: [],
                    nextCursor: null,
                    latestIndexedBlockHeight: "9",
                    oldestIndexedBlockHeight: "0",
                  }
                : fixture.rpcState === "malformed-schema"
                  ? { output: null, events: "invalid", stateBlockHeight: "9" }
                  : {
                      output: {
                        result: "return",
                        returnData:
                          fixture.rpcState === "malformed"
                            ? "0x00"
                            : hex(metadataBytes(fixture.chainGeneration)),
                      },
                      events: [],
                      stateBlockHeight: "9",
                      gasUsed: "100",
                    }),
          });
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.setHeader("content-length", Buffer.byteLength(body));
          response.end(body);
          return;
        }
        if (
          pathname === `${base}/latest.json` &&
          fixture.latestState === "unavailable"
        ) {
          response.statusCode = 503;
          response.end("unavailable");
          return;
        }
        const value = artifact(pathname);
        if (value !== undefined) {
          const body = JSON.stringify(value);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.setHeader("content-length", Buffer.byteLength(body));
          response.end(body);
          return;
        }
        const tile = pathname.match(
          new RegExp(
            `^${base}/(0x[0-9a-f]{64})/tiles/(\\d)/(\\d+)/(\\d+)\\.bin$`,
          ),
        );
        if (!tile) return next();
        const generation = digests.indexOf(tile[1] as (typeof digests)[number]);
        if (generation < 0) return next();
        const z = Number(tile[2]);
        const bytes =
          z === 6 ? fixtureCells(generation) : fixtureDensity(z, generation);
        if (
          generation === 1 &&
          fixture.holdCandidateTiles &&
          !fixture.candidateTileHeld
        ) {
          fixture.candidateTileHeld = true;
          await new Promise<void>((resolve) =>
            heldCandidateTiles.push(resolve),
          );
        }
        if (generation === 1 && fixture.tileDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, fixture.tileDelay),
          );
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          z === 6
            ? "application/vnd.chain-of-life.cells-v1"
            : "application/vnd.chain-of-life.density-u16le",
        );
        response.setHeader("content-length", bytes.length);
        response.end(bytes);
      });
    },
  };
}
function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}
function fixtureDensity(z: number, generation = 0): Buffer {
  const bytes = Buffer.alloc(131072);
  const scale = 2 ** (6 - z);
  const maximum = scale * scale;
  for (let index = 0; index < 65536; index += 1) {
    const density = index % (maximum + 1);
    bytes.writeUInt16LE(generation ? maximum - density : density, index * 2);
  }
  return bytes;
}
function fixtureCells(generation = 0): Buffer {
  const bytes = Buffer.alloc(8192);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] =
      index % 2 ? (generation ? 0x33 : 0xaa) : generation ? 0xcc : 0x55;
  return bytes;
}
