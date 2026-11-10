import { describe, expect, test } from "vitest";
import {
  clampCamera,
  fitCamera,
  fillCamera,
  parseCamera,
  serializeCamera,
  zoomAround,
} from "./camera";
describe("camera", () => {
  test("fits the complete world", () =>
    expect(fitCamera(1000, 500)).toEqual({
      x: 5000,
      y: 5000,
      zoom: Math.log2(0.05),
    }));
  test("clamps to real world bounds", () =>
    expect(clampCamera({ x: -5, y: 10050, zoom: 0 }, 512, 512)).toEqual({
      x: 256,
      y: 9744,
      zoom: 0,
    }));
  test("uses the clamped zoom when constraining the center", () =>
    expect(clampCamera({ x: 0, y: 0, zoom: 10 }, 512, 512)).toEqual({
      x: 4,
      y: 4,
      zoom: 6,
    }));
  test("preserves the world point under pointer zoom", () => {
    const camera = { x: 5000, y: 5000, zoom: -2 };
    const next = zoomAround(camera, -1, [700, 300], [800, 600]);
    expect(next).toEqual({ x: 5600, y: 5000, zoom: -1 });
  });
  test("round trips bounded URL state", () => {
    const camera = { x: 123.25, y: 9876.5, zoom: -2.5 };
    expect(parseCamera(serializeCamera(camera))).toEqual(camera);
  });
  test.each([
    "?x=-1&y=0&z=0",
    "?x=0&y=0&z=7",
    "?x=0&y=0&z=0&evil=1",
    "?x=x&y=0&z=0",
    "?x=0&y=0",
    "?x=0&x=1&y=0&z=0",
  ])("rejects unsafe query %s", (query) =>
    expect(parseCamera(query)).toBeNull(),
  );
  test.each([
    [1600, 900, 100],
    [400, 900, 7400],
    [3840, 2160, 100],
    [1200, 800, 10000],
  ])(
    "fills a %i by %i viewport with a %i-cell board",
    (width, height, size) => {
      const camera = fillCamera(width, height, size);
      expect(camera.x).toBe(size / 2);
      expect(camera.y).toBe(size / 2);
      expect(size * 2 ** camera.zoom).toBeCloseTo(Math.max(width, height));
    },
  );
});
