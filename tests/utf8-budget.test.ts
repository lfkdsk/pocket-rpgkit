// The UTF-8 byte counter behind the save and preview size budgets: it must
// agree with TextEncoder on every string, including unpaired surrogates, and
// it must stop reading a string soon after the running total passes the
// budget, so an oversized input costs work proportional to the budget.

import { describe, expect, test } from "bun:test";
import { utf8BytesWithin, utf8UnitBytes } from "../src/engine/utf8.ts";

const encoder = new TextEncoder();
const utf8Len = (s: string): number => encoder.encode(s).length;
const unitSum = (s: string): number => {
  let total = 0;
  for (let i = 0; i < s.length; i++) total += utf8UnitBytes(s, i);
  return total;
};

/** Code units that exercise every width and both surrogate halves. */
const UNITS = ["a", "\u007f", "\u0080", "é", "߿", "ࠀ", "中", "￿", "\ud800", "\udbff", "\udc00", "\udfff", "😀"];

/** Deterministic mixed strings (xorshift), so lone and paired surrogates
 *  meet each other and every other width. */
function mixedStrings(count: number, length: number): string[] {
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    let s = "";
    while (s.length < length) s += UNITS[next() % UNITS.length];
    out.push(s);
  }
  return out;
}

/** Number of charCodeAt calls made while running `fn`. */
function countCharCodeAt(fn: () => void): number {
  const original = String.prototype.charCodeAt;
  let calls = 0;
  String.prototype.charCodeAt = function (this: string, i: number): number {
    calls++;
    return original.call(this, i);
  };
  try {
    fn();
  } finally {
    String.prototype.charCodeAt = original;
  }
  return calls;
}

describe("UTF-8 byte budget", () => {
  const cases = [
    "",
    "plain ascii",
    "\ud800",
    "\udc00",
    "\ud800\ud800",
    "\udc00\ud800",
    "\ud800中",
    "\ud800a",
    "a\udc00",
    "😀",
    "😀\udc00",
    "\ud800😀",
    "􏿿",
    ...mixedStrings(200, 24),
  ];

  test("per-unit costs add up to the TextEncoder length", () => {
    for (const s of cases) expect(unitSum(s)).toBe(utf8Len(s));
  });

  test("every limit around the length gets the exact verdict", () => {
    for (const s of cases) {
      const len = utf8Len(s);
      for (let limit = 0; limit <= len * 3 + 2; limit++) {
        expect(utf8BytesWithin(s, limit)).toBe(len <= limit);
      }
    }
  });

  test("a lone surrogate costs three bytes and leaves its neighbour alone", () => {
    expect(utf8BytesWithin("\ud800中", 6)).toBe(true);
    expect(utf8BytesWithin("\ud800中", 5)).toBe(false);
    expect(utf8BytesWithin("中\udc00", 5)).toBe(false);
    // A pair costs four bytes, not two lone threes.
    expect(utf8BytesWithin("😀😀", 8)).toBe(true);
    expect(utf8BytesWithin("😀😀", 7)).toBe(false);
  });

  test("the scan reads a bounded prefix of an oversized string", () => {
    // Each unit costs at least one byte and reads at most two code units,
    // so a budget of `limit` bytes is decided within 2 * (limit + 1) reads.
    for (const s of mixedStrings(40, 4_000)) {
      for (const limit of [0, 1, 7, 64, 500, 1_337]) {
        const calls = countCharCodeAt(() => utf8BytesWithin(s, limit));
        expect(calls).toBeLessThanOrEqual(2 * (limit + 1));
      }
    }
    // Far past the budget: decided from the length alone.
    expect(countCharCodeAt(() => utf8BytesWithin("中".repeat(100_000), 64))).toBe(0);
    // Far inside it: every unit is at most three bytes.
    expect(countCharCodeAt(() => utf8BytesWithin("中".repeat(100), 300))).toBe(0);
    // Between the two, the scan stops just past the budget.
    expect(countCharCodeAt(() => utf8BytesWithin("中".repeat(100_000), 200_000))).toBe(66_667);
  });
});
