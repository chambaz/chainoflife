import { DECIMAL, HEX32 } from "@/lib/validation";

/** The largest supported world width and height. */
export const MAX_WORLD_SIZE = 11_400;
export const TILE_SIZE = 256;
/** Version of the indexer JSON documents. */
export const SCHEMA_VERSION = 2;
export const MAX_ZOOM = 6;
/** Density levels at and above this zoom store one byte per texel; lower levels, two. */
export const DENSITY_U8_MIN_ZOOM = 3;
export const DENSITY_ENCODING = "live-count-u8-z3-u16le";
export const DENSITY_CONTENT_TYPE =
  "application/vnd.chain-of-life.density-u16le";
export const DENSITY_U8_CONTENT_TYPE =
  "application/vnd.chain-of-life.density-u8";
export const CELLS_CONTENT_TYPE = "application/vnd.chain-of-life.cells-v1";

const NETWORK = /^[0-9a-f]{64}$/;

export interface SnapshotIdentity {
  readonly epoch: string;
  readonly networkId: string;
  readonly contractAddress: string;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
}

export interface LifeManifest extends SnapshotIdentity {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly width: number;
  readonly height: number;
  readonly tileSize: 256;
  readonly maxZoom: 6;
  readonly densityEncoding: typeof DENSITY_ENCODING;
  readonly cellEncoding: "row-major-lsb-first";
  readonly tilePathTemplate: "tiles/{z}/{x}/{y}.bin";
  readonly verification: {
    readonly canonicalDownloadVerified: true;
    readonly individualTileProofs: false;
  };
}

export interface LatestPointer {
  readonly epoch: string;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generation: string;
  readonly stateDigest: string;
  readonly manifestUrl: string;
  readonly sourceBlockHeight: string;
  readonly sourceBlockHash: string;
  readonly publishedAt: string;
}

export interface LifeProvenance extends SnapshotIdentity {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sourceBlockHeight: string;
  readonly sourceBlockHash: string;
  readonly verifiedAt: string;
}

export interface CurrentWorldMetadata {
  readonly epoch: string;
  readonly size: number;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export function worldSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    value < 100 ||
    value > MAX_WORLD_SIZE ||
    value % 100 !== 0
  )
    throw new SchemaError("world size must be 100–10,000 in steps of 100");
  return value;
}

export function compareWorldVersion(
  left: { readonly epoch: string; readonly generation: string },
  right: { readonly epoch: string; readonly generation: string },
): number {
  const epoch = BigInt(left.epoch) - BigInt(right.epoch);
  const difference =
    epoch || BigInt(left.generation) - BigInt(right.generation);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function parseManifest(input: unknown): LifeManifest {
  const value = record(input, "manifest", [
    "epoch",
    "schemaVersion",
    "networkId",
    "contractAddress",
    "generation",
    "seed",
    "width",
    "height",
    "population",
    "stateDigest",
    "tileSize",
    "maxZoom",
    "densityEncoding",
    "cellEncoding",
    "tilePathTemplate",
    "verification",
  ]);
  const verification = record(value.verification, "verification", [
    "canonicalDownloadVerified",
    "individualTileProofs",
  ]);
  literal(value.schemaVersion, SCHEMA_VERSION, "schemaVersion");
  const width = worldSize(value.width);
  literal(value.height, width, "height");
  literal(value.tileSize, TILE_SIZE, "tileSize");
  literal(value.maxZoom, MAX_ZOOM, "maxZoom");
  literal(value.densityEncoding, DENSITY_ENCODING, "densityEncoding");
  literal(value.cellEncoding, "row-major-lsb-first", "cellEncoding");
  literal(value.tilePathTemplate, "tiles/{z}/{x}/{y}.bin", "tilePathTemplate");
  literal(
    verification.canonicalDownloadVerified,
    true,
    "verification.canonicalDownloadVerified",
  );
  literal(
    verification.individualTileProofs,
    false,
    "verification.individualTileProofs",
  );
  const identity = parseIdentity(value);
  if (BigInt(identity.population) > BigInt(width * width))
    throw new SchemaError("population exceeds world dimensions");
  return {
    ...identity,
    schemaVersion: SCHEMA_VERSION,
    width,
    height: width,
    tileSize: 256,
    maxZoom: 6,
    densityEncoding: DENSITY_ENCODING,
    cellEncoding: "row-major-lsb-first",
    tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
    verification: {
      canonicalDownloadVerified: true,
      individualTileProofs: false,
    },
  };
}

export function parseLatest(
  input: unknown,
  networkId: string,
  contractAddress: string,
): LatestPointer {
  canonicalNetwork(networkId);
  canonicalHex32(contractAddress, "contractAddress");
  const value = record(input, "latest", [
    "epoch",
    "schemaVersion",
    "generation",
    "stateDigest",
    "manifestUrl",
    "sourceBlockHeight",
    "sourceBlockHash",
    "publishedAt",
  ]);
  literal(value.schemaVersion, SCHEMA_VERSION, "schemaVersion");
  const generation = decimal(value.generation, "generation");
  const stateDigest = canonicalHex32(value.stateDigest, "stateDigest");
  const expected = `/v2/worlds/${networkId}/${contractAddress}/${stateDigest}/manifest.json`;
  literal(value.manifestUrl, expected, "manifestUrl");
  return {
    schemaVersion: SCHEMA_VERSION,
    epoch: decimal(value.epoch, "epoch"),
    generation,
    stateDigest,
    manifestUrl: expected,
    sourceBlockHeight: decimal(value.sourceBlockHeight, "sourceBlockHeight"),
    sourceBlockHash: canonicalHex32(value.sourceBlockHash, "sourceBlockHash"),
    publishedAt: date(value.publishedAt, "publishedAt"),
  };
}

export function parseProvenance(input: unknown): LifeProvenance {
  const value = record(input, "provenance", [
    "epoch",
    "schemaVersion",
    "networkId",
    "contractAddress",
    "generation",
    "seed",
    "population",
    "stateDigest",
    "sourceBlockHeight",
    "sourceBlockHash",
    "verifiedAt",
  ]);
  literal(value.schemaVersion, SCHEMA_VERSION, "schemaVersion");
  return {
    ...parseIdentity(value),
    schemaVersion: SCHEMA_VERSION,
    sourceBlockHeight: decimal(value.sourceBlockHeight, "sourceBlockHeight"),
    sourceBlockHash: canonicalHex32(value.sourceBlockHash, "sourceBlockHash"),
    verifiedAt: date(value.verifiedAt, "verifiedAt"),
  };
}

export function assertSnapshotAgreement(
  latest: LatestPointer,
  manifest: LifeManifest,
  provenance: LifeProvenance,
): void {
  const identityKeys = ["epoch", "generation", "stateDigest"] as const;
  for (const key of identityKeys)
    if (latest[key] !== manifest[key])
      throw new SchemaError(`latest and manifest ${key} disagree`);
  const fullKeys = [
    "epoch",
    "networkId",
    "contractAddress",
    "generation",
    "seed",
    "population",
    "stateDigest",
  ] as const;
  for (const key of fullKeys)
    if (manifest[key] !== provenance[key])
      throw new SchemaError(`manifest and provenance ${key} disagree`);
  if (
    latest.sourceBlockHeight !== provenance.sourceBlockHeight ||
    latest.sourceBlockHash !== provenance.sourceBlockHash
  ) {
    throw new SchemaError("latest and provenance source block disagree");
  }
}

/**
 * A snapshot is eligible when it matches the current chain state, or when it is
 * older and its provenance is a committed event. Every provenance kind is a
 * committed event, so only the current chain state is compared here. The
 * indexer client already confines snapshots to the configured world scope.
 */
export function assertSnapshotEligible(
  manifest: LifeManifest,
  current: CurrentWorldMetadata,
): void {
  if (manifest.seed !== current.seed)
    throw new SchemaError("snapshot and current chain seed disagree");
  const order = compareWorldVersion(manifest, current);
  if (order > 0)
    throw new SchemaError("snapshot is ahead of accepted chain metadata");
  if (order !== 0) return;
  const mismatch = (
    [
      ["size", manifest.width, current.size],
      ["population", manifest.population, current.population],
      ["stateDigest", manifest.stateDigest, current.stateDigest],
    ] as const
  ).find(([, snapshot, chain]) => snapshot !== chain);
  if (mismatch)
    throw new SchemaError(`snapshot and current chain ${mismatch[0]} disagree`);
}

function canonicalHex32(input: unknown, field: string): string {
  const value = string(input, field);
  if (!HEX32.test(value))
    throw new SchemaError(`${field} is not canonical lowercase hex32`);
  return value;
}

function parseIdentity(value: Record<string, unknown>): SnapshotIdentity {
  const population = decimal(value.population, "population");
  if (BigInt(population) > BigInt(MAX_WORLD_SIZE ** 2))
    throw new SchemaError("population exceeds world capacity");
  return {
    networkId: canonicalNetwork(value.networkId),
    epoch: decimal(value.epoch, "epoch"),
    contractAddress: canonicalHex32(value.contractAddress, "contractAddress"),
    generation: decimal(value.generation, "generation"),
    seed: decimal(value.seed, "seed"),
    population,
    stateDigest: canonicalHex32(value.stateDigest, "stateDigest"),
  };
}

function canonicalNetwork(input: unknown): string {
  const value = string(input, "networkId");
  if (!NETWORK.test(value)) throw new SchemaError("networkId is not canonical");
  return value;
}
function decimal(input: unknown, field: string): string {
  const value = string(input, field);
  if (!DECIMAL.test(value) || BigInt(value) > 18_446_744_073_709_551_615n)
    throw new SchemaError(`${field} is not canonical u64`);
  return value;
}
function date(input: unknown, field: string): string {
  const value = string(input, field);
  const parsed = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new SchemaError(`${field} is not a canonical UTC date`);
  return value;
}
function record(
  input: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new SchemaError(`${field} must be an object`);
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value))
  )
    throw new SchemaError(`${field} has missing or unknown fields`);
  return value;
}
function string(input: unknown, field: string): string {
  if (typeof input !== "string")
    throw new SchemaError(`${field} must be a string`);
  return input;
}
function literal<T extends string | number | boolean>(
  input: unknown,
  expected: T,
  field: string,
): asserts input is T {
  if (input !== expected)
    throw new SchemaError(`${field} must be ${String(expected)}`);
}
