import { describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import { deflateRaw, inflateRaw, InflateError } from "../src/engine/deflate.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

/** JSON-like save text: repeated keys, varied numbers and names. */
function jsonText(entries: number, seed: number): Uint8Array<ArrayBuffer> {
  const rnd = mulberry32(seed);
  const names = ["Bulbasaur", "Rockitten", "Tumbleworm", "Nut", "Aardart", "Fruitera"];
  const flags: Record<string, boolean> = {};
  for (let i = 0; i < entries / 4; i++) flags[`flag_${Math.floor(rnd() * 1000)}`] = rnd() < 0.5;
  const save = {
    version: 3,
    player: { name: "Ash", x: 12, y: 40, map: "route_1", facing: "down" },
    party: Array.from({ length: entries }, (_, i) => ({
      id: i,
      species: names[Math.floor(rnd() * names.length)],
      level: 1 + Math.floor(rnd() * 99),
      hp: Math.floor(rnd() * 300),
      moves: ["tackle", "growl", rnd() < 0.5 ? "ember" : "bubble"],
      stats: { atk: Math.floor(rnd() * 200), def: Math.floor(rnd() * 200), spd: Math.floor(rnd() * 200) },
    })),
    flags,
  };
  return new TextEncoder().encode(JSON.stringify(save));
}

const json20k = (() => {
  let n = 50;
  let text = jsonText(n, 7);
  while (text.length < 20_000) text = jsonText((n += 10), 7);
  return text;
})();

const inputs: ReadonlyArray<readonly [string, Uint8Array<ArrayBuffer>]> = [
  ["empty", new Uint8Array(0)],
  ["one byte", new Uint8Array([42])],
  ["all byte values", Uint8Array.from({ length: 256 }, (_, i) => i)],
  ["100 KB random", randomBytes(100 * 1024, 1234)],
  ["1 MB of a", new Uint8Array(1024 * 1024).fill(97)],
  ["20 KB JSON", json20k],
  ["large JSON", jsonText(4000, 99)],
];

function expectInflateError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(InflateError);
}

describe("deflateRaw / inflateRaw round trip", () => {
  for (const [name, data] of inputs) {
    test(name, () => {
      const packed = deflateRaw(data);
      expect(inflateRaw(packed)).toEqual(data);
    });
  }
});

describe("zlib interop", () => {
  for (const [name, data] of inputs) {
    test(`zlib inflates ours: ${name}`, () => {
      expect(new Uint8Array(Bun.inflateSync(new Uint8Array(deflateRaw(data))))).toEqual(data);
      expect(new Uint8Array(zlib.inflateRawSync(deflateRaw(data)))).toEqual(data);
    });
    test(`we inflate zlib: ${name}`, () => {
      for (const level of [0, 1, 6, 9]) {
        const packed = new Uint8Array(zlib.deflateRawSync(data, { level }));
        expect(inflateRaw(packed)).toEqual(data);
      }
    });
  }

  test("fixed Huffman and stored blocks from zlib", () => {
    for (const [, data] of inputs) {
      const fixed = new Uint8Array(
        zlib.deflateRawSync(data, { level: 6, strategy: zlib.constants.Z_FIXED }),
      );
      expect(inflateRaw(fixed)).toEqual(data);
      const stored = new Uint8Array(zlib.deflateRawSync(data, { level: 0 }));
      expect(inflateRaw(stored)).toEqual(data);
    }
  });

  test("single distance code and literal-only blocks", () => {
    // One repeated pattern (one distance code) and unique bytes (no matches).
    const one = new TextEncoder().encode("abcabcabcabcabcabcabcabcxyz".repeat(3));
    expect(new Uint8Array(zlib.inflateRawSync(deflateRaw(one)))).toEqual(one);
    const few = randomBytes(40, 5);
    expect(new Uint8Array(zlib.inflateRawSync(deflateRaw(few)))).toEqual(few);
  });
});

describe("inflateRaw errors", () => {
  test("truncated streams throw", () => {
    for (const [, data] of inputs) {
      const packed = deflateRaw(data);
      const cuts = [0, 1, packed.length >> 2, packed.length >> 1, packed.length - 1];
      for (const cut of cuts) {
        if (cut >= packed.length) continue;
        expectInflateError(() => inflateRaw(packed.subarray(0, cut)));
      }
    }
    const stored = new Uint8Array(zlib.deflateRawSync(json20k, { level: 0 }));
    expectInflateError(() => inflateRaw(stored.subarray(0, 100)));
  });

  test("reserved block type throws", () => {
    expectInflateError(() => inflateRaw(new Uint8Array([0x07, 0x00])));
  });

  test("stored LEN/NLEN mismatch throws", () => {
    expectInflateError(() => inflateRaw(new Uint8Array([0x01, 0x01, 0x00, 0xff, 0xff, 0x41])));
  });

  test("distance too far back throws", () => {
    // Fixed block: length 3 (code 257, 7 bits) with distance 1 as the first symbol.
    const w = { bytes: [] as number[], acc: 0, n: 0 };
    const put = (v: number, bits: number) => {
      w.acc |= v << w.n;
      w.n += bits;
      while (w.n >= 8) {
        w.bytes.push(w.acc & 255);
        w.acc >>>= 8;
        w.n -= 8;
      }
    };
    const rev = (c: number, l: number) => {
      let r = 0;
      for (let i = 0; i < l; i++) r = (r << 1) | ((c >> i) & 1);
      return r;
    };
    put(1, 1);
    put(1, 2);
    put(rev(1, 7), 7);
    put(rev(0, 5), 5);
    put(rev(0, 7), 7);
    if (w.n > 0) w.bytes.push(w.acc & 255);
    expectInflateError(() => inflateRaw(new Uint8Array(w.bytes)));
  });

  test("trailing data throws", () => {
    const packed = deflateRaw(json20k);
    const extra = new Uint8Array(packed.length + 1);
    extra.set(packed);
    expectInflateError(() => inflateRaw(extra));
  });

  test("corrupt bytes throw InflateError or change the output", () => {
    for (const data of [json20k, randomBytes(3000, 77)]) {
      const packed = deflateRaw(data);
      const rnd = mulberry32(31);
      for (let k = 0; k < 300; k++) {
        const bad = packed.slice();
        const at = Math.floor(rnd() * bad.length);
        bad[at] ^= 1 + Math.floor(rnd() * 255);
        let out: Uint8Array | undefined;
        try {
          out = inflateRaw(bad);
        } catch (e) {
          expect(e).toBeInstanceOf(InflateError);
          continue;
        }
        expect(out).not.toEqual(data);
      }
    }
  });

  test("maxOutput exceeded throws", () => {
    const data = new Uint8Array(100_000).fill(1);
    const packed = deflateRaw(data);
    expectInflateError(() => inflateRaw(packed, 99_999));
    expect(inflateRaw(packed, 100_000)).toEqual(data);
    expectInflateError(() => inflateRaw(deflateRaw(new Uint8Array([1])), 0));
    const stored = new Uint8Array(zlib.deflateRawSync(data, { level: 0 }));
    expectInflateError(() => inflateRaw(stored, 1000));
  });
});

describe("compression quality", () => {
  test("within 10% of zlib level 6 on JSON", () => {
    const ours = deflateRaw(json20k).length;
    const theirs = zlib.deflateRawSync(json20k, { level: 6 }).length;
    expect(ours).toBeLessThanOrEqual(Math.ceil(theirs * 1.1));
  });

  test("empty input is the minimal fixed block", () => {
    expect(Array.from(deflateRaw(new Uint8Array(0)))).toEqual([0x03, 0x00]);
  });

  test("deterministic", () => {
    for (const [, data] of inputs) expect(deflateRaw(data)).toEqual(deflateRaw(data));
  });
});
