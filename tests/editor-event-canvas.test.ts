import { describe, expect, test } from "bun:test";
import {
  clampEventDestination,
  eventContainsCell,
  eventDragDestination,
  topmostEventAt,
  visibleEventRect,
  type CanvasEvent,
} from "../editor/engine/event-canvas.ts";

describe("editor event canvas geometry", () => {
  const area: CanvasEvent = { id: "area", x: 2, y: 3, w: 4, h: 2 };

  test("multi-cell events occupy their complete footprint", () => {
    expect(eventContainsCell(area, 2, 3)).toBe(true);
    expect(eventContainsCell(area, 5, 4)).toBe(true);
    expect(eventContainsCell(area, 6, 4)).toBe(false);
    expect(eventContainsCell(area, 5, 5)).toBe(false);

    // Omitted dimensions preserve the original one-cell marker behavior.
    const legacy = { id: "legacy", x: 8, y: 1 };
    expect(eventContainsCell(legacy, 8, 1)).toBe(true);
    expect(eventContainsCell(legacy, 9, 1)).toBe(false);
  });

  test("the last drawn overlapping event is the deterministic hit", () => {
    const events: CanvasEvent[] = [
      { id: "back", x: 0, y: 0, w: 4, h: 4 },
      { id: "middle", x: 2, y: 1, w: 3, h: 2 },
      { id: "front", x: 3, y: 2 },
    ];
    expect(topmostEventAt(events, 3, 2)?.id).toBe("front");
    expect(topmostEventAt(events, 2, 1)?.id).toBe("middle");
    expect(topmostEventAt(events, 0, 3)?.id).toBe("back");
    expect(topmostEventAt(events, 8, 8)).toBeNull();
  });

  test("visible rectangles clip at camera and map edges", () => {
    const viewport = { camX: 5, camY: 3, cols: 4, rows: 3, width: 8, height: 6 };

    // Origin is above/left of the camera, but the footprint enters the view.
    expect(visibleEventRect({ id: "wide", x: 3, y: 2, w: 5, h: 4 }, viewport)).toEqual({
      id: "wide",
      vx: 0,
      vy: 0,
      w: 3,
      h: 3,
    });
    // The camera extends past the map; the marker stops at the map boundary.
    expect(visibleEventRect({ id: "edge", x: 7, y: 5, w: 3, h: 3 }, viewport)).toEqual({
      id: "edge",
      vx: 2,
      vy: 2,
      w: 1,
      h: 1,
    });
    expect(visibleEventRect({ id: "hidden", x: 0, y: 0, w: 2, h: 2 }, viewport)).toBeNull();
  });

  test("destinations keep the complete event on-map", () => {
    const event: CanvasEvent = { id: "gate", x: 2, y: 2, w: 3, h: 2 };
    const map = { width: 8, height: 6 };
    expect(clampEventDestination(event, -4, 99, map)).toEqual({ x: 0, y: 4 });
    expect(clampEventDestination(event, 99, -3, map)).toEqual({ x: 5, y: 0 });

    // Dragging from a non-origin footprint cell retains that grab offset.
    expect(eventDragDestination(event, { x: 4, y: 3 }, { x: 7, y: 5 }, map)).toEqual({ x: 5, y: 4 });
    expect(eventDragDestination(event, { x: 4, y: 3 }, { x: 0, y: 0 }, map)).toEqual({ x: 0, y: 0 });
  });

  test("oversized event axes clamp to the only stable origin", () => {
    const event: CanvasEvent = { id: "oversized", x: 4, y: 3, w: 20, h: 2 };
    expect(clampEventDestination(event, 7, 7, { width: 8, height: 6 })).toEqual({ x: 0, y: 4 });
  });
});
