import type { Plugin } from "vite";
import { buildNamedCodecs, resolveCodec } from "@thruputchain/client/contract";
import { serializeCxs } from "@thruputchain/xdr";
import { spec as lifeSpec } from "../../web/src/contracts/generated/game-of-life";
import { rpcDiscovery } from "../../web/src/test/rpc-discovery";
import { readBody } from "../../scripts/local-rpc-proxy";

export function fixtureArtifacts(network: string, contract: string): Plugin {
  const fundedAccounts = new Set<string>();
  const digests = [`0x${"aa".repeat(32)}`, `0x${"dd".repeat(32)}`] as const;
  const block = `0x${"bb".repeat(32)}`;
  const base = `/v2/worlds/${network}/${contract}`;
  const fixture = {
    resizable: true,
    chainGeneration: 0,
    publishedGeneration: 0,
    holdCandidateTiles: false,
    candidateTileHeld: false,
    latestUnavailable: false,
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
    if (pathname === `${base}/latest.json`)
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
          densityEncoding: "live-count-u8-z3-u16le",
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
        epoch: 0n,
        size: 10_000n,
        generation: BigInt(generation),
        seed: 7n,
        population: BigInt(32_768 + generation),
        state_digest: new Uint8Array(32).fill(generation === 0 ? 0xaa : 0xdd),
        resizable: fixture.resizable,
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
            fixture.resizable = true;
            fixture.chainGeneration = 0;
            fixture.publishedGeneration = 0;
            fixture.holdCandidateTiles = false;
            fixture.candidateTileHeld = false;
            fixture.latestUnavailable = false;
            for (const release of heldCandidateTiles) release();
            heldCandidateTiles = [];
          }
          if (url.searchParams.has("fixed"))
            fixture.resizable = url.searchParams.get("fixed") !== "1";
          if (url.searchParams.has("chain")) {
            const chain = Number(url.searchParams.get("chain"));
            if (chain === 0 || chain === 1) fixture.chainGeneration = chain;
          }
          if (url.searchParams.has("published")) {
            const published = Number(url.searchParams.get("published"));
            if (published === 0 || published === 1)
              fixture.publishedGeneration = published;
          }
          if (url.searchParams.get("holdCandidate") === "1")
            fixture.holdCandidateTiles = true;
          if (url.searchParams.get("releaseCandidate") === "1") {
            fixture.holdCandidateTiles = false;
            fixture.candidateTileHeld = false;
            for (const release of heldCandidateTiles) release();
            heldCandidateTiles = [];
          }
          if (url.searchParams.get("latest") === "unavailable")
            fixture.latestUnavailable = true;
          response.statusCode = 204;
          response.end();
          return;
        }
        if (request.method === "POST" && pathname === "/") {
          const envelope = JSON.parse(await readBody(request)) as {
            readonly id: string | number;
            readonly method: string;
            readonly params?: { address?: string; recipient?: string };
          };
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
                : {
                    output: {
                      result: "return",
                      returnData: hex(metadataBytes(fixture.chainGeneration)),
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
        if (pathname === `${base}/latest.json` && fixture.latestUnavailable) {
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
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          z === 6
            ? "application/vnd.chain-of-life.cells-v1"
            : z >= 3
              ? "application/vnd.chain-of-life.density-u8"
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
  // Zoom 3 and above store one byte per texel; lower levels, two.
  const width = z >= 3 ? 1 : 2;
  const bytes = Buffer.alloc(65536 * width);
  const scale = 2 ** (6 - z);
  const maximum = scale * scale;
  for (let index = 0; index < 65536; index += 1) {
    const density = index % (maximum + 1);
    const value = generation ? maximum - density : density;
    if (width === 1) bytes.writeUInt8(value, index);
    else bytes.writeUInt16LE(value, index * 2);
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
