import {
  CELLS_CONTENT_TYPE,
  DENSITY_CONTENT_TYPE,
  DENSITY_U8_CONTENT_TYPE,
  DENSITY_U8_MIN_ZOOM,
  MAX_ZOOM,
  TILE_SIZE,
} from "@/indexer/schema";
import type { DecodedTile } from "./inspection";

export const CELL_BYTES = (TILE_SIZE * TILE_SIZE) / 8;

/** The content type and exact length of every tile at zoom `z`. */
export function tileFormat(z: number): {
  readonly contentType: string;
  readonly byteLength: number;
} {
  if (z === MAX_ZOOM)
    return { contentType: CELLS_CONTENT_TYPE, byteLength: CELL_BYTES };
  return z >= DENSITY_U8_MIN_ZOOM
    ? {
        contentType: DENSITY_U8_CONTENT_TYPE,
        byteLength: TILE_SIZE * TILE_SIZE,
      }
    : {
        contentType: DENSITY_CONTENT_TYPE,
        byteLength: TILE_SIZE * TILE_SIZE * 2,
      };
}

export function decodeTile(
  bytes: ArrayBuffer,
  contentType: string,
  z: number,
): DecodedTile {
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM)
    throw new Error("invalid tile zoom");
  const format = tileFormat(z);
  if (z === MAX_ZOOM) {
    if (
      contentType !== format.contentType ||
      bytes.byteLength !== format.byteLength
    )
      throw new Error("invalid exact-cell tile response");
    const packed = new Uint8Array(bytes);
    const values = new Uint8Array(TILE_SIZE * TILE_SIZE);
    for (let y = 0; y < TILE_SIZE; y += 1)
      for (let x = 0; x < TILE_SIZE; x += 1)
        values[y * TILE_SIZE + x] =
          (packed[(y * TILE_SIZE + x) >> 3]! >> (x % 8)) & 1;
    return { kind: "cells", values };
  }
  if (
    contentType !== format.contentType ||
    bytes.byteLength !== format.byteLength
  )
    throw new Error("invalid density tile response");
  // Both widths decode to 16-bit counts, so the renderer handles every level alike.
  const source =
    format.byteLength === TILE_SIZE * TILE_SIZE ? new Uint8Array(bytes) : null;
  const view = new DataView(bytes);
  const values = new Uint16Array(TILE_SIZE * TILE_SIZE);
  const cellsPerTexel = 2 ** (MAX_ZOOM - z);
  const maximumDensity = cellsPerTexel * cellsPerTexel;
  for (let index = 0; index < values.length; index += 1) {
    const value = source ? source[index]! : view.getUint16(index * 2, true);
    if (value > maximumDensity)
      throw new Error("invalid density tile response");
    values[index] = value;
  }
  return { kind: "density", values };
}
