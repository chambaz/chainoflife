import { describe, expect, test } from "vitest";
import {
  CELLS_CONTENT_TYPE,
  DENSITY_CONTENT_TYPE,
  DENSITY_U8_CONTENT_TYPE,
} from "@/indexer/schema";
import { CELL_BYTES, decodeTile, tileFormat } from "./decode";
import { inspect } from "./inspection";

const DENSITY_BYTES = tileFormat(0).byteLength;

/** A density tile at zoom `z` whose first texel holds `value`. */
function densityTile(z: number, value: number): ArrayBuffer {
  const { byteLength } = tileFormat(z);
  const bytes = new ArrayBuffer(byteLength);
  if (byteLength === DENSITY_BYTES)
    new DataView(bytes).setUint16(0, value, true);
  else new Uint8Array(bytes)[0] = value;
  return bytes;
}
describe("tile decoding and inspection", () => {
  test("decodes unsigned little-endian density exactly", () => {
    const bytes = new ArrayBuffer(DENSITY_BYTES);
    const view = new DataView(bytes);
    view.setUint16(2, 513, true);
    const tile = decodeTile(bytes, DENSITY_CONTENT_TYPE, 0);
    expect(tile.kind).toBe("density");
    if (tile.kind === "density") expect(tile.values[1]).toBe(513);
  });
  test.each([
    [0, 2 * 65_536, DENSITY_CONTENT_TYPE],
    [2, 2 * 65_536, DENSITY_CONTENT_TYPE],
    [3, 65_536, DENSITY_U8_CONTENT_TYPE],
    [5, 65_536, DENSITY_U8_CONTENT_TYPE],
    [6, CELL_BYTES, CELLS_CONTENT_TYPE],
  ])("zoom %i tiles have %i bytes of %s", (z, byteLength, contentType) =>
    expect(tileFormat(z)).toEqual({ byteLength, contentType }),
  );
  test("decodes one-byte density exactly", () => {
    const bytes = new ArrayBuffer(tileFormat(3).byteLength);
    new Uint8Array(bytes)[1] = 64;
    const tile = decodeTile(bytes, DENSITY_U8_CONTENT_TYPE, 3);
    expect(tile.kind).toBe("density");
    if (tile.kind === "density") expect(tile.values[1]).toBe(64);
  });
  test.each([
    [0, 4_096],
    [2, 256],
    [3, 64],
    [5, 4],
  ])("accepts the maximum density at zoom %i", (z, maximum) =>
    expect(() =>
      decodeTile(densityTile(z, maximum), tileFormat(z).contentType, z),
    ).not.toThrow(),
  );
  test.each([
    [0, 4_097],
    [3, 65],
    [5, 5],
  ])("rejects impossible density at zoom %i", (z, density) =>
    expect(() =>
      decodeTile(densityTile(z, density), tileFormat(z).contentType, z),
    ).toThrow("invalid density tile response"),
  );
  test("decodes exact LSB-first bits", () => {
    const bytes = new ArrayBuffer(CELL_BYTES);
    new Uint8Array(bytes)[0] = 0b10000001;
    const tile = decodeTile(bytes, CELLS_CONTENT_TYPE, 6);
    expect(tile.kind).toBe("cells");
    if (tile.kind === "cells") {
      expect(tile.values.slice(0, 8)).toEqual(
        new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1]),
      );
      expect(inspect(tile, 0, 0, 6, "12", 10_000)).toMatchObject({
        kind: "cell",
        alive: true,
      });
      expect(inspect(tile, 1, 0, 6, "12", 10_000)).toMatchObject({
        kind: "cell",
        alive: false,
      });
    }
  });
  test("reports exact covered count at a partial edge", () => {
    const tile = { kind: "density" as const, values: new Uint16Array(65536) };
    tile.values[156 * 256 + 156] = 9;
    expect(inspect(tile, 9999, 9999, 0, "12", 10_000)).toMatchObject({
      kind: "density",
      x: 9984,
      y: 9984,
      width: 16,
      height: 16,
      live: 9,
      covered: 256,
    });
  });
  test.each([
    [new ArrayBuffer(1), DENSITY_CONTENT_TYPE, 0],
    [new ArrayBuffer(DENSITY_BYTES), CELLS_CONTENT_TYPE, 0],
    [new ArrayBuffer(CELL_BYTES), DENSITY_CONTENT_TYPE, 6],
    [new ArrayBuffer(DENSITY_BYTES), DENSITY_U8_CONTENT_TYPE, 5],
    [new ArrayBuffer(65_536), DENSITY_CONTENT_TYPE, 5],
    [new ArrayBuffer(65_536), DENSITY_U8_CONTENT_TYPE, 2],
  ] as const)("rejects wrong length or type", (bytes, type, z) =>
    expect(() => decodeTile(bytes, type, z)).toThrow(),
  );
  test.each([-1, 0.5, 7, Number.NaN])("rejects invalid zoom %s", (z) =>
    expect(() =>
      decodeTile(new ArrayBuffer(DENSITY_BYTES), DENSITY_CONTENT_TYPE, z),
    ).toThrow("invalid tile zoom"),
  );
});
