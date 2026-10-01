import { describe, expect, test } from "bun:test";
import { fitTextToWidth, wrapTextToWidth } from "../editor/engine/text-layout.ts";

const widths: Record<string, number> = { W: 9, i: 2, " ": 3, "…": 5 };
const measure = (text: string): number =>
  Array.from(text).reduce((sum, character) => sum + (widths[character] ?? 6), 0);

describe("editor pixel-measured text fitting", () => {
  test("fits proportional text by measured pixels, not character count", () => {
    expect(fitTextToWidth("Wiii Wide words", 45, measure)).toBe("Wiii…");
    expect(measure(fitTextToWidth("Wiii Wide words", 45, measure))).toBeLessThanOrEqual(45);
  });

  test("ellipsizes at a complete word boundary when one exists", () => {
    expect(fitTextToWidth("Make the path clearer", 70, measure)).toBe("Make the…");
  });

  test("falls back to code-point fitting for one overlong token", () => {
    const fitted = fitTextToWidth("WWWWWWWW", 32, measure);
    expect(fitted).toBe("WWW…");
    expect(measure(fitted)).toBeLessThanOrEqual(32);
  });

  test("wraps complete words and ellipsizes only the final visible line", () => {
    const lines = wrapTextToWidth("Make the path clearer and move the elder beside it", 78, 3, measure);
    expect(lines).toEqual(["Make the path", "clearer and", "move the…"]);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(78);
  });
});
