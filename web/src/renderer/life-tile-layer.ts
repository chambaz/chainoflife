import {
  Layer,
  project32,
  type LayerProps,
  type UpdateParameters,
} from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import { TILE_SIZE } from "@/indexer/schema";
import type { LoadedTileData } from "./tile-loader";
import {
  cellsPerTexel,
  quadPositions,
  sameBounds,
  tileSpan,
  type TileBounds,
} from "./pyramid";

interface Props extends LayerProps {
  worldSize: number;
  bounds: TileBounds;
  content: LoadedTileData;
  resourceKey: string;
  onResourceReady: (key: string) => void;
  onResourceReleased: (key: string) => void;
  onResourceError: (message: string) => void;
}
interface Resources {
  readonly model: Model;
  readonly texture: Texture;
}
interface State {
  [key: string]: unknown;
  resources: Resources | undefined;
}
const uniforms = {
  name: "life",
  fs: `uniform highp usampler2D integerTexture;
layout(std140) uniform lifeUniforms {
  vec2 tileOrigin;
  float cellsPerTexel;
  float exact;
  float devicePixelRatio;
  float worldSize;
} life;`,
  uniformTypes: {
    tileOrigin: "vec2<f32>",
    cellsPerTexel: "f32",
    exact: "f32",
    devicePixelRatio: "f32",
    worldSize: "f32",
  },
};
const vertex = `#version 300 es
in vec3 positions; in vec2 texCoords; out vec2 lifeUv;
void main(void) { geometry.worldPosition = positions; geometry.uv = texCoords; gl_Position = project_position_to_clipspace(positions, vec3(0.), vec3(0.), geometry.position); DECKGL_FILTER_GL_POSITION(gl_Position, geometry); lifeUv = texCoords; }`;
const fragment = `#version 300 es
precision highp float; precision highp usampler2D; in vec2 lifeUv; out vec4 fragColor;
void main(void) { vec2 cellUv = lifeUv * ${TILE_SIZE}.; ivec2 texel = clamp(ivec2(floor(cellUv)), ivec2(0), ivec2(${TILE_SIZE - 1})); vec2 cellMin = life.tileOrigin + vec2(texel) * life.cellsPerTexel; vec2 covered = max(min(vec2(life.worldSize) - cellMin, vec2(life.cellsPerTexel)), vec2(0.)); if (covered.x * covered.y <= 0.) discard; float value = float(texelFetch(integerTexture, texel, 0).r); float density = life.exact > .5 ? value : value / (covered.x * covered.y); vec3 dead = vec3(.025,.055,.051); vec3 live = vec3(.40,1.,.75); vec3 color = mix(dead, live, pow(density, .42)); float devicePixelsPerCell = 1. / max(fwidth(cellUv.x), fwidth(cellUv.y)); float cssPixelsPerCell = devicePixelsPerCell / max(life.devicePixelRatio, 1.); float gridWidth = min(.18, 1. / max(cssPixelsPerCell, 1.)); if (life.exact > .5 && cssPixelsPerCell >= 4. && min(fract(cellUv.x), fract(cellUv.y)) < gridWidth) color *= .42; fragColor = vec4(color, 1.); DECKGL_FILTER_COLOR(fragColor, geometry); }`;

/** Draws one decoded tile from an integer texture: exact cells or density samples. */
export class LifeTileTextureLayer extends Layer<Props> {
  declare state: State;
  static override layerName = "LifeTileTextureLayer";
  override getModels(): Model[] {
    const model = this.state?.resources?.model;
    return model ? [model] : [];
  }
  override getShaders() {
    return super.getShaders({
      vs: vertex,
      fs: fragment,
      modules: [project32, uniforms],
    });
  }
  // Resources are created in updateState, which deck.gl also calls on
  // initialization with empty old props.
  override initializeState(): void {
    this.setState({ resources: undefined });
  }
  override updateState({ oldProps }: UpdateParameters<this>): void {
    if (
      oldProps.content === this.props.content &&
      oldProps.bounds &&
      sameBounds(oldProps.bounds, this.props.bounds)
    )
      return;
    this.destroyResources();
    this.createResources();
  }
  override finalizeState(): void {
    this.destroyResources();
  }
  override draw(): void {
    const { model, texture } = this.state.resources ?? {};
    if (!model || !texture) return;
    const { index, tile } = this.props.content;
    const span = tileSpan(index.z);
    model.shaderInputs.setProps({
      life: {
        integerTexture: texture,
        tileOrigin: [index.x * span, index.y * span],
        cellsPerTexel: cellsPerTexel(index.z),
        exact: tile.kind === "cells" ? 1 : 0,
        devicePixelRatio: globalThis.devicePixelRatio || 1,
        worldSize: this.props.worldSize,
      },
    });
    model.draw(this.context.renderPass);
  }
  private createResources(): void {
    const { content, bounds } = this.props;
    const exact = content.tile.kind === "cells";
    let texture: Texture | undefined;
    try {
      texture = this.context.device.createTexture({
        width: TILE_SIZE,
        height: TILE_SIZE,
        format: exact ? "r8uint" : "r16uint",
        sampler: {
          minFilter: "nearest",
          magFilter: "nearest",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        },
      });
      texture.writeData(content.tile.values, {
        width: TILE_SIZE,
        height: TILE_SIZE,
        bytesPerRow: content.tile.values.BYTES_PER_ELEMENT * TILE_SIZE,
      });
      const span = tileSpan(content.index.z);
      const left = (bounds.left - content.index.x * span) / span;
      const top = (bounds.top - content.index.y * span) / span;
      const right = (bounds.right - content.index.x * span) / span;
      const bottom = (bounds.bottom - content.index.y * span) / span;
      const model = new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        isInstanced: false,
        geometry: new Geometry({
          topology: "triangle-strip",
          attributes: {
            positions: { size: 3, value: quadPositions(bounds) },
            texCoords: {
              size: 2,
              value: new Float32Array([
                left,
                top,
                right,
                top,
                left,
                bottom,
                right,
                bottom,
              ]),
            },
          },
        }),
      });
      this.setState({ resources: { texture, model } });
      this.props.onResourceReady(this.props.resourceKey);
    } catch (error) {
      texture?.destroy();
      this.setState({ resources: undefined });
      this.props.onResourceError(
        error instanceof Error ? error.message : "GPU tile allocation failed",
      );
    }
  }
  private destroyResources(): void {
    const resources = this.state.resources;
    if (!resources) return;
    this.state.resources = undefined;
    this.props.onResourceReleased(this.props.resourceKey);
    resources.model.destroy();
    resources.texture.destroy();
  }
}
