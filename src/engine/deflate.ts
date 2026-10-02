// src/engine/deflate.ts — raw DEFLATE (RFC 1951) compressor and
// decompressor, used to make save codes shorter.
//
// Written for every host the engine runs on, QuickJS included: no imports,
// no host APIs (no TextEncoder, Buffer, zlib), only typed arrays and Math.
// The compressor is deterministic, so the same bytes always give the same
// code. It follows zlib's level-6 recipe (hash chains, lazy matching, a
// per-block choice of stored / fixed / dynamic Huffman) and lands close to
// zlib's output size. The decompressor rejects anything a strict zlib
// inflate would reject, plus trailing bytes after the final block.

/** Thrown by `inflateRaw` for malformed, truncated or oversized streams. */
export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

// --- Shared tables -----------------------------------------------------------

const LEN_BASE: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DIST_BASE: readonly number[] = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: readonly number[] = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
/** Order in which code-length code lengths are transmitted. */
const CL_ORDER: readonly number[] = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

const MAX_BITS = 15;
const MAX_CL_BITS = 7;
const LIT_CODES = 286;
const DIST_CODES = 30;
const END_BLOCK = 256;

function fixedLitLengths(): Uint8Array {
  const lens = new Uint8Array(288);
  for (let i = 0; i < 288; i++) {
    lens[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  }
  return lens;
}

// --- Compressor --------------------------------------------------------------

const WINDOW_SIZE = 32768;
const WINDOW_MASK = 0x7fff; // WINDOW_SIZE - 1
// One short of the full window: the chain slot of a position exactly 32768
// back has just been overwritten by the current position.
const MAX_DIST = 0x7fff; // WINDOW_SIZE - 1
const HASH_SIZE = 0x8000;
const HASH_MASK = 0x7fff; // HASH_SIZE - 1
const MIN_MATCH = 3;
const MAX_MATCH = 258;
// zlib level 6 parameters.
const GOOD_LENGTH = 8;
const MAX_LAZY = 16;
const NICE_LENGTH = 128;
const MAX_CHAIN = 128;
/** A 3-byte match this far back costs more than three literals. */
const TOO_FAR = 4096;
/** Symbols per block; smaller blocks adapt their codes to local statistics. */
const BLOCK_SYMBOLS = 16384;
const STORED_MAX = 65535;

// Lookup tables are built on first use, not at module load: a bundle that
// imports the save module but never encodes a compressed code then drops
// this file entirely (top-level loops would keep it alive).
/** Length (3..258) -> length code index 0..28. */
let LEN_INDEX: Uint8Array;
/** Distance (1..32768) -> distance code 0..29. */
let DIST_INDEX: Uint8Array;
let FIXED_LIT_LENS: Uint8Array;
let FIXED_DIST_LENS: Uint8Array;
let FIXED_LIT_CODES: Uint16Array;
let FIXED_DIST_CODES: Uint16Array;
let tablesReady = false;

function initTables(): void {
  if (tablesReady) return;
  LEN_INDEX = new Uint8Array(MAX_MATCH + 1);
  DIST_INDEX = new Uint8Array(WINDOW_SIZE + 1);
  for (let c = 0; c < 29; c++) {
    const end = c === 28 ? MAX_MATCH + 1 : LEN_BASE[c + 1];
    for (let l = LEN_BASE[c]; l < end; l++) LEN_INDEX[l] = c;
  }
  LEN_INDEX[MAX_MATCH] = 28;
  for (let c = 0; c < DIST_CODES; c++) {
    const end = c === DIST_CODES - 1 ? WINDOW_SIZE + 1 : DIST_BASE[c + 1];
    for (let d = DIST_BASE[c]; d < end; d++) DIST_INDEX[d] = c;
  }
  FIXED_LIT_LENS = fixedLitLengths();
  FIXED_DIST_LENS = new Uint8Array(DIST_CODES).fill(5);
  FIXED_LIT_CODES = canonicalCodes(FIXED_LIT_LENS);
  FIXED_DIST_CODES = canonicalCodes(FIXED_DIST_LENS);
  tablesReady = true;
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

/** Canonical Huffman codes for `lens`, bit-reversed for LSB-first output. */
function canonicalCodes(lens: Uint8Array): Uint16Array {
  const count = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < lens.length; i++) count[lens[i]]++;
  count[0] = 0;
  const next = new Uint16Array(MAX_BITS + 2);
  let code = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code = (code + count[len - 1]) << 1;
    next[len] = code;
  }
  const codes = new Uint16Array(lens.length);
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i];
    if (len !== 0) codes[i] = reverseBits(next[len]++, len);
  }
  return codes;
}

/**
 * Length-limited Huffman code lengths for `freq`. Optimal lengths come from
 * the in-place Moffat-Katajainen method; if any exceed `maxBits` they are
 * clamped and the Kraft sum repaired by lengthening the deepest short codes.
 * Fewer than two used symbols get two length-1 codes, since a strict
 * inflate rejects incomplete codes.
 */
function buildLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] !== 0) syms.push(i);
  const m = syms.length;
  if (m < 2) {
    const s = m === 1 ? syms[0] : 0;
    lens[s] = 1;
    lens[s === 0 ? 1 : 0] = 1;
    return lens;
  }
  // Total order, so the result never depends on sort stability.
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const a = new Int32Array(m);
  for (let i = 0; i < m; i++) a[i] = freq[syms[i]];

  // Moffat-Katajainen: a[] (ascending weights) becomes code lengths.
  a[0] += a[1];
  let root = 0;
  let leaf = 2;
  for (let next = 1; next < m - 1; next++) {
    if (leaf >= m || a[root] < a[leaf]) {
      a[next] = a[root];
      a[root++] = next;
    } else {
      a[next] = a[leaf++];
    }
    if (leaf >= m || (root < next && a[root] < a[leaf])) {
      a[next] += a[root];
      a[root++] = next;
    } else {
      a[next] += a[leaf++];
    }
  }
  a[m - 2] = 0;
  for (let next = m - 3; next >= 0; next--) a[next] = a[a[next]] + 1;
  let avail = 1;
  let used = 0;
  let depth = 0;
  root = m - 2;
  let next = m - 1;
  while (avail > 0) {
    while (root >= 0 && a[root] === depth) {
      used++;
      root--;
    }
    while (avail > used) {
      a[next--] = depth;
      avail--;
    }
    avail = 2 * used;
    depth++;
    used = 0;
  }

  const numCodes = new Int32Array(maxBits + 1);
  for (let i = 0; i < m; i++) numCodes[a[i] > maxBits ? maxBits : a[i]]++;
  let total = 0;
  for (let i = maxBits; i > 0; i--) total += numCodes[i] << (maxBits - i);
  while (total !== 1 << maxBits) {
    numCodes[maxBits]--;
    for (let i = maxBits - 1; i > 0; i--) {
      if (numCodes[i] !== 0) {
        numCodes[i]--;
        numCodes[i + 1] += 2;
        break;
      }
    }
    total--;
  }
  // Most frequent symbols take the shortest codes.
  let j = m;
  for (let len = 1; len <= maxBits; len++) {
    for (let k = numCodes[len]; k > 0; k--) lens[syms[--j]] = len;
  }
  return lens;
}

class BitWriter {
  buf: Uint8Array;
  pos = 0;
  private bits = 0;
  private count = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  /** Bits written so far. */
  get bitLength(): number {
    return this.pos * 8 + this.count;
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + extra) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
  }

  /** Write the low `n` (<= 16) bits of `value`, LSB first. */
  write(value: number, n: number): void {
    this.bits |= value << this.count;
    this.count += n;
    if (this.count >= 8) {
      this.ensure(3);
      const buf = this.buf;
      while (this.count >= 8) {
        buf[this.pos++] = this.bits & 255;
        this.bits >>>= 8;
        this.count -= 8;
      }
    }
  }

  /** Pad with zero bits to a byte boundary. */
  align(): void {
    if (this.count > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.bits & 255;
    }
    this.bits = 0;
    this.count = 0;
  }

  bytes(src: Uint8Array, start: number, end: number): void {
    this.ensure(end - start);
    this.buf.set(src.subarray(start, end), this.pos);
    this.pos += end - start;
  }

  finish(): Uint8Array {
    this.align();
    return this.buf.slice(0, this.pos);
  }
}

/** Run-length coded code lengths (symbols 0..18 plus their extra values). */
interface ClRun {
  readonly syms: Uint8Array;
  readonly extras: Uint8Array;
  readonly length: number;
}

function runLengths(lens: Uint8Array): ClRun {
  const n = lens.length;
  const syms = new Uint8Array(n);
  const extras = new Uint8Array(n);
  let k = 0;
  let i = 0;
  while (i < n) {
    const l = lens[i];
    let run = 1;
    while (i + run < n && lens[i + run] === l) run++;
    i += run;
    if (l === 0) {
      while (run >= 11) {
        const r = run < 138 ? run : 138;
        syms[k] = 18;
        extras[k++] = r - 11;
        run -= r;
      }
      if (run >= 3) {
        syms[k] = 17;
        extras[k++] = run - 3;
        run = 0;
      }
    } else {
      syms[k++] = l;
      run--;
      while (run >= 3) {
        const r = run < 6 ? run : 6;
        syms[k] = 16;
        extras[k++] = r - 3;
        run -= r;
      }
    }
    while (run > 0) {
      syms[k++] = l;
      run--;
    }
  }
  return { syms, extras, length: k };
}

/** Accumulates one block of LZ77 symbols and writes it in its cheapest form. */
class BlockWriter {
  // Assigned in the constructor rather than as field initializers, which
  // bundlers treat as side effects and would keep in bundles that never
  // compress.
  private readonly lit: Uint16Array;
  private readonly dist: Uint16Array;
  private readonly litFreq: Uint32Array;
  private readonly distFreq: Uint32Array;
  private count = 0;

  constructor(
    private readonly out: BitWriter,
    private readonly input: Uint8Array,
  ) {
    this.lit = new Uint16Array(BLOCK_SYMBOLS);
    this.dist = new Uint16Array(BLOCK_SYMBOLS);
    this.litFreq = new Uint32Array(LIT_CODES);
    this.distFreq = new Uint32Array(DIST_CODES);
  }

  get full(): boolean {
    return this.count === BLOCK_SYMBOLS;
  }

  literal(byte: number): void {
    this.lit[this.count] = byte;
    this.dist[this.count++] = 0;
    this.litFreq[byte]++;
  }

  match(len: number, dist: number): void {
    this.lit[this.count] = len;
    this.dist[this.count++] = dist;
    this.litFreq[257 + LEN_INDEX[len]]++;
    this.distFreq[DIST_INDEX[dist]]++;
  }

  /** Emit the pending symbols, which encode input[start, end). */
  flush(start: number, end: number, final: boolean): void {
    const out = this.out;
    const litFreq = this.litFreq;
    const distFreq = this.distFreq;
    litFreq[END_BLOCK] = 1;

    let extraBits = 0;
    for (let c = 0; c < 29; c++) extraBits += litFreq[257 + c] * LEN_EXTRA[c];
    for (let c = 0; c < DIST_CODES; c++) extraBits += distFreq[c] * DIST_EXTRA[c];

    const litLens = buildLengths(litFreq, MAX_BITS);
    const distLens = buildLengths(distFreq, MAX_BITS);
    let hlit = LIT_CODES;
    while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
    let hdist = DIST_CODES;
    while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
    const all = new Uint8Array(hlit + hdist);
    all.set(litLens.subarray(0, hlit));
    all.set(distLens.subarray(0, hdist), hlit);
    const rle = runLengths(all);
    const clFreq = new Uint32Array(19);
    for (let i = 0; i < rle.length; i++) clFreq[rle.syms[i]]++;
    const clLens = buildLengths(clFreq, MAX_CL_BITS);
    let hclen = 19;
    while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;

    let dynamicBits = 3 + 14 + 3 * hclen + extraBits;
    dynamicBits += clFreq[16] * 2 + clFreq[17] * 3 + clFreq[18] * 7;
    for (let s = 0; s < 19; s++) dynamicBits += clFreq[s] * clLens[s];
    let fixedBits = 3 + extraBits;
    for (let s = 0; s < LIT_CODES; s++) {
      dynamicBits += litFreq[s] * litLens[s];
      fixedBits += litFreq[s] * FIXED_LIT_LENS[s];
    }
    for (let s = 0; s < DIST_CODES; s++) {
      dynamicBits += distFreq[s] * distLens[s];
      fixedBits += distFreq[s] * 5;
    }

    const size = end - start;
    const chunks = size === 0 ? 1 : Math.ceil(size / STORED_MAX);
    const firstPad = (8 - ((out.bitLength + 3) & 7)) & 7;
    const storedBits = firstPad + (chunks - 1) * 5 + chunks * 35 + size * 8;

    const bfinal = final ? 1 : 0;
    if (storedBits < fixedBits && storedBits < dynamicBits) {
      let pos = start;
      for (let c = 0; c < chunks; c++) {
        const len = Math.min(STORED_MAX, end - pos);
        out.write(c === chunks - 1 ? bfinal : 0, 3);
        out.align();
        out.write(len, 16);
        out.write(~len & 0xffff, 16);
        out.bytes(this.input, pos, pos + len);
        pos += len;
      }
    } else if (fixedBits <= dynamicBits) {
      out.write(bfinal | (1 << 1), 3);
      this.writeSymbols(FIXED_LIT_CODES, FIXED_LIT_LENS, FIXED_DIST_CODES, FIXED_DIST_LENS);
    } else {
      out.write(bfinal | (2 << 1), 3);
      out.write(hlit - 257, 5);
      out.write(hdist - 1, 5);
      out.write(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) out.write(clLens[CL_ORDER[i]], 3);
      const clCodes = canonicalCodes(clLens);
      for (let i = 0; i < rle.length; i++) {
        const s = rle.syms[i];
        out.write(clCodes[s], clLens[s]);
        if (s === 16) out.write(rle.extras[i], 2);
        else if (s === 17) out.write(rle.extras[i], 3);
        else if (s === 18) out.write(rle.extras[i], 7);
      }
      this.writeSymbols(canonicalCodes(litLens), litLens, canonicalCodes(distLens), distLens);
    }

    litFreq.fill(0);
    distFreq.fill(0);
    this.count = 0;
  }

  private writeSymbols(
    litCodes: Uint16Array,
    litLens: Uint8Array,
    distCodes: Uint16Array,
    distLens: Uint8Array,
  ): void {
    const out = this.out;
    const lit = this.lit;
    const dist = this.dist;
    for (let i = 0; i < this.count; i++) {
      const d = dist[i];
      if (d === 0) {
        const b = lit[i];
        out.write(litCodes[b], litLens[b]);
        continue;
      }
      const len = lit[i];
      const lc = LEN_INDEX[len];
      out.write(litCodes[257 + lc], litLens[257 + lc]);
      if (LEN_EXTRA[lc] !== 0) out.write(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = DIST_INDEX[d];
      out.write(distCodes[dc], distLens[dc]);
      if (DIST_EXTRA[dc] !== 0) out.write(d - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
    out.write(litCodes[END_BLOCK], litLens[END_BLOCK]);
  }
}

/** Raw DEFLATE (RFC 1951) of `input`. */
export function deflateRaw(input: Uint8Array): Uint8Array {
  initTables();
  const n = input.length;
  const out = new BitWriter(Math.max(64, (n >>> 1) + 64));
  const block = new BlockWriter(out, input);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW_SIZE);

  let blockStart = 0;
  let blockEnd = 0;
  let prevLen = MIN_MATCH - 1;
  let prevDist = 0;
  let pendingLiteral = false;
  let i = 0;

  while (i < n) {
    // Insert position i and fetch the previous position with the same hash.
    let chain = -1;
    if (i + 2 < n) {
      const h = ((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) & HASH_MASK;
      chain = head[h];
      prev[i & WINDOW_MASK] = chain;
      head[h] = i;
    }

    let curLen = MIN_MATCH - 1;
    let curDist = 0;
    if (chain >= 0 && prevLen < MAX_LAZY && i - chain <= MAX_DIST) {
      // Longest match search along the hash chain.
      const maxLen = n - i < MAX_MATCH ? n - i : MAX_MATCH;
      const nice = maxLen < NICE_LENGTH ? maxLen : NICE_LENGTH;
      const limit = i - MAX_DIST;
      let tries = prevLen >= GOOD_LENGTH ? MAX_CHAIN >> 2 : MAX_CHAIN;
      let best = prevLen;
      let cand = chain;
      while (cand >= limit && tries-- > 0) {
        if (
          input[cand + best] === input[i + best] &&
          input[cand] === input[i] &&
          input[cand + 1] === input[i + 1]
        ) {
          let len = 2;
          while (len < maxLen && input[cand + len] === input[i + len]) len++;
          if (len > best) {
            best = len;
            curLen = len;
            curDist = i - cand;
            if (len >= nice) break;
          }
        }
        const nextCand = prev[cand & WINDOW_MASK];
        if (nextCand >= cand) break;
        cand = nextCand;
      }
      if (curLen === MIN_MATCH && curDist > TOO_FAR) curLen = MIN_MATCH - 1;
    }

    if (prevLen >= MIN_MATCH && curLen <= prevLen) {
      // The match found at i - 1 wins: emit it and skip over it.
      block.match(prevLen, prevDist);
      blockEnd += prevLen;
      const stop = i - 1 + prevLen;
      for (let p = i + 1; p < stop; p++) {
        if (p + 2 < n) {
          const h = ((input[p] << 10) ^ (input[p + 1] << 5) ^ input[p + 2]) & HASH_MASK;
          prev[p & WINDOW_MASK] = head[h];
          head[h] = p;
        }
      }
      i = stop;
      pendingLiteral = false;
      prevLen = MIN_MATCH - 1;
    } else {
      if (pendingLiteral) {
        block.literal(input[i - 1]);
        blockEnd++;
      }
      pendingLiteral = true;
      prevLen = curLen;
      prevDist = curDist;
      i++;
    }
    if (block.full) {
      block.flush(blockStart, blockEnd, false);
      blockStart = blockEnd;
    }
  }
  if (pendingLiteral) {
    block.literal(input[n - 1]);
    blockEnd++;
  }
  block.flush(blockStart, blockEnd, true);
  return out.finish();
}

// --- Decompressor ------------------------------------------------------------

/** Codes up to this many bits decode with a single table lookup. */
const FAST_BITS = 10;
const FAST_MASK = 0x3ff; // (1 << FAST_BITS) - 1

/** Canonical Huffman decoding tables for one alphabet. */
interface Decoder {
  /** Entries `(symbol << 4) | length`; 0 means "take the slow path". */
  readonly fast: Int32Array;
  readonly count: Uint16Array;
  readonly symbols: Uint16Array;
}

/**
 * Build a decoder for `lens`. Over-subscribed sets are always rejected;
 * incomplete sets only pass as a lone length-1 code (or no codes at all)
 * for literal/length and distance alphabets, matching zlib.
 */
function buildDecoder(lens: Uint8Array, codeLengthAlphabet: boolean): Decoder {
  const n = lens.length;
  const count = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  let maxLen = 0;
  for (let len = 1; len <= MAX_BITS; len++) if (count[len] !== 0) maxLen = len;

  const fast = new Int32Array(1 << FAST_BITS);
  if (maxLen === 0) return { fast, count, symbols: new Uint16Array(0) };

  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left = (left << 1) - count[len];
    if (left < 0) throw new InflateError("over-subscribed code lengths");
  }
  if (left > 0 && (codeLengthAlphabet || maxLen !== 1)) {
    throw new InflateError("incomplete code lengths");
  }

  const offs = new Uint16Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len++) offs[len + 1] = offs[len] + count[len];
  const symbols = new Uint16Array(offs[MAX_BITS + 1]);
  for (let s = 0; s < n; s++) if (lens[s] !== 0) symbols[offs[lens[s]]++] = s;

  // Fill the fast table walking codes in canonical order.
  let code = 0;
  let k = 0;
  for (let len = 1; len <= FAST_BITS; len++) {
    for (let c = 0; c < count[len]; c++) {
      const entry = (symbols[k++] << 4) | len;
      for (let r = reverseBits(code++, len); r <= FAST_MASK; r += 1 << len) fast[r] = entry;
    }
    code <<= 1;
  }
  return { fast, count, symbols };
}

function fixedDecoders(): { lit: Decoder; dist: Decoder } {
  // 288 and 32 codes: symbols 286/287 and 30/31 exist but are invalid.
  initTables();
  return {
    lit: buildDecoder(FIXED_LIT_LENS, false),
    dist: buildDecoder(new Uint8Array(32).fill(5), false),
  };
}

let fixedCache: { lit: Decoder; dist: Decoder } | undefined;

class Inflater {
  private pos = 0;
  private bits = 0;
  private count = 0;
  out: Uint8Array;
  outPos = 0;

  constructor(
    private readonly input: Uint8Array,
    private readonly maxOutput: number,
  ) {
    this.out = new Uint8Array(Math.min(maxOutput, Math.max(1024, input.length * 4)));
  }

  private refill(): void {
    const input = this.input;
    while (this.count <= 24 && this.pos < input.length) {
      this.bits |= input[this.pos++] << this.count;
      this.count += 8;
    }
  }

  /** Read `n` (<= 16) bits. */
  bitsOf(n: number): number {
    if (this.count < n) {
      this.refill();
      if (this.count < n) throw new InflateError("unexpected end of stream");
    }
    const v = this.bits & ((1 << n) - 1);
    this.bits >>>= n;
    this.count -= n;
    return v;
  }

  decode(d: Decoder): number {
    if (this.count < MAX_BITS) this.refill();
    const entry = d.fast[this.bits & FAST_MASK];
    if (entry !== 0) {
      const len = entry & 15;
      if (len > this.count) throw new InflateError("unexpected end of stream");
      this.bits >>>= len;
      this.count -= len;
      return entry >>> 4;
    }
    // Slow path: canonical decode one bit at a time.
    const count = d.count;
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      if (len > this.count) throw new InflateError("unexpected end of stream");
      code |= (this.bits >>> (len - 1)) & 1;
      const c = count[len];
      if (code - first < c) {
        this.bits >>>= len;
        this.count -= len;
        return d.symbols[index + code - first];
      }
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new InflateError("invalid Huffman code");
  }

  private reserve(extra: number): void {
    const need = this.outPos + extra;
    if (need > this.maxOutput) throw new InflateError("output exceeds limit");
    if (need <= this.out.length) return;
    let cap = Math.max(1024, this.out.length * 2);
    while (cap < need) cap *= 2;
    if (cap > this.maxOutput) cap = this.maxOutput;
    const grown = new Uint8Array(cap);
    grown.set(this.out.subarray(0, this.outPos));
    this.out = grown;
  }

  stored(): void {
    // Drop to a byte boundary, then hand buffered whole bytes back.
    this.bitsOf(this.count & 7);
    const len = this.bitsOf(16);
    const nlen = this.bitsOf(16);
    if (len !== (~nlen & 0xffff)) throw new InflateError("stored block length mismatch");
    this.pos -= this.count >>> 3;
    this.bits = 0;
    this.count = 0;
    if (this.pos + len > this.input.length) throw new InflateError("unexpected end of stream");
    this.reserve(len);
    this.out.set(this.input.subarray(this.pos, this.pos + len), this.outPos);
    this.outPos += len;
    this.pos += len;
  }

  dynamicDecoders(): { lit: Decoder; dist: Decoder } {
    const hlit = this.bitsOf(5) + 257;
    const hdist = this.bitsOf(5) + 1;
    const hclen = this.bitsOf(4) + 4;
    if (hlit > LIT_CODES || hdist > DIST_CODES) {
      throw new InflateError("too many length or distance codes");
    }
    const clLens = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = this.bitsOf(3);
    const cl = buildDecoder(clLens, true);

    const lens = new Uint8Array(hlit + hdist);
    let i = 0;
    while (i < lens.length) {
      const sym = this.decode(cl);
      if (sym < 16) {
        lens[i++] = sym;
        continue;
      }
      let value = 0;
      let repeat: number;
      if (sym === 16) {
        if (i === 0) throw new InflateError("repeat with no previous length");
        value = lens[i - 1];
        repeat = 3 + this.bitsOf(2);
      } else if (sym === 17) {
        repeat = 3 + this.bitsOf(3);
      } else {
        repeat = 11 + this.bitsOf(7);
      }
      if (i + repeat > lens.length) throw new InflateError("code length repeat overflows");
      while (repeat-- > 0) lens[i++] = value;
    }
    if (lens[END_BLOCK] === 0) throw new InflateError("missing end-of-block code");
    return {
      lit: buildDecoder(lens.subarray(0, hlit), false),
      dist: buildDecoder(lens.subarray(hlit), false),
    };
  }

  codes(lit: Decoder, dist: Decoder): void {
    for (;;) {
      const sym = this.decode(lit);
      if (sym < 256) {
        if (this.outPos >= this.out.length) this.reserve(1);
        this.out[this.outPos++] = sym;
        continue;
      }
      if (sym === END_BLOCK) return;
      const lc = sym - 257;
      if (lc >= 29) throw new InflateError("invalid length code");
      const len = LEN_BASE[lc] + (LEN_EXTRA[lc] !== 0 ? this.bitsOf(LEN_EXTRA[lc]) : 0);
      const dc = this.decode(dist);
      if (dc >= DIST_CODES) throw new InflateError("invalid distance code");
      const d = DIST_BASE[dc] + (DIST_EXTRA[dc] !== 0 ? this.bitsOf(DIST_EXTRA[dc]) : 0);
      if (d > this.outPos) throw new InflateError("distance too far back");
      this.reserve(len);
      const out = this.out;
      let op = this.outPos;
      const end = op + len;
      while (op < end) {
        out[op] = out[op - d];
        op++;
      }
      this.outPos = end;
    }
  }

  run(): Uint8Array {
    let final = 0;
    while (final === 0) {
      final = this.bitsOf(1);
      const type = this.bitsOf(2);
      if (type === 0) {
        this.stored();
      } else if (type === 1) {
        fixedCache ??= fixedDecoders();
        this.codes(fixedCache.lit, fixedCache.dist);
      } else if (type === 2) {
        const { lit, dist } = this.dynamicDecoders();
        this.codes(lit, dist);
      } else {
        throw new InflateError("reserved block type");
      }
    }
    // Only the final byte's padding may remain.
    if (this.count >= 8 || this.pos < this.input.length) {
      throw new InflateError("trailing data after final block");
    }
    return this.out.slice(0, this.outPos);
  }
}

/**
 * Inflate raw DEFLATE. Throws InflateError on any malformed or truncated
 * stream, on trailing data past the final block other than < 8 padding
 * bits, or when output would exceed `maxOutput` bytes.
 */
export function inflateRaw(input: Uint8Array, maxOutput = 16 * 1024 * 1024): Uint8Array {
  return new Inflater(input, maxOutput).run();
}
