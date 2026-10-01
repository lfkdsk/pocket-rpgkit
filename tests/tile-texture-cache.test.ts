import { describe, expect, test } from "bun:test";
import {
  TileTextureCache,
  type TileImageSource,
} from "../src/ui/tile-texture-cache.ts";

const source = (name: string, size = 16): TileImageSource => ({
  kind: "tile",
  ref: `ui:tile.${name}#0`,
  sourceWidth: size,
  sourceHeight: size,
});

function fixture(options: { maxEntries?: number; maxBytes?: number; fail?: string } = {}) {
  const loads: string[] = [];
  const frees: number[] = [];
  let handle = 10;
  const cache = new TileTextureCache({
    maxEntries: options.maxEntries,
    maxBytes: options.maxBytes,
    load(key, index) {
      loads.push(`${key}#${index}`);
      return key === `ui:tile.${options.fail}` ? -1 : handle++;
    },
    free(value) {
      frees.push(value);
    },
  });
  return { cache, loads, frees };
}

describe("TileTextureCache", () => {
  test("shares one handle across pins and frees it once at scope end", () => {
    const { cache, loads, frees } = fixture();
    const art = source("battle/hero", 64);
    expect(cache.acquire(art)).toBe(10);
    expect(cache.acquire(art)).toBe(10);
    expect(loads).toEqual([art.ref]);
    expect(cache.stats()).toEqual({
      entries: 1,
      pinned: 1,
      bytes: 1024 + 64 * 64,
      loads: 1,
      hits: 1,
      frees: 0,
    });
    cache.release(art.ref);
    cache.release(art.ref);
    expect(cache.stats().pinned).toBe(0);
    cache.clear();
    cache.clear();
    expect(frees).toEqual([10]);
    expect(cache.stats()).toMatchObject({ entries: 0, pinned: 0, bytes: 0, frees: 1 });
  });

  test("evicts the least-recently-used unpinned texture with stable accounting", () => {
    const { cache, loads, frees } = fixture({ maxEntries: 2 });
    const a = source("a");
    const b = source("b");
    const c = source("c");
    expect(cache.acquire(a)).toBe(10);
    cache.release(a.ref);
    expect(cache.acquire(b)).toBe(11);
    cache.release(b.ref);
    expect(cache.acquire(a)).toBe(10); // hit makes a newer than b
    cache.release(a.ref);
    expect(cache.acquire(c)).toBe(12);
    expect(loads).toEqual([a.ref, b.ref, c.ref]);
    expect(frees).toEqual([11]);
    expect(cache.stats()).toMatchObject({ entries: 2, pinned: 1, loads: 3, hits: 1, frees: 1 });
  });

  test("never evicts pinned entries and fails before loading an oversized working set", () => {
    const { cache, loads, frees } = fixture({ maxEntries: 2 });
    const a = source("a");
    const b = source("b");
    const c = source("c");
    cache.acquire(a);
    cache.acquire(b);
    expect(() => cache.acquire(c)).toThrow(/pinned working set exceeds/);
    expect(loads).toEqual([a.ref, b.ref]);
    expect(frees).toEqual([]);
    cache.release(a.ref);
    expect(cache.acquire(c)).toBe(12);
    expect(frees).toEqual([10]);
  });

  test("enforces byte capacity and rejects malformed or missing textures", () => {
    const { cache, loads } = fixture({ maxBytes: 1024 + 16 * 16, fail: "missing" });
    expect(cache.acquire(source("small"))).toBe(10);
    cache.release(source("small").ref);
    expect(() => cache.acquire(source("large", 32))).toThrow(/above the .* cache limit/);
    expect(loads).toEqual([source("small").ref]);

    expect(() => cache.acquire({ ...source("bad"), ref: "ui:img.bad#0" })).toThrow(/invalid tile ref/);
    expect(() => cache.acquire({ ...source("bad"), ref: "ui:tile.bad" })).toThrow(/invalid tile ref/);
    expect(() => cache.acquire({ ...source("bad"), sourceWidth: 3 })).toThrow(/powers of two/);

    const missing = fixture({ fail: "missing" });
    expect(() => missing.cache.acquire(source("missing"))).toThrow(/failed to load/);
    expect(missing.cache.stats()).toMatchObject({ entries: 0, loads: 0, frees: 0 });
  });

  test("a scope clear tolerates later releases from a kept-alive subtree", () => {
    const { cache, frees } = fixture();
    const art = source("battle/enemy");
    cache.acquire(art);
    cache.clear();
    expect(() => cache.release(art.ref)).not.toThrow();
    expect(frees).toEqual([10]);
  });

  test("scope end waits for node borrowers, then can reopen cleanly", () => {
    const { cache, loads, frees } = fixture();
    const art = source("battle/hero");
    cache.acquire(art);
    cache.endScope();
    expect(frees).toEqual([]);
    expect(cache.stats()).toMatchObject({ entries: 1, pinned: 1 });
    expect(() => cache.acquire(source("late"))).toThrow(/after scope end/);

    cache.release(art.ref);
    expect(frees).toEqual([10]);
    expect(cache.stats()).toMatchObject({ entries: 0, pinned: 0 });

    cache.beginScope();
    expect(cache.acquire(art)).toBe(11);
    cache.release(art.ref);
    cache.endScope();
    expect(loads).toEqual([art.ref, art.ref]);
    expect(frees).toEqual([10, 11]);
  });

  test("rejects ambiguous decimal tile references", () => {
    const { cache } = fixture();
    for (const ref of ["ui:tile.foo#", "ui:tile.foo#00", "ui:tile.foo# 0", "ui:tile.foo#1e2", "ui:tile.#0"]) {
      expect(() => cache.acquire({ ...source("foo"), ref }), ref).toThrow(/invalid tile ref/);
    }
  });
});
