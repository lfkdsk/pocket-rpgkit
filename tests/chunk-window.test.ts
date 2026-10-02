import { describe, expect, test } from "bun:test";
import {
  chunkWindow,
  chunkWindowContains,
  createChunkWindowReader,
  expandChunkWindow,
} from "../src/engine/chunk-window.ts";

describe("chunkWindow", () => {
  test("a layer reader follows in-place camera, viewport and grid changes", () => {
    const read = createChunkWindowReader();
    const camera = { x: 0, y: 0 };
    const viewport = { w: 480, h: 272 };
    for (const size of [16, 256]) for (const columns of [0, 4, 80]) for (const rows of [0, 3, 60]) {
      for (const margin of [0, 16, 256]) for (const x of [-500, 0, 15, 16, 255, 256, 800]) {
        camera.x = x;
        camera.y = x / 2;
        for (const width of [0, 1, 480, 960]) {
          viewport.w = width;
          viewport.h = width / 2;
          const expected = chunkWindow(camera, viewport, size, columns, rows, margin);
          const actual = read(camera, viewport, size, columns, rows, margin);
          expect(actual).toEqual(expected);
          expect(read(camera, viewport, size, columns, rows, margin)).toBe(actual);
        }
      }
    }
    expect(() => read(camera, viewport, 0, 4, 3)).toThrow("invalid grid");
    expect(read(camera, viewport, 16, 4, 3)).toEqual(chunkWindow(camera, viewport, 16, 4, 3));
  });

  test("maps a 480x272 viewport plus 16px margin onto an inclusive 256px grid", () => {
    expect(chunkWindow({ x: 0, y: 0 }, { w: 480, h: 272 }, 256, 4, 3, 16)).toEqual({
      x0: 0, y0: 0, x1: 1, y1: 1,
    });
    expect(chunkWindow({ x: 216, y: 32 }, { w: 480, h: 272 }, 256, 4, 3, 16)).toEqual({
      x0: 0, y0: 0, x1: 2, y1: 1,
    });
  });

  test("reuses a supplied window until integer chunk boundaries change", () => {
    const viewport = { w: 480, h: 272 };
    const first = chunkWindow({ x: 0, y: 0 }, viewport, 256, 4, 3, 16);
    const within = chunkWindow({ x: 1, y: 1 }, viewport, 256, 4, 3, 16, first);
    expect(within).toBe(first);

    const crossed = chunkWindow({ x: 17, y: 1 }, viewport, 256, 4, 3, 16, first);
    expect(crossed).not.toBe(first);
    expect(crossed).toEqual({ x0: 0, y0: 0, x1: 2, y1: 1 });

    const read = createChunkWindowReader();
    const readFirst = read({ x: 0, y: 0 }, viewport, 256, 4, 3, 16);
    expect(read({ x: 1, y: 1 }, viewport, 256, 4, 3, 16)).toBe(readFirst);
  });

  test("uses half-open viewport edges and clamps at the world boundary", () => {
    expect(chunkWindow({ x: 256, y: 256 }, { w: 256, h: 256 }, 256, 4, 3)).toEqual({
      x0: 1, y0: 1, x1: 1, y1: 1,
    });
    expect(chunkWindow({ x: 900, y: 600 }, { w: 480, h: 272 }, 256, 4, 3)).toEqual({
      x0: 3, y0: 2, x1: 3, y1: 2,
    });
  });

  test("returns a canonical empty window outside the grid or for an empty viewport", () => {
    expect(chunkWindow({ x: -800, y: 0 }, { w: 100, h: 100 }, 256, 4, 3)).toEqual({ x0: 0, y0: 0, x1: -1, y1: -1 });
    expect(chunkWindow({ x: 0, y: 0 }, { w: 0, h: 100 }, 256, 4, 3)).toEqual({ x0: 0, y0: 0, x1: -1, y1: -1 });
  });

  test("expands a retention window by one chunk without leaving the grid", () => {
    const load = { x0: 1, y0: 1, x1: 2, y1: 1 };
    const keep = expandChunkWindow(load, 1, 4, 3);
    expect(keep).toEqual({ x0: 0, y0: 0, x1: 3, y1: 2 });
    expect(chunkWindowContains(keep, 0, 2)).toBe(true);
    expect(chunkWindowContains(keep, 4, 2)).toBe(false);
  });
});
