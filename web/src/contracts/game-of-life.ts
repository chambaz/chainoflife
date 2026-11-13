export {
  GameOfLife,
  decodeEvent,
  type GameOfLifeEvent,
} from "./generated/game-of-life";
import { game_of_life } from "./generated/game-of-life";

export const { GenerationAdvanced, TickRequested, WorldInitialized } =
  game_of_life.v0_1.types;
