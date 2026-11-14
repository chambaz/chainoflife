import {
  Layer,
  project32,
  type LayerProps,
  type UpdateParameters,
} from "@deck.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import { quadPositions, sameBounds, type TileBounds } from "./pyramid";

interface Props extends LayerProps {
  readonly bounds: TileBounds;
  readonly onResourceError: (message: string) => void;
}
interface State {
  [key: string]: unknown;
  model: Model | undefined;
}

const vertex = `#version 300 es
in vec3 positions;
void main(void) {
  geometry.worldPosition = positions;
  gl_Position = project_position_to_clipspace(positions, vec3(0.), vec3(0.), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}`;
const fragment = `#version 300 es
precision highp float;
out vec4 fragColor;
void main(void) {
  float stripe = step(.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.));
  fragColor = vec4(mix(vec3(.10, .045, .035), vec3(.42, .16, .075), stripe), 1.);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`;

/** Draws a diagonal hatch where the indexer has no tile. */
export class UnavailableTileLayer extends Layer<Props> {
  declare state: State;
  static override layerName = "UnavailableTileLayer";
  override getModels(): Model[] {
    const model = this.state?.model;
    return model ? [model] : [];
  }
  override getShaders() {
    return super.getShaders({ vs: vertex, fs: fragment, modules: [project32] });
  }
  // Resources are created in updateState, which deck.gl also calls on
  // initialization with empty old props.
  override initializeState(): void {
    this.setState({ model: undefined });
  }
  override updateState({ oldProps }: UpdateParameters<this>): void {
    if (oldProps.bounds && sameBounds(oldProps.bounds, this.props.bounds))
      return;
    this.state.model?.destroy();
    this.createModel();
  }
  override finalizeState(): void {
    this.state.model?.destroy();
  }
  override draw(): void {
    this.state.model?.draw(this.context.renderPass);
  }
  private createModel(): void {
    try {
      const model = new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        isInstanced: false,
        geometry: new Geometry({
          topology: "triangle-strip",
          attributes: {
            positions: { size: 3, value: quadPositions(this.props.bounds) },
          },
        }),
      });
      this.setState({ model });
    } catch (cause) {
      this.setState({ model: undefined });
      this.props.onResourceError(
        cause instanceof Error ? cause.message : "GPU hatch allocation failed",
      );
    }
  }
}
