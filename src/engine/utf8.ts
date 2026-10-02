// src/engine/utf8.ts — UTF-8 byte counting for size budgets.
//
// Shared by the save decoder (src/engine/save.ts) and the preview protocol
// (tools/preview/protocol.ts), so both budgets count the same bytes.

/** UTF-8 bytes attributed to code unit `i` of `s`. A high surrogate followed
 *  by a low surrogate is one 4-byte scalar, counted as 2 bytes on each unit;
 *  a lone surrogate (a high not followed by a low, or a low not preceded by
 *  a high) counts as 3 bytes, the size of the U+FFFD that TextEncoder and
 *  the postMessage wire write for it, and does not pair with its neighbour.
 *  Summed over a string this is exactly its encoded length, and every unit
 *  costs at least one byte. */
export function utf8UnitBytes(s: string, i: number): number {
  const code = s.charCodeAt(i);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    return next >= 0xdc00 && next <= 0xdfff ? 2 : 3;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    return prev >= 0xd800 && prev <= 0xdbff ? 2 : 3;
  }
  return 3;
}

/** Whether `s` encodes to at most `limit` UTF-8 bytes. A unit costs one to
 *  three bytes, so lengths outside [limit / 3, limit] decide without a scan;
 *  otherwise the scan stops as soon as the running total passes the limit,
 *  so an oversized string costs work proportional to the limit, not to the
 *  string. */
export function utf8BytesWithin(s: string, limit: number): boolean {
  if (s.length > limit) return false;
  if (s.length * 3 <= limit) return true;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    total += utf8UnitBytes(s, i);
    if (total > limit) return false;
  }
  return true;
}
