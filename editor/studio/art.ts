/// <reference lib="dom" />
// editor/studio/art.ts — tile sheet and character art for the canvas.
//
// A project names its sheets and sprites by id; the pixels live outside the
// document. A project folder (or a pack that carries art) brings its own
// PNGs, found by the conventions in project-art.ts; bundled examples ship
// their art beside the page. The user may also pick a local PNG per id
// through the host (LocalArt): it is decoded here only, never uploaded or
// stored. Ids without art draw a hatched, id-coloured placeholder so the map
// stays readable.

import type { SpriteDef } from "../../src/engine/types.ts";
import type { LocalArt } from "./host.ts";

export const TILE = 16;

export type ArtSource = "project" | "bundled" | "local" | "missing" | "loading" | "broken";

interface ArtEntry {
  image: CanvasImageSource | null;
  source: ArtSource;
  width: number;
  height: number;
  /** File name for local picks, URL for bundled art. */
  from?: string;
  /** The host's handle on a local pick, released when replaced. */
  local?: LocalArt;
}

function hue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

export class ArtRegistry {
  private sheets = new Map<string, ArtEntry>();
  private sprites = new Map<string, ArtEntry>();
  private placeholders = new Map<string, HTMLCanvasElement>();
  private listeners = new Set<() => void>();
  /** Bumped whenever any image finishes loading or is replaced. */
  revision = 0;

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private release(entry: ArtEntry | undefined): void {
    entry?.local?.release();
  }

  clear(): void {
    for (const entry of [...this.sheets.values(), ...this.sprites.values()]) this.release(entry);
    this.sheets.clear();
    this.sprites.clear();
    this.changed();
  }

  private load(table: Map<string, ArtEntry>, id: string, url: string, source: "project" | "bundled" | "local", from: string, local?: LocalArt): Promise<void> {
    this.release(table.get(id));
    const keep = local ? { local } : {};
    table.set(id, { image: null, source: "loading", width: 0, height: 0, from, ...keep });
    this.changed();
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        // Ignore a load that a newer pick replaced meanwhile.
        if (table.get(id)?.from === from) {
          table.set(id, { image, source, width: image.naturalWidth, height: image.naturalHeight, from, ...keep });
          this.changed();
        }
        resolve();
      };
      image.onerror = () => {
        if (table.get(id)?.from === from) {
          table.set(id, { image: null, source: "broken", width: 0, height: 0, from, ...keep });
          this.changed();
        }
        resolve();
      };
      image.src = url;
    });
  }

  loadBundledSheet(id: string, url: string): Promise<void> {
    return this.load(this.sheets, id, url, "bundled", url);
  }

  loadBundledSprite(id: string, url: string): Promise<void> {
    return this.load(this.sprites, id, url, "bundled", url);
  }

  /** The project's own PNG for a sheet id; `path` is the path the project
   * names it by, `url` something drawable (a data: URL of the pack asset). */
  loadProjectSheet(id: string, path: string, url: string): Promise<void> {
    return this.load(this.sheets, id, url, "project", path);
  }

  loadProjectSprite(id: string, path: string, url: string): Promise<void> {
    return this.load(this.sprites, id, url, "project", path);
  }

  /** The decoded RGBA pixels of a sheet's or sprite's art, for the
   * play-test; null when it has none or it is bundled example art (the
   * game already has that). */
  pixels(kind: "sheet" | "sprite", id: string): { width: number; height: number; rgba: Uint8Array } | null {
    const entry = (kind === "sheet" ? this.sheets : this.sprites).get(id);
    if (!entry?.image || (entry.source !== "project" && entry.source !== "local") || !entry.width || !entry.height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(entry.image, 0, 0);
    const data = ctx.getImageData(0, 0, entry.width, entry.height).data;
    return { width: entry.width, height: entry.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  }

  /** Use a local PNG (picked through the host) for a sheet id. */
  setLocalSheet(id: string, art: LocalArt): Promise<void> {
    return this.load(this.sheets, id, art.url, "local", `${art.name}#${Date.now()}`, art);
  }

  setLocalSprite(id: string, art: LocalArt): Promise<void> {
    return this.load(this.sprites, id, art.url, "local", `${art.name}#${Date.now()}`, art);
  }

  sheetStatus(id: string): { source: ArtSource; from?: string; width: number; height: number } {
    const entry = this.sheets.get(id);
    return entry ? { source: entry.source, ...(entry.from ? { from: entry.from.replace(/#\d+$/, "") } : {}), width: entry.width, height: entry.height } : { source: "missing", width: 0, height: 0 };
  }

  spriteStatus(id: string): { source: ArtSource; from?: string } {
    const entry = this.sprites.get(id);
    return entry ? { source: entry.source, ...(entry.from ? { from: entry.from.replace(/#\d+$/, "") } : {}) } : { source: "missing" };
  }

  /** The loaded sheet image, or null when it must be drawn as a placeholder. */
  sheetImage(id: string): CanvasImageSource | null {
    return this.sheets.get(id)?.image ?? null;
  }

  /** A per-sheet placeholder atlas: every cell hatched in the sheet's hue
   * with its cell number, so different tiles stay distinguishable. */
  placeholderSheet(id: string, cols: number, rows: number): HTMLCanvasElement {
    const key = `${id}:${cols}x${rows}`;
    const cached = this.placeholders.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = cols * TILE;
    canvas.height = rows * TILE;
    const ctx = canvas.getContext("2d")!;
    const base = hue(id);
    for (let cell = 0; cell < cols * rows; cell++) {
      const x = (cell % cols) * TILE;
      const y = Math.floor(cell / cols) * TILE;
      const light = 34 + (cell * 7) % 30;
      ctx.fillStyle = `hsl(${base} 45% ${light}%)`;
      ctx.fillRect(x, y, TILE, TILE);
      ctx.strokeStyle = `hsl(${base} 60% ${light + 18}%)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let d = -TILE; d < TILE; d += 6) {
        ctx.moveTo(x + d, y + TILE);
        ctx.lineTo(x + d + TILE, y);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, TILE, TILE);
      ctx.clip();
      ctx.beginPath();
      for (let d = -TILE; d < TILE; d += 6) {
        ctx.moveTo(x + d, y + TILE);
        ctx.lineTo(x + d + TILE, y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "7px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(cell), x + TILE / 2, y + TILE / 2 + 0.5);
    }
    this.placeholders.set(key, canvas);
    return canvas;
  }

  /** Image to draw for a sprite id, cropped to its idle-down frame. */
  spriteFrame(id: string, def: SpriteDef | undefined): { image: CanvasImageSource; sx: number; sy: number; sw: number; sh: number } | null {
    const entry = this.sprites.get(id);
    if (!entry?.image) return null;
    if (def?.kind === "walker" && "sheet" in def) {
      const cols = def.cols ?? 3;
      const rows = def.rows ?? 4;
      const sw = Math.floor(entry.width / cols);
      const sh = Math.floor(entry.height / rows);
      return { image: entry.image, sx: sw * Math.min(1, cols - 1), sy: 0, sw, sh };
    }
    return { image: entry.image, sx: 0, sy: 0, sw: entry.width, sh: entry.height };
  }
}

/** Split "sheet.cell" into its parts (sheet ids may contain dots). */
export function parseTileId(tile: string): { sheet: string; cell: number } | null {
  const dot = tile.lastIndexOf(".");
  if (dot <= 0) return null;
  const cell = Number(tile.slice(dot + 1));
  return Number.isInteger(cell) && cell >= 0 ? { sheet: tile.slice(0, dot), cell } : null;
}
