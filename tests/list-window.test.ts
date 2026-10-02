// tests/list-window.test.ts — the pure scroll-window, label-wrapping and
// marquee helpers behind T2-9 (>4 choices), the T2-10 shop box row list and
// the icon choices box (src/ui/list-window.ts). The rendered behaviour is
// ui-theme-sim.test.ts and choice-icon-render.test.ts.

import { describe, expect, test } from "bun:test";
import { isCjk } from "../src/engine/text-break.ts";
import {
  MARQUEE_HOLD,
  MARQUEE_TICKS_PER_PX,
  marqueeOffset,
  truncateLabel,
  windowByRows,
  windowStart,
  wrapLabel,
} from "../src/ui/list-window.ts";

/** Fake measurer: Latin (and the ellipsis) 6 px, CJK 12 px per code point. */
const measure = (text: string): number => {
  let w = 0;
  for (const ch of text) w += isCjk(ch.codePointAt(0)!) ? 12 : 6;
  return w;
};
const CJK = (cps: number[]): string => String.fromCodePoint(...cps);
// "勇者之剑" and a supplementary ideograph (U+20BB7), as code points so the
// test source stays ASCII.
const SWORD = CJK([0x52c7, 0x8005, 0x4e4b, 0x5251]);
const SUPP = CJK([0x20bb7]);

describe("windowStart", () => {
  test("a list no longer than the visible count never scrolls", () => {
    for (let total = 0; total <= 4; total++) {
      for (let index = 0; index < Math.max(1, total); index++) {
        expect(windowStart(index, total, 4)).toBe(0);
      }
    }
  });

  test("the cursor stays one row from the top while there is room above", () => {
    // 8 items, 4 visible: index 2 -> start 1 (index at window row 1).
    expect(windowStart(2, 8, 4)).toBe(1);
    expect(windowStart(3, 8, 4)).toBe(2);
    expect(windowStart(5, 8, 4)).toBe(4);
  });

  test("clamps at both ends: never negative, never past the last full window", () => {
    expect(windowStart(0, 8, 4)).toBe(0);
    expect(windowStart(1, 8, 4)).toBe(0);
    expect(windowStart(7, 8, 4)).toBe(4); // maxStart = 8 - 4
    expect(windowStart(6, 8, 4)).toBe(4);
  });

  test("the cursor is always inside [start, start+visible)", () => {
    for (let total = 1; total <= 20; total++) {
      for (let index = 0; index < total; index++) {
        const start = windowStart(index, total, 4);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThanOrEqual(Math.max(0, total - 4));
        expect(index).toBeGreaterThanOrEqual(start);
        expect(index).toBeLessThan(start + 4);
      }
    }
  });
});

describe("truncateLabel", () => {
  test("a label within budget is unchanged", () => {
    expect(truncateLabel("Iron Key", 24)).toBe("Iron Key");
    expect(truncateLabel("", 24)).toBe("");
    expect(truncateLabel("exactly24charactersxxxx", 24).length).toBeLessThanOrEqual(24);
  });

  test("a longer label truncates with a trailing ellipsis, within budget", () => {
    const long = "A label far too long to fit the choices box at all";
    const out = truncateLabel(long, 24);
    expect(out.length).toBe(24);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toBe(long.slice(0, 23));
  });

  test("a budget of 1 or less still returns at most that many characters", () => {
    expect(truncateLabel("hello", 1).length).toBeLessThanOrEqual(1);
    expect(truncateLabel("hello", 0).length).toBe(0);
  });
});

describe("truncateLabel code points", () => {
  test("never splits a supplementary character into a lone surrogate", () => {
    const label = SUPP.repeat(6);
    const out = truncateLabel(label, 4);
    expect(out).toBe(`${SUPP.repeat(3)}\u2026`);
    expect(truncateLabel(label, 6)).toBe(label);
    expect(truncateLabel(label, 1)).toBe(SUPP);
  });
});

describe("wrapLabel", () => {
  test("a label that fits is one row, unchanged", () => {
    for (const label of ["Iron Key", "", "Potion x3", SWORD, `HP ${SWORD}`]) {
      expect(wrapLabel(label, 200, measure)).toEqual([label]);
    }
    expect(wrapLabel(SWORD, 48, measure)).toEqual([SWORD]); // exactly the width
  });

  test("a Latin label too wide wraps at spaces; every row fits and the rows rebuild it", () => {
    const long = "A label far too long to fit the choices box at all";
    for (const width of [60, 90, 144, 200]) {
      const rows = wrapLabel(long, width, measure);
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(measure(row)).toBeLessThanOrEqual(width);
      // The break spaces hang off the row ends and are dropped.
      expect(rows.join(" ")).toBe(long);
      for (const row of rows) expect(row).not.toContain("…");
    }
  });

  test("a CJK label wraps between characters and loses none of them", () => {
    const label = SWORD.repeat(3); // 12 chars, 144 px
    const rows = wrapLabel(label, 60, measure);
    expect(rows).toEqual([SWORD + SWORD[0], SWORD.slice(1) + SWORD.slice(0, 2), SWORD.slice(2)]); // 5 + 5 + 2
    for (const row of rows) expect(measure(row)).toBeLessThanOrEqual(60);
    expect(rows.join("")).toBe(label);
  });

  test("kinsoku: no row starts with a fullwidth comma or full stop", () => {
    const COMMA = CJK([0xff0c]);
    const STOP = CJK([0x3002]);
    const label = `${SWORD}${COMMA}${SWORD}${STOP}${SWORD}${COMMA}${SWORD}${STOP}`;
    for (let width = 24; width <= 120; width += 12) {
      const rows = wrapLabel(label, width, measure);
      expect(rows.join("")).toBe(label);
      for (const row of rows.slice(1)) {
        expect(row.startsWith(COMMA), `width ${width}`).toBe(false);
        expect(row.startsWith(STOP), `width ${width}`).toBe(false);
      }
    }
  });

  test("a supplementary character is never split", () => {
    const rows = wrapLabel(SUPP.repeat(6), 36, measure);
    expect(rows).toEqual([SUPP.repeat(3), SUPP.repeat(3)]);
  });

  test("a NaN (or non-positive) width keeps one row", () => {
    expect(wrapLabel(SWORD.repeat(3), Number.NaN, measure)).toEqual([SWORD.repeat(3)]);
    expect(wrapLabel("A long label", 0, measure)).toEqual(["A long label"]);
  });
});

describe("windowByRows", () => {
  test("with every item one row tall it is exactly windowStart's window", () => {
    for (let total = 0; total <= 20; total++) {
      const rows = Array<number>(total).fill(1);
      for (let index = 0; index < Math.max(1, total); index++) {
        for (const maxItems of [1, 3, 4]) {
          const start = windowStart(index, total, maxItems);
          expect(windowByRows(index, rows, maxItems, 12)).toEqual({ start, end: Math.min(total, start + maxItems) });
        }
      }
    }
  });

  test("tall items narrow the window, the cursor's item stays and the rest fit", () => {
    const rows = [1, 3, 1, 3, 1, 3, 1, 3];
    for (let index = 0; index < rows.length; index++) {
      for (let maxRows = 3; maxRows <= 10; maxRows++) {
        const { start, end } = windowByRows(index, rows, 4, maxRows);
        expect(index).toBeGreaterThanOrEqual(start);
        expect(index).toBeLessThan(end);
        expect(end - start).toBeLessThanOrEqual(4);
        expect(end - start).toBeGreaterThanOrEqual(1);
        let used = 0;
        for (let i = start; i < end; i++) used += rows[i]!;
        expect(used, `index ${index} maxRows ${maxRows}`).toBeLessThanOrEqual(maxRows);
        // Never narrower than the four-item window shrunk around the cursor.
        const wide = windowStart(index, rows.length, 4);
        expect(start).toBeGreaterThanOrEqual(wide);
        expect(end).toBeLessThanOrEqual(wide + 4);
      }
    }
    // 4 + 3 + ... rows: items below the cursor go first.
    expect(windowByRows(1, [2, 3, 2, 2], 4, 7)).toEqual({ start: 0, end: 3 });
    expect(windowByRows(1, [2, 3, 2, 2], 4, 5)).toEqual({ start: 0, end: 2 });
    expect(windowByRows(1, [2, 3, 2, 2], 4, 4)).toEqual({ start: 1, end: 2 });
  });

  test("a cursor item taller than maxRows is still shown, alone", () => {
    expect(windowByRows(2, [1, 1, 9, 1, 1], 4, 4)).toEqual({ start: 2, end: 3 });
    expect(windowByRows(0, [9], 4, 1)).toEqual({ start: 0, end: 1 });
  });
});

describe("marqueeOffset", () => {
  const cycle = (overflow: number) => 2 * MARQUEE_HOLD + Math.ceil(overflow) * MARQUEE_TICKS_PER_PX;

  test("0 when nothing overflows", () => {
    for (const overflow of [0, -5, Number.NaN]) {
      for (const tick of [0, 1, 100, 12345]) expect(marqueeOffset(overflow, tick)).toBe(0);
    }
  });

  test("holds at the start, travels monotonically, holds at exactly ceil(overflow)", () => {
    for (const overflow of [1, 7.5, 40]) {
      const end = Math.ceil(overflow);
      for (let t = 0; t < MARQUEE_HOLD; t++) expect(marqueeOffset(overflow, t)).toBe(0);
      let prev = 0;
      for (let t = MARQUEE_HOLD; t < cycle(overflow); t++) {
        const x = marqueeOffset(overflow, t);
        expect(x).toBeGreaterThanOrEqual(prev);
        prev = x;
      }
      expect(prev).toBe(end);
      const tail = cycle(overflow) - MARQUEE_HOLD;
      for (let t = tail; t < cycle(overflow); t++) expect(marqueeOffset(overflow, t)).toBe(end);
    }
  });

  test("periodic in the tick, and never outside [0, overflow]", () => {
    for (const overflow of [1, 7.5, 40]) {
      const period = cycle(overflow);
      for (let t = -2 * period; t < 3 * period; t += 7) {
        const x = marqueeOffset(overflow, t);
        expect(x).toBe(marqueeOffset(overflow, t + period));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(Math.ceil(overflow));
        expect(Number.isInteger(x)).toBe(true);
      }
    }
  });
});
