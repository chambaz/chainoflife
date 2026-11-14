import {
  Deck,
  OrthographicView,
  OrthographicViewport,
  type ViewStateChangeParameters,
} from "@deck.gl/core";
import type { NonGeoBoundingBox } from "@deck.gl/geo-layers";
import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import { compareWorldVersion, MAX_ZOOM, TILE_SIZE } from "@/indexer/schema";
import { GPU_TILE_CACHE_BYTES } from "./budget";
import {
  clampCamera,
  fitCamera,
  fillCamera,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  parseCamera,
  serializeCamera,
  type Camera,
} from "./camera";
import { inspect, type Inspection } from "./inspection";
import { hasRequiredCoverage } from "./coverage";
import { LifeTileTextureLayer } from "./life-tile-layer";
import { LifeTileLayer, LifeTileset } from "./life-tileset";
import {
  clippedBounds,
  immediateParentRefinement,
  parentIndex,
  ring,
  tileId,
  worldToTile,
  type RefinementTile,
  type TileIndex,
} from "./pyramid";
import {
  createTileResources,
  TileLoader,
  type TileData,
  type TileResources,
} from "./tile-loader";
import { UnavailableTileLayer } from "./unavailable-tile-layer";

/** Concurrent visible tile requests per snapshot layer; deck.gl drops stale queued requests. */
const VISIBLE_TILE_REQUESTS = 4;

export interface RendererCallbacks {
  onCamera(camera: Camera): void;
  onLevel(level: number): void;
  onInspect(
    value: Inspection | null,
    announce: boolean,
    highlight: CellHighlight | null,
  ): void;
  onError(message: string): void;
  /** Reports the latest problem with a selected tile, or null once it is resolved. */
  onTileWarning(message: string | null): void;
  onContext(lost: boolean): void;
  onUnavailable(message: string): void;
  approveSnapshotCommit(
    snapshot: ImmutableSnapshot,
    identity: CandidateIdentity,
  ): boolean;
}
export interface CellHighlight {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface CandidateIdentity {
  readonly epoch: number;
  readonly digest: string;
}
interface Selection {
  readonly level: number;
  readonly tiles: readonly TileIndex[];
  readonly key: string;
}
/** One snapshot with its tile loader and the tiles deck.gl currently selects for it. */
interface World {
  readonly snapshot: ImmutableSnapshot;
  readonly loader: TileLoader;
  selection: Selection;
}
/** A newer snapshot that stays hidden until its tiles cover the viewport. */
interface Candidate extends World {
  readonly epoch: number;
  visible: boolean;
}
const EMPTY_SELECTION: Selection = { level: 0, tiles: [], key: "" };

/**
 * Draws one displayed snapshot and, while it loads, at most one candidate.
 * The candidate replaces the displayed snapshot only after its GPU tiles
 * cover the viewport, a frame has drawn it, and the app approves ownership.
 */
export class WorldRenderer {
  private readonly resources: TileResources;
  private displayed: World | null = null;
  private candidate: Candidate | null = null;
  private deck: Deck<OrthographicView> | null = null;
  private camera: Camera;
  private readonly renderReady = new Map<string, number>();
  private renderFrame = 0;
  private coverageReadyFrame: number | null = null;
  private commitAfterFrame: number | null = null;
  private prefetchController: AbortController | null = null;
  private idleCallback = 0;
  private inspectTimer = 0;
  private cameraTimer = 0;
  private pointerClientPosition: readonly [number, number] | null = null;
  private tileWarning: { world: World; id: string } | null = null;
  private destroyed = false;
  private readonly listeners: Array<() => void> = [];
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly client: IndexerClient,
    displayed: ImmutableSnapshot | null,
    private readonly initialWorldSize: number,
    private readonly callbacks: RendererCallbacks,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: true,
    });
    if (!gl)
      throw new Error("WebGL2 is unavailable; metadata remains available.");
    this.resources = createTileResources();
    if (displayed) this.displayed = this.createWorld(displayed);
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;
    const filled = fillCamera(width, height, this.cameraWorldSize);
    const saved = parseCamera(location.search);
    this.camera = clampCamera(
      saved ? { ...saved, zoom: Math.max(saved.zoom, filled.zoom) } : filled,
      width,
      height,
      this.cameraWorldSize,
    );
    this.listen("pointermove", (event) => this.pointer(event as PointerEvent));
    this.listen("pointerleave", () => {
      clearTimeout(this.inspectTimer);
      this.pointerClientPosition = null;
      callbacks.onInspect(null, false, null);
    });
    this.listen("webglcontextlost", (event) => this.contextLost(event), true);
    this.listen("webglcontextrestored", () => this.contextRestored(), true);
    this.listen(
      "keydown",
      (event) => this.handleKey(event as KeyboardEvent),
      true,
    );
    try {
      this.createDeck();
      callbacks.onCamera(this.camera);
    } catch (cause) {
      for (const remove of this.listeners.splice(0)) remove();
      this.displayed?.loader.close();
      this.resources.pool.close();
      this.resources.cache.clear();
      throw cause;
    }
  }
  zoom(delta: number): void {
    this.setCamera({
      ...this.camera,
      zoom: Math.min(
        MAX_CAMERA_ZOOM,
        Math.max(MIN_CAMERA_ZOOM, this.camera.zoom + delta),
      ),
    });
  }
  fit(): void {
    this.setCamera(
      fitCamera(
        this.canvas.clientWidth,
        this.canvas.clientHeight,
        this.cameraWorldSize,
      ),
    );
  }
  fill(): void {
    this.setCamera(
      fillCamera(
        this.canvas.clientWidth,
        this.canvas.clientHeight,
        this.cameraWorldSize,
      ),
    );
  }
  /** Keyboard navigation shared by the canvas and its focusable container. */
  handleKey(event: KeyboardEvent): void {
    const step = 300 / 2 ** this.camera.zoom;
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      this.zoom(0.5);
    } else if (event.key === "-") {
      event.preventDefault();
      this.zoom(-0.5);
    } else if (event.key === "0") {
      event.preventDefault();
      this.fit();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.inspectScreen(
        this.canvas.clientWidth / 2,
        this.canvas.clientHeight / 2,
        true,
      );
    } else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const dx =
        event.key === "ArrowRight"
          ? step
          : event.key === "ArrowLeft"
            ? -step
            : 0;
      const dy =
        event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
      this.setCamera({
        ...this.camera,
        x: this.camera.x + dx,
        y: this.camera.y + dy,
      });
    }
  }
  /** Applies the canvas size after its container resizes. */
  resize(): void {
    const next = clampCamera(
      this.camera,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.cameraWorldSize,
    );
    const changed = !sameCamera(this.camera, next);
    this.camera = next;
    this.deck?.setProps({
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      viewState: this.viewState(),
    });
    if (changed) {
      this.callbacks.onCamera(this.camera);
      this.refreshInspection();
      this.publishCamera();
    } else if (this.pointerClientPosition) this.refreshInspection();
  }
  stageSnapshot(snapshot: ImmutableSnapshot, epoch: number): void {
    if (this.destroyed) return;
    for (const [world, name] of [
      [this.displayed, "visualized"],
      [this.candidate, "candidate"],
    ] as const) {
      if (!world) continue;
      const order = compareWorldVersion(
        snapshot.manifest,
        world.snapshot.manifest,
      );
      if (order < 0) return;
      if (order === 0) {
        if (
          snapshot.manifest.stateDigest !== world.snapshot.manifest.stateDigest
        ) {
          this.cancelCandidate();
          this.callbacks.onError(
            `Indexer returned conflicting digests for the ${name} generation`,
          );
        }
        return;
      }
    }
    this.cancelCandidate();
    const previousSize = this.cameraWorldSize;
    this.candidate = { ...this.createWorld(snapshot), epoch, visible: false };
    if (snapshot.manifest.width !== previousSize) this.fill();
    this.updateLayers();
  }
  cancelCandidate(): void {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = null;
    this.coverageReadyFrame = null;
    this.commitAfterFrame = null;
    this.updateLayers();
    this.closeWorld(candidate);
    this.clearStaleTileWarning();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.inspectTimer);
    clearTimeout(this.cameraTimer);
    this.cancelPrefetch();
    for (const remove of this.listeners) remove();
    this.deck?.finalize();
    this.deck = null;
    this.displayed?.loader.close();
    this.candidate?.loader.close();
    this.resources.pool.close();
    this.resources.cache.clear();
  }

  private createWorld(snapshot: ImmutableSnapshot): World {
    return {
      snapshot,
      loader: new TileLoader(this.client, snapshot, this.resources),
      selection: EMPTY_SELECTION,
    };
  }
  private closeWorld(world: World): void {
    world.loader.unpin(inspectionTiles(world.selection.tiles));
    world.loader.close();
    world.loader.purge();
    const prefix = `${world.snapshot.manifest.stateDigest}:`;
    for (const key of this.renderReady.keys())
      if (key.startsWith(prefix)) this.renderReady.delete(key);
  }
  private createDeck(): void {
    this.deck = new Deck({
      canvas: this.canvas,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      views: new OrthographicView({
        id: "life",
        flipY: true,
        controller: {
          dragRotate: false,
          touchRotate: false,
          scrollZoom: { smooth: true },
        },
      }),
      viewState: this.viewState(),
      layers: this.layers(),
      onViewStateChange: (event) => this.viewChanged(event),
      // deck.gl makes its canvas focusable; the container owns keyboard focus.
      onLoad: () => (this.canvas.tabIndex = -1),
      onError: (error) => this.callbacks.onError(error.message),
      onAfterRender: () => this.afterRender(),
    });
  }
  private updateLayers(): void {
    this.deck?.setProps({ layers: this.layers() });
  }
  private layers(): LifeTileLayer<TileData>[] {
    const layers: LifeTileLayer<TileData>[] = [];
    if (this.displayed) layers.push(this.layer(this.displayed, true));
    if (this.candidate)
      layers.push(this.layer(this.candidate, this.candidate.visible));
    return layers;
  }
  private layer(world: World, visible: boolean): LifeTileLayer<TileData> {
    const { manifest, manifestUrl } = world.snapshot;
    const digest = manifest.stateDigest;
    return new LifeTileLayer<TileData>({
      id: `life-${digest}`,
      data: manifestUrl.href,
      visible,
      TilesetClass: LifeTileset,
      extent: [0, 0, manifest.width, manifest.height],
      tileSize: TILE_SIZE * 2 ** MAX_ZOOM,
      minZoom: 0,
      maxZoom: MAX_ZOOM,
      zoomOffset: MAX_ZOOM,
      maxRequests: VISIBLE_TILE_REQUESTS,
      maxCacheByteSize: GPU_TILE_CACHE_BYTES,
      onSelection: (level, tiles) => this.selectionChanged(world, level, tiles),
      getTileData: ({ index, signal }) =>
        world.loader.load(index, signal).then(
          (data) => {
            if (data.availability === "missing")
              this.warn(
                world,
                tileId(index),
                "Tile unavailable; showing diagonal hatch",
              );
            if (world === this.displayed && this.pointerClientPosition)
              queueMicrotask(() => this.refreshInspection(false));
            return data;
          },
          (cause) => {
            if (!signal?.aborted)
              this.warn(
                world,
                tileId(index),
                cause instanceof Error ? cause.message : "Tile loading failed",
              );
            throw cause;
          },
        ),
      refinementStrategy: (tiles) =>
        immediateParentRefinement(tiles as unknown as RefinementTile[], digest),
      renderSubLayers: (props) => {
        if (!props.data) return null;
        const id = tileId(props.data.index);
        const bounds = clippedBounds(
          props.tile.bbox as NonGeoBoundingBox,
          manifest.width,
        );
        const onResourceError = (message: string) =>
          this.warn(world, id, message);
        if (props.data.availability === "missing")
          return new UnavailableTileLayer(props, {
            id: `${props.id}-unavailable`,
            bounds,
            onResourceError,
            pickable: false,
          });
        return new LifeTileTextureLayer(props, {
          id: `${props.id}-texture`,
          worldSize: manifest.width,
          bounds,
          content: props.data,
          resourceKey: `${digest}:${id}`,
          onResourceReady: (key) => {
            this.resourceReady(key);
            if (this.tileWarning?.world === world && this.tileWarning.id === id)
              this.clearTileWarning();
          },
          onResourceReleased: (key) => this.resourceReleased(key),
          onResourceError,
          pickable: false,
        });
      },
    });
  }

  private warn(world: World, id: string, message: string): void {
    if (this.destroyed || !this.isSelected(world, id)) return;
    this.tileWarning = { world, id };
    this.callbacks.onTileWarning(message);
  }
  private clearStaleTileWarning(): void {
    const warning = this.tileWarning;
    if (warning && !this.isSelected(warning.world, warning.id))
      this.clearTileWarning();
  }
  private clearTileWarning(): void {
    this.tileWarning = null;
    this.callbacks.onTileWarning(null);
  }
  private isSelected(world: World, id: string): boolean {
    return (
      (world === this.displayed || world === this.candidate) &&
      world.selection.tiles.some((index) => tileId(index) === id)
    );
  }

  private get cameraWorldSize(): number {
    return (
      this.candidate?.snapshot.manifest.width ??
      this.displayed?.snapshot.manifest.width ??
      this.initialWorldSize
    );
  }
  private viewState() {
    return {
      target: [this.camera.x, this.camera.y, 0] as [number, number, number],
      zoom: this.camera.zoom,
    };
  }
  private setCamera(camera: Camera): void {
    const next = clampCamera(
      camera,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.cameraWorldSize,
    );
    const changed = !sameCamera(this.camera, next);
    this.camera = next;
    this.deck?.setProps({ viewState: this.viewState() });
    if (changed) this.refreshInspection();
    this.publishCamera();
  }
  private viewChanged({
    viewState,
    interactionState,
  }: ViewStateChangeParameters) {
    const previous = this.camera;
    const target = viewState.target ?? [this.camera.x, this.camera.y, 0];
    this.camera = clampCamera(
      {
        x: Number(target[0]),
        y: Number(target[1]),
        zoom: Number(viewState.zoom),
      },
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.cameraWorldSize,
    );
    this.deck?.setProps({ viewState: this.viewState() });
    if (!sameCamera(previous, this.camera)) this.refreshInspection();
    if (Object.values(interactionState).some(Boolean)) this.publishCamera();
  }
  private publishCamera(): void {
    clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => {
      this.callbacks.onCamera(this.camera);
      history.replaceState(null, "", serializeCamera(this.camera));
    }, 120);
  }
  private pointer(event: PointerEvent): void {
    this.pointerClientPosition = [event.clientX, event.clientY];
    this.refreshInspection(false);
  }
  private refreshInspection(clear = true): void {
    clearTimeout(this.inspectTimer);
    if (clear) this.callbacks.onInspect(null, false, null);
    if (!this.pointerClientPosition) return;
    this.inspectTimer = window.setTimeout(() => {
      if (!this.pointerClientPosition) return;
      const rect = this.canvas.getBoundingClientRect();
      this.inspectScreen(
        this.pointerClientPosition[0] - rect.left,
        this.pointerClientPosition[1] - rect.top,
        false,
      );
    }, 80);
  }
  private listen(type: string, handler: EventListener, capture = false): void {
    this.canvas.addEventListener(type, handler, capture);
    this.listeners.push(() =>
      this.canvas.removeEventListener(type, handler, capture),
    );
  }
  private contextLost(event: Event): void {
    event.preventDefault();
    this.callbacks.onContext(true);
    this.cancelPrefetch();
    this.renderReady.clear();
    this.coverageReadyFrame = null;
    this.commitAfterFrame = null;
    if (this.candidate) this.candidate.visible = false;
    const deck = this.deck;
    this.deck = null;
    deck?.finalize();
  }
  private contextRestored(): void {
    if (this.destroyed) return;
    try {
      this.createDeck();
      this.callbacks.onContext(false);
    } catch (cause) {
      this.destroy();
      this.callbacks.onUnavailable(
        cause instanceof Error ? cause.message : "Renderer restoration failed",
      );
    }
  }
  private selectionChanged(
    world: World,
    level: number,
    tiles: readonly TileIndex[],
  ): void {
    const selection = createSelection(level, tiles);
    if (selection.key === world.selection.key) return;
    if (world === this.candidate) {
      world.selection = selection;
      this.hideCandidate();
    } else if (world === this.displayed) {
      world.loader.unpin(inspectionTiles(world.selection.tiles));
      world.selection = selection;
      world.loader.pin(inspectionTiles(selection.tiles));
      this.callbacks.onLevel(level);
      if (this.pointerClientPosition) this.refreshInspection(false);
      this.schedulePrefetch();
    } else return;
    this.clearStaleTileWarning();
  }
  private schedulePrefetch(): void {
    this.cancelPrefetch();
    const world = this.displayed;
    if (!world) return;
    const visible = world.selection.tiles;
    const visibleIds = new Set(visible.map(tileId));
    const tiles = ring(visible, world.snapshot.manifest.width).filter(
      (index) => !visibleIds.has(tileId(index)),
    );
    if (!tiles.length) return;
    const controller = new AbortController();
    this.prefetchController = controller;
    this.idleCallback = requestIdle(() => {
      this.idleCallback = 0;
      void world.loader
        .prefetch(tiles, controller.signal)
        .catch(() => undefined);
    });
  }
  private cancelPrefetch(): void {
    if (this.idleCallback) cancelIdle(this.idleCallback);
    this.idleCallback = 0;
    this.prefetchController?.abort();
    this.prefetchController = null;
  }
  private inspectScreen(
    screenX: number,
    screenY: number,
    announce: boolean,
  ): void {
    const world = this.displayed;
    if (!world) return this.callbacks.onInspect(null, false, null);
    const viewport = this.deck?.getViewports()[0];
    if (!(viewport instanceof OrthographicViewport)) return;
    const { manifest } = world.snapshot;
    const [worldX, worldY] = viewport.unproject([screenX, screenY]);
    const x = Math.floor(worldX!);
    const y = Math.floor(worldY!);
    if (x < 0 || x >= manifest.width || y < 0 || y >= manifest.height)
      return this.callbacks.onInspect(null, false, null);
    const mapped = worldToTile(x, y, world.selection.level, manifest.width);
    const cached = (index: TileIndex | null) =>
      index
        ? world.loader.cache.get(`${manifest.stateDigest}:${tileId(index)}`)
        : undefined;
    const data = cached(mapped.tile) ?? cached(parentIndex(mapped.tile));
    const inspection =
      data?.availability === "loaded"
        ? inspect(
            data.tile,
            x,
            y,
            data.index.z,
            manifest.generation,
            manifest.width,
          )
        : null;
    this.callbacks.onInspect(
      inspection,
      announce,
      inspection?.kind === "cell"
        ? projectCell(viewport, inspection.x, inspection.y)
        : null,
    );
  }

  private isCovered(world: World): boolean {
    return hasRequiredCoverage(
      world.selection.tiles,
      world.snapshot.manifest.stateDigest,
      (key) => this.renderReady.has(key),
    );
  }
  /** Reveals the candidate one frame after its coverage first renders. */
  private evaluateCoverage(): void {
    const candidate = this.candidate;
    if (!candidate || !this.deck) return;
    if (!this.isCovered(candidate)) return this.hideCandidate();
    if (this.coverageReadyFrame === null)
      this.coverageReadyFrame = this.renderFrame;
    else if (this.renderFrame > this.coverageReadyFrame && !candidate.visible) {
      candidate.visible = true;
      this.commitAfterFrame = this.renderFrame;
      this.updateLayers();
    }
  }
  private hideCandidate(): void {
    this.coverageReadyFrame = null;
    this.commitAfterFrame = null;
    if (!this.candidate?.visible) return;
    this.candidate.visible = false;
    this.updateLayers();
  }
  /** Transfers ownership once a frame has drawn the revealed candidate. */
  private commitCandidate(): void {
    const candidate = this.candidate;
    this.commitAfterFrame = null;
    if (!candidate) return;
    const identity = {
      epoch: candidate.epoch,
      digest: candidate.snapshot.manifest.stateDigest,
    };
    if (
      !this.isCovered(candidate) ||
      !this.callbacks.approveSnapshotCommit(candidate.snapshot, identity)
    )
      return this.hideCandidate();
    const previous = this.displayed;
    this.displayed = candidate;
    this.candidate = null;
    this.coverageReadyFrame = null;
    candidate.loader.pin(inspectionTiles(candidate.selection.tiles));
    this.callbacks.onLevel(candidate.selection.level);
    this.updateLayers();
    if (previous) this.closeWorld(previous);
    this.clearStaleTileWarning();
    this.schedulePrefetch();
    this.refreshInspection();
  }
  private resourceReady(key: string): void {
    this.renderReady.set(key, (this.renderReady.get(key) ?? 0) + 1);
    this.evaluateCoverage();
  }
  private resourceReleased(key: string): void {
    const owners = this.renderReady.get(key) ?? 0;
    if (owners <= 1) this.renderReady.delete(key);
    else this.renderReady.set(key, owners - 1);
    this.evaluateCoverage();
  }
  private afterRender(): void {
    this.renderFrame += 1;
    this.evaluateCoverage();
    if (
      this.commitAfterFrame !== null &&
      this.renderFrame > this.commitAfterFrame
    )
      this.commitCandidate();
  }
}

function createSelection(
  level: number,
  tiles: readonly TileIndex[],
): Selection {
  return {
    level,
    tiles: [...tiles],
    key: `${level}:${tiles.map(tileId).sort().join(",")}`,
  };
}

function sameCamera(left: Camera, right: Camera): boolean {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function projectCell(
  viewport: OrthographicViewport,
  x: number,
  y: number,
): CellHighlight {
  const first = viewport.project([x, y, 0]);
  const second = viewport.project([x + 1, y + 1, 0]);
  return {
    left: Math.min(first[0]!, second[0]!),
    top: Math.min(first[1]!, second[1]!),
    width: Math.abs(second[0]! - first[0]!),
    height: Math.abs(second[1]! - first[1]!),
  };
}

function inspectionTiles(tiles: readonly TileIndex[]): TileIndex[] {
  return [
    ...new Map(
      tiles
        .flatMap((index) => [index, parentIndex(index)])
        .filter((index): index is TileIndex => index !== null)
        .map((index) => [tileId(index), index]),
    ).values(),
  ];
}

function requestIdle(callback: () => void): number {
  if (typeof window.requestIdleCallback === "function")
    return window.requestIdleCallback(callback, { timeout: 500 });
  return window.setTimeout(callback, 100);
}

function cancelIdle(id: number): void {
  if (typeof window.cancelIdleCallback === "function")
    window.cancelIdleCallback(id);
  else clearTimeout(id);
}
