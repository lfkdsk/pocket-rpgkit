import { describe, expect, test } from "bun:test";
import {
  MAP_LIST_HEADER_H,
  MAP_LIST_ROW_H,
  hitMapListRow,
  mapListWindow,
  revealMapListRow,
} from "../editor/engine/map-list.ts";

describe("virtualized editor map list", () => {
  test("keeps the mounted row window bounded for 263 maps", () => {
    const first = mapListWindow(263, 224, 0);
    const middle = mapListWindow(263, 224, 2_700);
    const last = mapListWindow(263, 224, Number.MAX_SAFE_INTEGER);
    for (const windowed of [first, middle, last]) {
      expect(windowed.end - windowed.first).toBeLessThanOrEqual(14);
      expect(windowed.first).toBeGreaterThanOrEqual(0);
      expect(windowed.end).toBeLessThanOrEqual(263);
    }
    expect(first.first).toBe(0);
    expect(first.scroll).toBe(0);
    expect(last.end).toBe(263);
    expect(last.scroll).toBe(last.maxScroll);
  });

  test("hit testing accounts for scroll and rejects chrome", () => {
    expect(hitMapListRow(MAP_LIST_HEADER_H - 1, 263, 224, 220)).toBeNull();
    expect(hitMapListRow(MAP_LIST_HEADER_H + 1, 263, 224, 220)).toBe(10);
    expect(hitMapListRow(MAP_LIST_HEADER_H + MAP_LIST_ROW_H + 1, 263, 224, 220)).toBe(11);
    expect(hitMapListRow(223, 263, 224, 220)).toBeNull();
  });

  test("reveal scrolls only enough to keep the cursor visible", () => {
    expect(revealMapListRow(0, 263, 224, 0)).toBe(0);
    expect(revealMapListRow(20, 263, 224, 0)).toBe(272);
    expect(revealMapListRow(19, 263, 224, 272)).toBe(272);
    expect(revealMapListRow(2, 263, 224, 272)).toBe(44);
    const end = revealMapListRow(262, 263, 224, 0);
    expect(end).toBe(mapListWindow(263, 224, Infinity).maxScroll);
  });
});
