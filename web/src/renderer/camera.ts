import { MAX_WORLD_SIZE } from "@/indexer/schema";

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}
export const MIN_CAMERA_ZOOM = -6;
export const MAX_CAMERA_ZOOM = 6;
export function clampCamera(
  camera: Camera,
  width: number,
  height: number,
  worldSize: number,
): Camera {
  const zoom = clamp(camera.zoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
  const scale = 2 ** zoom;
  const visibleWidth = width / scale;
  const visibleHeight = height / scale;
  return {
    x: clampAxis(camera.x, visibleWidth, worldSize),
    y: clampAxis(camera.y, visibleHeight, worldSize),
    zoom,
  };
}
export function fitCamera(
  width: number,
  height: number,
  worldSize: number,
): Camera {
  return {
    x: worldSize / 2,
    y: worldSize / 2,
    zoom: clamp(
      Math.log2(Math.min(width, height) / worldSize),
      MIN_CAMERA_ZOOM,
      MAX_CAMERA_ZOOM,
    ),
  };
}
export function fillCamera(
  width: number,
  height: number,
  worldSize: number,
): Camera {
  return {
    x: worldSize / 2,
    y: worldSize / 2,
    zoom: clamp(
      Math.log2(Math.max(width, height) / worldSize),
      MIN_CAMERA_ZOOM,
      MAX_CAMERA_ZOOM,
    ),
  };
}
/** Parses a shared camera; the world size is unknown here, so it bounds against the maximum. */
export function parseCamera(search: string): Camera | null {
  const query = new URLSearchParams(search);
  const keys = [...query.keys()];
  if (
    keys.length !== 3 ||
    !["x", "y", "z"].every((key) => query.getAll(key).length === 1) ||
    keys.some((key) => !["x", "y", "z"].includes(key))
  )
    return null;
  const values = [query.get("x"), query.get("y"), query.get("z")].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, zoom] = values as [number, number, number];
  if (
    x < 0 ||
    x > MAX_WORLD_SIZE ||
    y < 0 ||
    y > MAX_WORLD_SIZE ||
    zoom < MIN_CAMERA_ZOOM ||
    zoom > MAX_CAMERA_ZOOM
  )
    return null;
  return { x, y, zoom };
}
export function serializeCamera(camera: Camera): string {
  const query = new URLSearchParams({
    x: camera.x.toFixed(2),
    y: camera.y.toFixed(2),
    z: camera.zoom.toFixed(3),
  });
  return `?${query}`;
}
function clampAxis(value: number, visible: number, worldSize: number): number {
  if (visible >= worldSize) return worldSize / 2;
  return clamp(value, visible / 2, worldSize - visible / 2);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
