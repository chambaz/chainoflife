import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import {
  CELLS_CONTENT_TYPE,
  DENSITY_CONTENT_TYPE,
  MAX_ZOOM,
} from "@/indexer/schema";
import { ByteBudget, CPU_TILE_CACHE_BYTES } from "./budget";
import { CELL_BYTES, DENSITY_BYTES } from "./decode";
import type { DecodedTile } from "./inspection";
import { tileId, type TileIndex } from "./pyramid";
import { TileWorkerPool } from "./worker-pool";

export interface LoadedTileData {
  readonly availability: "loaded";
  readonly byteLength: number;
  readonly digest: string;
  readonly index: TileIndex;
  readonly tile: DecodedTile;
}
export interface MissingTileData {
  readonly availability: "missing";
  readonly byteLength: number;
  readonly digest: string;
  readonly index: TileIndex;
}
export type TileData = LoadedTileData | MissingTileData;
/** Shared by the displayed and candidate loaders of one renderer. */
export interface TileResources {
  readonly cache: ByteBudget<TileData>;
  readonly pool: Pick<TileWorkerPool, "decode" | "close">;
}

export function createTileResources(): TileResources {
  return {
    cache: new ByteBudget(CPU_TILE_CACHE_BYTES),
    pool: new TileWorkerPool(2),
  };
}
interface InFlightTile {
  readonly controller: AbortController;
  promise: Promise<TileData>;
  consumers: number;
  settled: boolean;
}
export class TileLoader {
  readonly cache: ByteBudget<TileData>;
  private readonly inFlight = new Map<string, InFlightTile>();
  private readonly pool: TileResources["pool"];
  private readonly lifetime = new AbortController();
  constructor(
    private readonly client: IndexerClient,
    private readonly snapshot: ImmutableSnapshot,
    resources: TileResources,
  ) {
    this.cache = resources.cache;
    this.pool = resources.pool;
  }
  load(index: TileIndex, signal?: AbortSignal): Promise<TileData> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = `${this.snapshot.manifest.stateDigest}:${tileId(index)}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.inFlight.get(key);
    if (existing) return this.consume(key, existing, signal);
    return this.consume(key, this.start(index, key), signal);
  }
  private start(index: TileIndex, key: string): InFlightTile {
    const controller = new AbortController();
    const effectiveSignal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
    ]);
    const entry = {
      controller,
      consumers: 0,
      settled: false,
    } as InFlightTile;
    entry.promise = this.fetchDecode(index, effectiveSignal)
      .then((data) => {
        this.cache.set(key, data, data.byteLength);
        return data;
      })
      .finally(() => {
        entry.settled = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      });
    this.inFlight.set(key, entry);
    return entry;
  }
  close(): void {
    this.lifetime.abort(new DOMException("Tile loader closed", "AbortError"));
  }
  pin(indices: readonly TileIndex[]): void {
    for (const index of indices)
      this.cache.pin(`${this.snapshot.manifest.stateDigest}:${tileId(index)}`);
  }
  unpin(indices: readonly TileIndex[]): void {
    for (const index of indices)
      this.cache.unpin(
        `${this.snapshot.manifest.stateDigest}:${tileId(index)}`,
      );
  }
  purge(): void {
    this.cache.deletePrefix(`${this.snapshot.manifest.stateDigest}:`);
  }
  /** Loads tiles one at a time so prefetching never competes with visible loads. */
  async prefetch(
    indices: readonly TileIndex[],
    signal: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = AbortSignal.any([signal, this.lifetime.signal]);
    for (const index of indices) {
      effectiveSignal.throwIfAborted();
      const key = `${this.snapshot.manifest.stateDigest}:${tileId(index)}`;
      if (this.cache.get(key)) continue;
      const entry = this.inFlight.get(key) ?? this.start(index, key);
      await this.consume(key, entry, effectiveSignal);
    }
  }
  private async fetchDecode(
    index: TileIndex,
    signal: AbortSignal,
  ): Promise<TileData> {
    let result: { bytes: ArrayBuffer; contentType: string };
    try {
      result = await this.fetchBytes(index, signal);
    } catch (cause) {
      if (cause instanceof TileUnavailableError)
        return {
          availability: "missing",
          byteLength: 64,
          digest: this.snapshot.manifest.stateDigest,
          index,
        };
      throw cause;
    }
    const { bytes, contentType } = result;
    const tile = await this.pool.decode(bytes, contentType, index.z, signal);
    return {
      availability: "loaded",
      byteLength: tile.values.byteLength,
      digest: this.snapshot.manifest.stateDigest,
      index,
      tile,
    };
  }
  private async fetchBytes(
    index: TileIndex,
    signal: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const exact = index.z === MAX_ZOOM;
    const expected = exact ? CELLS_CONTENT_TYPE : DENSITY_CONTENT_TYPE;
    const response = await globalThis.fetch(
      this.client.tileUrl(this.snapshot, index.z, index.x, index.y),
      { headers: { accept: expected }, redirect: "error", signal },
    );
    if (!response.ok) {
      if (response.status === 404) throw new TileUnavailableError();
      throw new Error(`Tile request failed (${response.status})`);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== expected)
      throw new Error(
        `Unexpected tile content type: ${contentType ?? "missing"}`,
      );
    const expectedLength = exact ? CELL_BYTES : DENSITY_BYTES;
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      response.headers.get("content-encoding") === null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) !== expectedLength)
    )
      throw new Error("Unexpected tile content length");
    const bytes = await readExactBody(response, expectedLength, signal);
    return { bytes, contentType };
  }
  private consume(
    key: string,
    entry: InFlightTile,
    signal?: AbortSignal,
  ): Promise<TileData> {
    entry.consumers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        entry.consumers -= 1;
        if (entry.consumers === 0 && !entry.settled) {
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
          entry.controller.abort(
            new DOMException("All tile consumers aborted", "AbortError"),
          );
        }
        return true;
      };
      const abort = () => {
        if (finish())
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (cause) => {
          if (finish()) reject(cause);
        },
      );
    });
  }
}

class TileUnavailableError extends Error {
  constructor() {
    super("Tile unavailable");
    this.name = "TileUnavailableError";
  }
}

async function readExactBody(
  response: Response,
  expectedLength: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("Tile response body is missing");
  const reader = response.body.getReader();
  const output = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedLength)
        throw new Error("Unexpected decoded tile length");
      output.set(value, offset);
      offset += value.byteLength;
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  }
  if (offset !== expectedLength)
    throw new Error("Unexpected decoded tile length");
  return output.buffer;
}
