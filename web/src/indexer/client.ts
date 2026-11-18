import type { AppConfig } from "@/config";
import { tileCount } from "@/renderer/pyramid";
import {
  assertSnapshotAgreement,
  MAX_ZOOM,
  parseLatest,
  parseManifest,
  parseProvenance,
  type LatestPointer,
  type LifeManifest,
  type LifeProvenance,
} from "./schema";

export interface ImmutableSnapshot {
  readonly manifest: LifeManifest;
  readonly provenance: LifeProvenance;
  readonly manifestUrl: URL;
}

/** Reads published snapshots directly from the indexer's origin. */
export class IndexerClient {
  constructor(
    private readonly config: Pick<
      AppConfig,
      "indexerUrl" | "networkId" | "contractAddress"
    >,
    private readonly fetcher: typeof fetch = (...args) =>
      globalThis.fetch(...args),
  ) {}

  async latest(signal?: AbortSignal): Promise<LatestPointer> {
    return parseLatest(
      await this.json(new URL("latest.json", this.worldBase()), signal),
      this.config.networkId,
      this.config.contractAddress,
    );
  }

  async snapshotFromPointer(
    latest: LatestPointer,
    signal?: AbortSignal,
  ): Promise<ImmutableSnapshot> {
    const manifestUrl = this.confined(latest.manifestUrl);
    const provenanceUrl = new URL("provenance.json", manifestUrl);
    const [manifest, provenance] = await Promise.all([
      this.json(manifestUrl, signal).then(parseManifest),
      this.json(provenanceUrl, signal).then(parseProvenance),
    ]);
    assertSnapshotAgreement(latest, manifest, provenance);
    if (
      manifest.networkId !== this.config.networkId ||
      manifest.contractAddress !== this.config.contractAddress
    )
      throw new Error("snapshot is outside the configured world scope");
    return Object.freeze({ manifest, provenance, manifestUrl });
  }

  tileUrl(snapshot: ImmutableSnapshot, z: number, x: number, y: number): URL {
    if (
      ![z, x, y].every(Number.isSafeInteger) ||
      z < 0 ||
      z > MAX_ZOOM ||
      x < 0 ||
      y < 0 ||
      x >= tileCount(z, snapshot.manifest.width) ||
      y >= tileCount(z, snapshot.manifest.width)
    )
      throw new RangeError("invalid tile coordinate");
    return new URL(`tiles/${z}/${x}/${y}.bin`, snapshot.manifestUrl);
  }

  private worldBase(): URL {
    return new URL(
      `/v2/worlds/${this.config.networkId}/${this.config.contractAddress}/`,
      this.config.indexerUrl,
    );
  }

  private confined(path: string): URL {
    const result = new URL(path, this.config.indexerUrl);
    if (
      result.origin !== this.config.indexerUrl.origin ||
      result.pathname !== path ||
      result.search ||
      result.hash
    ) {
      throw new Error("indexer URL escaped its configured origin");
    }
    return result;
  }

  private async json(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw new Error(`Indexer request failed (${response.status})`);
    const type = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json")
      throw new Error(`Unexpected indexer content type: ${type ?? "missing"}`);
    return response.json() as Promise<unknown>;
  }
}
