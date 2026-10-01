// src/ui/tile-texture-cache.ts — host-backed, reference-counted TILESET LRU.

import {
  freeTileTexture,
  loadTileTexture,
} from "../../vendor/pocketjs/framework/src/tiles.ts";

export interface TileImageSource {
  kind: "tile";
  /** Full `ui:tile.*#<index>` reference. Single-image cookers emit #0. */
  ref: string;
  /** Source texture dimensions, used for deterministic cache accounting. */
  sourceWidth: number;
  sourceHeight: number;
}

/** Strings use the existing eager ui:img registration path unchanged. */
export type RpgImageSource = string | TileImageSource;

export interface TileTextureCacheOptions {
  /** Maximum cached handles, including pinned handles. Defaults to 32. */
  maxEntries?: number;
  /** Maximum CLUT/index backing bytes. Defaults to 4 MiB. */
  maxBytes?: number;
  /** Test/host override; production defaults to PocketJS loadTileTexture. */
  load?: (key: string, index: number) => number;
  /** Test/host override; production defaults to PocketJS freeTileTexture. */
  free?: (handle: number) => void;
}

export interface TileTextureCacheStats {
  entries: number;
  pinned: number;
  bytes: number;
  loads: number;
  hits: number;
  frees: number;
}

interface CacheEntry {
  handle: number;
  width: number;
  height: number;
  bytes: number;
  pins: number;
  used: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`TileTextureCache: ${label} must be a positive integer`);
  return value;
}

function parseTileRef(ref: string): { key: string; index: number } {
  const match = /^(ui:tile\.[^#]+)#(0|[1-9]\d*)$/.exec(ref);
  const key = match?.[1] ?? "";
  const index = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(index)) {
    throw new Error(`TileTextureCache: invalid tile ref ${JSON.stringify(ref)}`);
  }
  return { key, index };
}

function textureBytes(width: number, height: number): number {
  const pixels = width * height;
  return 1024 + ((pixels + 15) & ~15);
}

/** Reference-counted pins over a deterministic, bounded unpinned LRU. */
export class TileTextureCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly loadTexture: (key: string, index: number) => number;
  private readonly freeTexture: (handle: number) => void;
  private clock = 0;
  private totalBytes = 0;
  private loads = 0;
  private hits = 0;
  private frees = 0;
  private scopeEnded = false;

  constructor(options: TileTextureCacheOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 32, "maxEntries");
    this.maxBytes = positiveInteger(options.maxBytes ?? 4 * 1024 * 1024, "maxBytes");
    this.loadTexture = options.load ?? loadTileTexture;
    this.freeTexture = options.free ?? freeTileTexture;
  }

  private evict(ref: string, entry: CacheEntry): void {
    this.entries.delete(ref);
    this.totalBytes -= entry.bytes;
    this.freeTexture(entry.handle);
    this.frees++;
  }

  private victim(): [string, CacheEntry] | undefined {
    let best: [string, CacheEntry] | undefined;
    for (const row of this.entries) {
      if (row[1].pins > 0) continue;
      if (!best || row[1].used < best[1].used || row[1].used === best[1].used && row[0] < best[0]) best = row;
    }
    return best;
  }

  private makeRoom(bytes: number): void {
    if (bytes > this.maxBytes) {
      throw new Error(
        `TileTextureCache: texture needs ${bytes} bytes, above the ${this.maxBytes}-byte cache limit`,
      );
    }
    while (this.entries.size + 1 > this.maxEntries || this.totalBytes + bytes > this.maxBytes) {
      const victim = this.victim();
      if (!victim) {
        throw new Error(
          `TileTextureCache: pinned working set exceeds ${this.maxEntries} entries / ${this.maxBytes} bytes`,
        );
      }
      this.evict(victim[0], victim[1]);
    }
  }

  /** Pin a texture for one mounted borrower and return its native handle. */
  acquire(source: Readonly<TileImageSource>): number {
    if (this.scopeEnded) throw new Error("TileTextureCache: cannot acquire after scope end");
    const width = positiveInteger(source.sourceWidth, "source width");
    const height = positiveInteger(source.sourceHeight, "source height");
    if (width > 512 || height > 512 || (width & (width - 1)) !== 0 || (height & (height - 1)) !== 0) {
      throw new Error(`TileTextureCache: source dimensions must be powers of two <= 512, got ${width}x${height}`);
    }
    const found = this.entries.get(source.ref);
    if (found) {
      if (found.width !== width || found.height !== height) {
        throw new Error(`TileTextureCache: conflicting dimensions for ${JSON.stringify(source.ref)}`);
      }
      found.pins++;
      found.used = ++this.clock;
      this.hits++;
      return found.handle;
    }
    const bytes = textureBytes(width, height);
    const parsed = parseTileRef(source.ref);
    this.makeRoom(bytes);
    const handle = this.loadTexture(parsed.key, parsed.index);
    if (!Number.isInteger(handle) || handle < 0) {
      throw new Error(`TileTextureCache: failed to load ${JSON.stringify(source.ref)}`);
    }
    this.entries.set(source.ref, {
      handle,
      width,
      height,
      bytes,
      pins: 1,
      used: ++this.clock,
    });
    this.totalBytes += bytes;
    this.loads++;
    return handle;
  }

  /** Release one borrow. The texture stays warm until LRU pressure or clear. */
  release(ref: string): void {
    const entry = this.entries.get(ref);
    if (!entry) return; // clear() may have ended a persistent battle subtree.
    if (entry.pins < 1) throw new Error(`TileTextureCache: unbalanced release for ${JSON.stringify(ref)}`);
    entry.pins--;
    entry.used = ++this.clock;
    if (entry.pins === 0 && this.scopeEnded) this.evict(ref, entry);
  }

  /** Open (or reopen) a resource scope before borrowers become active. */
  beginScope(): void {
    this.scopeEnded = false;
  }

  /** End a resource scope without invalidating handles still bound to nodes.
   * Warm entries are freed now; pinned entries are freed by their final
   * release, after LazyImage has detached the node. */
  endScope(): void {
    this.scopeEnded = true;
    for (const [ref, entry] of this.entries) {
      if (entry.pins === 0) this.evict(ref, entry);
    }
  }

  /** Force-free every handle. Only call after all image nodes are detached. */
  clear(): void {
    for (const [ref, entry] of this.entries) this.evict(ref, entry);
  }

  stats(): TileTextureCacheStats {
    let pinned = 0;
    for (const entry of this.entries.values()) if (entry.pins > 0) pinned++;
    return {
      entries: this.entries.size,
      pinned,
      bytes: this.totalBytes,
      loads: this.loads,
      hits: this.hits,
      frees: this.frees,
    };
  }
}
