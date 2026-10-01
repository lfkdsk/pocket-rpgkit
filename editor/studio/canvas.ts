/// <reference lib="dom" />
// editor/studio/canvas.ts — the map view: cached layer bitmaps, zoom/pan,
// overlays and the pointer tools.
//
// Ground and upper layers are cached as native-resolution (16 px per cell)
// offscreen canvases and rebuilt only when the document, map or art changes.
// A frame is then two scaled drawImage calls plus overlays clipped to the
// visible cells, so zoom and pan cost the same on a 100×100 map as on a
// small one. A brush stroke previews by painting straight into the cached
// bitmap; on release the whole stroke is committed as one protocol
// operation and the cache is rebuilt from the resulting document.

import type { GameEvent, MapDef, Sheet, TileId } from "../../src/engine/types.ts";
import { uniqueEventId } from "../engine/model.ts";
import type { StudioApp } from "./app.ts";
import { ArtRegistry, TILE, parseTileId } from "./art.ts";

export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;

interface Theme {
  backdrop: string;
  void: string;
  grid: string;
  gridMajor: string;
  accent: string;
  select: string;
  event: string;
  eventFill: string;
  hover: string;
}

type Drag =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "paint"; erase: boolean; cells: Map<number, true>; last: { x: number; y: number } }
  | { kind: "rect"; erase: boolean; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: "move"; eventId: string; grabDX: number; grabDY: number; at: { x: number; y: number }; moved: boolean };

export interface FrameStats {
  frames: number;
  /** Recent frame durations in ms (draw call only). */
  recent: number[];
}

export class MapCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ground: HTMLCanvasElement = document.createElement("canvas");
  private upper: HTMLCanvasElement = document.createElement("canvas");
  private cacheKey = "";
  private cacheRevision = "";
  /** Tile drawn in each cell of the cached bitmaps (undefined = not drawn). */
  private drawnGround: (TileId | null | undefined)[] = [];
  private drawnUpper: (TileId | null | undefined)[] = [];
  private drag: Drag | null = null;
  private spaceHeld = false;
  private pending = false;
  private theme!: Theme;
  private cssWidth = 1;
  private cssHeight = 1;
  readonly stats: FrameStats = { frames: 0, recent: [] };
  /** Duration of the last full layer rebuild in ms. */
  lastRebuildMs = 0;
  /** Cells redrawn by the last cache update. */
  lastRebuildCells = 0;

  constructor(private host: HTMLElement, private app: StudioApp, private art: ArtRegistry) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "map-canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Map canvas");
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.readTheme();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bindPointer();
    app.on((reason) => {
      if (reason === "load" || reason === "map") this.fit();
      this.requestDraw();
    });
    art.onChange(() => this.requestDraw());
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !isTyping(event)) {
        this.spaceHeld = true;
        this.canvas.classList.add("panning");
        if (event.target === this.canvas || event.target === document.body) event.preventDefault();
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        this.spaceHeld = false;
        this.canvas.classList.remove("panning");
      }
    });
  }

  readTheme(): void {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.theme = {
      backdrop: v("--canvas-bg", "#15171c"),
      void: v("--canvas-void", "#0c0d10"),
      grid: v("--canvas-grid", "rgba(255,255,255,0.10)"),
      gridMajor: v("--canvas-grid-major", "rgba(255,255,255,0.22)"),
      accent: v("--accent", "#6c8cff"),
      select: v("--canvas-select", "#ffd166"),
      event: v("--canvas-event", "#7ce0c3"),
      eventFill: v("--canvas-event-fill", "rgba(124,224,195,0.18)"),
      hover: v("--canvas-hover", "rgba(255,255,255,0.35)"),
    };
    this.requestDraw();
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.cssWidth = Math.max(1, Math.floor(rect.width));
    this.cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.requestDraw();
  }

  // ---- view -------------------------------------------------------------------

  /** Center the map at the largest preset zoom that fits. */
  fit(): void {
    const map = this.app.currentMap();
    if (!map) return;
    const fitZoom = Math.min((this.cssWidth - 48) / (map.width * TILE), (this.cssHeight - 48) / (map.height * TILE));
    const zoom = [...ZOOM_LEVELS].reverse().find((level) => level <= fitZoom) ?? ZOOM_LEVELS[0];
    this.setZoom(zoom, this.cssWidth / 2, this.cssHeight / 2, true);
  }

  setZoom(zoom: number, anchorX = this.cssWidth / 2, anchorY = this.cssHeight / 2, center = false): void {
    const view = this.app.view;
    const map = this.app.currentMap();
    if (center && map) {
      view.zoom = zoom;
      view.panX = (map.width * TILE) / 2 - this.cssWidth / 2 / zoom;
      view.panY = (map.height * TILE) / 2 - this.cssHeight / 2 / zoom;
    } else {
      const mx = view.panX + anchorX / view.zoom;
      const my = view.panY + anchorY / view.zoom;
      view.zoom = zoom;
      view.panX = mx - anchorX / zoom;
      view.panY = my - anchorY / zoom;
    }
    this.app.emit("view");
  }

  zoomStep(direction: 1 | -1, anchorX?: number, anchorY?: number): void {
    const current = this.app.view.zoom;
    const next = direction > 0
      ? ZOOM_LEVELS.find((level) => level > current + 1e-6)
      : [...ZOOM_LEVELS].reverse().find((level) => level < current - 1e-6);
    if (next !== undefined) this.setZoom(next, anchorX, anchorY);
  }

  /** Viewport-relative CSS pixel of a cell's center (for tests and popovers). */
  cellToClient(x: number, y: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.app.view;
    return {
      x: rect.left + ((x + 0.5) * TILE - view.panX) * view.zoom,
      y: rect.top + ((y + 0.5) * TILE - view.panY) * view.zoom,
    };
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number; inside: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.app.view;
    const mx = view.panX + (clientX - rect.left) / view.zoom;
    const my = view.panY + (clientY - rect.top) / view.zoom;
    const x = Math.floor(mx / TILE);
    const y = Math.floor(my / TILE);
    const map = this.app.currentMap();
    const inside = !!map && x >= 0 && y >= 0 && x < map.width && y < map.height;
    return { x, y, inside };
  }

  // ---- layer cache ------------------------------------------------------------

  private sheetFor(id: string): Sheet | undefined {
    return this.app.session?.sheets().find((sheet) => sheet.id === id);
  }

  private drawTile(ctx: CanvasRenderingContext2D, tile: TileId | null, dx: number, dy: number): void {
    if (tile === null) return;
    const parsed = parseTileId(tile);
    if (!parsed) return;
    const sheet = this.sheetFor(parsed.sheet);
    const cols = sheet?.cols ?? 16;
    const rows = sheet?.rows ?? Math.max(1, Math.ceil((parsed.cell + 1) / cols));
    const image = this.art.sheetImage(parsed.sheet) ?? this.art.placeholderSheet(parsed.sheet, cols, rows);
    ctx.drawImage(image, (parsed.cell % cols) * TILE, Math.floor(parsed.cell / cols) * TILE, TILE, TILE, dx, dy, TILE, TILE);
  }

  /** Bring the cached layer bitmaps up to date with the document. The cache
   * remembers which tile it drew in each cell; after an edit (or undo) only
   * cells whose tile differs are redrawn. A different map, size or art
   * revision redraws everything. */
  private ensureLayers(map: MapDef): void {
    const revision = `${this.app.session?.revision}`;
    const key = `${this.app.mapId}|${this.art.revision}|${map.width}x${map.height}|${this.app.session?.sheets().length}`;
    if (revision === this.cacheRevision && key === this.cacheKey) return;
    const started = performance.now();
    const full = key !== this.cacheKey;
    if (full) {
      for (const canvas of [this.ground, this.upper]) {
        canvas.width = map.width * TILE;
        canvas.height = map.height * TILE;
      }
      this.drawnGround = new Array(map.width * map.height).fill(undefined);
      this.drawnUpper = new Array(map.width * map.height).fill(undefined);
    }
    const upper: (TileId | null)[] = new Array(map.width * map.height).fill(null);
    for (const [index, tile] of map.upper ?? []) upper[index] = tile;
    const g = this.ground.getContext("2d")!;
    const u = this.upper.getContext("2d")!;
    let redrawn = 0;
    for (let i = 0; i < map.width * map.height; i++) {
      const x = (i % map.width) * TILE;
      const y = Math.floor(i / map.width) * TILE;
      const ground = map.ground[i] ?? null;
      if (this.drawnGround[i] !== ground) {
        g.clearRect(x, y, TILE, TILE);
        this.drawTile(g, ground, x, y);
        this.drawnGround[i] = ground;
        redrawn++;
      }
      const top = upper[i] ?? null;
      if (this.drawnUpper[i] !== top) {
        u.clearRect(x, y, TILE, TILE);
        this.drawTile(u, top, x, y);
        this.drawnUpper[i] = top;
        redrawn++;
      }
    }
    this.cacheKey = key;
    this.cacheRevision = revision;
    this.lastRebuildMs = performance.now() - started;
    this.lastRebuildCells = redrawn;
  }

  /** Preview one stroke cell in the cached bitmap (ground/upper layers).
   * The cell is recorded as drawn with the preview tile, so the next cache
   * update repaints it if the committed document disagrees (a refused
   * stroke reverts itself). */
  private previewCell(map: MapDef, x: number, y: number, tile: TileId | null): void {
    const upper = this.app.layer === "upper";
    const layer = upper ? this.upper : this.ground;
    const ctx = layer.getContext("2d")!;
    ctx.clearRect(x * TILE, y * TILE, TILE, TILE);
    this.drawTile(ctx, tile, x * TILE, y * TILE);
    (upper ? this.drawnUpper : this.drawnGround)[y * map.width + x] = tile;
  }

  // ---- drawing ----------------------------------------------------------------

  requestDraw(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  draw(): void {
    const started = performance.now();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const t = this.theme;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.backdrop;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const map = this.app.currentMap();
    if (!map) return;
    this.ensureLayers(map);
    const { zoom, panX, panY } = this.app.view;
    const scale = dpr * zoom;
    ctx.setTransform(scale, 0, 0, scale, -panX * scale, -panY * scale);
    ctx.imageSmoothingEnabled = false;
    const W = map.width * TILE;
    const H = map.height * TILE;
    ctx.fillStyle = t.void;
    ctx.fillRect(0, 0, W, H);
    const visible = this.app.visible;
    if (visible.ground) ctx.drawImage(this.ground, 0, 0);
    if (visible.events) this.drawEvents(ctx, map);
    if (visible.upper) ctx.drawImage(this.upper, 0, 0);

    // Visible cell range for per-cell overlays.
    const x0 = Math.max(0, Math.floor(panX / TILE));
    const y0 = Math.max(0, Math.floor(panY / TILE));
    const x1 = Math.min(map.width, Math.ceil((panX + this.cssWidth / zoom) / TILE));
    const y1 = Math.min(map.height, Math.ceil((panY + this.cssHeight / zoom) / TILE));
    if (visible.passage) this.drawPassage(ctx, map, x0, y0, x1, y1);
    if (visible.grid && zoom * TILE >= 6) this.drawGrid(ctx, map, x0, y0, x1, y1, scale);
    if (visible.events) this.drawEventFrames(ctx, map, scale);
    this.drawSelection(ctx, map, scale);
    this.drawDrag(ctx, scale);
    this.drawHover(ctx, scale);
    // Map border.
    ctx.strokeStyle = t.gridMajor;
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, W, H);

    const elapsed = performance.now() - started;
    this.stats.frames++;
    this.stats.recent.push(elapsed);
    if (this.stats.recent.length > 240) this.stats.recent.shift();
  }

  private pageForDisplay(event: GameEvent): GameEvent["pages"][number] | undefined {
    const selection = this.app.selection;
    if (selection.kind === "event" && selection.eventId === event.id) return event.pages[selection.page] ?? event.pages[0];
    return event.pages.find((page) => page.sprite) ?? event.pages[0];
  }

  private drawEvents(ctx: CanvasRenderingContext2D, map: MapDef): void {
    const sprites = this.app.session?.sprites() ?? {};
    for (const event of map.events ?? []) {
      const page = this.pageForDisplay(event);
      const w = (event.w ?? 1) * TILE;
      const h = (event.h ?? 1) * TILE;
      const x = event.x * TILE;
      const y = event.y * TILE;
      ctx.fillStyle = this.theme.eventFill;
      ctx.fillRect(x, y, w, h);
      const spriteId = page?.sprite;
      if (spriteId) {
        const frame = this.art.spriteFrame(spriteId, sprites[spriteId]);
        if (frame) {
          // Bottom-anchored like the runtime: tall walkers overflow upward.
          const dw = frame.sw;
          const dh = frame.sh;
          ctx.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, x + (TILE - dw) / 2, y + TILE - dh, dw, dh);
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
          ctx.fillStyle = this.theme.event;
          ctx.font = "bold 7px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(spriteId.slice(0, 3).toUpperCase(), x + TILE / 2, y + TILE / 2);
        }
      }
    }
  }

  private drawEventFrames(ctx: CanvasRenderingContext2D, map: MapDef, scale: number): void {
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = this.theme.event;
    const showLabels = this.app.view.zoom >= 3;
    for (const event of map.events ?? []) {
      const w = (event.w ?? 1) * TILE;
      const h = (event.h ?? 1) * TILE;
      ctx.strokeRect(event.x * TILE + 0.5 / scale, event.y * TILE + 0.5 / scale, w - 1 / scale, h - 1 / scale);
      if (showLabels) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const dpr = window.devicePixelRatio || 1;
        const { zoom, panX, panY } = this.app.view;
        const px = (event.x * TILE - panX) * zoom * dpr;
        const py = (event.y * TILE - panY) * zoom * dpr;
        const label = event.name ?? event.id;
        ctx.font = `${10 * dpr}px system-ui, sans-serif`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(10,12,16,0.72)";
        ctx.fillRect(px, py - 13 * dpr, tw + 8 * dpr, 13 * dpr);
        ctx.fillStyle = this.theme.event;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, px + 4 * dpr, py - 6.5 * dpr);
        ctx.restore();
      }
    }
  }

  private drawPassage(ctx: CanvasRenderingContext2D, map: MapDef, x0: number, y0: number, x1: number, y1: number): void {
    const sheets = new Map((this.app.session?.sheets() ?? []).map((sheet) => [sheet.id, sheet]));
    const overrides = new Map<number, "pass" | "block">(map.passage ?? []);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = y * map.width + x;
        const tile = map.ground[index] ?? null;
        const parsed = tile ? parseTileId(tile) : null;
        const sheet = parsed ? sheets.get(parsed.sheet) : undefined;
        const override = overrides.get(index);
        const px = x * TILE;
        const py = y * TILE;
        if (override === "block") {
          ctx.fillStyle = "rgba(255,72,72,0.30)";
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = "rgba(255,110,110,0.80)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + 5, py + 5); ctx.lineTo(px + 11, py + 11);
          ctx.moveTo(px + 11, py + 5); ctx.lineTo(px + 5, py + 11);
          ctx.stroke();
        } else if (override === "pass") {
          ctx.fillStyle = "rgba(64,220,120,0.40)";
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = "rgba(140,255,170,0.95)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(px + 8, py + 8, 3.5, 0, Math.PI * 2);
          ctx.stroke();
        } else if (sheet && parsed && baseBlocked(sheet, parsed.cell)) {
          ctx.fillStyle = "rgba(255,72,72,0.20)";
          ctx.fillRect(px, py, TILE, TILE);
        }
        const edges = sheet && parsed ? sheet.dirEdges?.[String(parsed.cell)] : undefined;
        if (edges) {
          for (const dir of edges.enter ?? []) drawEdgeArrow(ctx, px, py, dir, true);
          for (const dir of edges.exit ?? []) drawEdgeArrow(ctx, px, py, dir, false);
        }
      }
    }
    // Stroke preview for passage/edge painting.
    const drag = this.drag;
    if (drag?.kind === "paint" && (this.app.layer === "passage" || this.app.layer === "edges")) {
      ctx.fillStyle = "rgba(255,209,102,0.45)";
      for (const index of drag.cells.keys()) ctx.fillRect((index % map.width) * TILE, Math.floor(index / map.width) * TILE, TILE, TILE);
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, map: MapDef, x0: number, y0: number, x1: number, y1: number, scale: number): void {
    ctx.lineWidth = 1 / scale;
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? this.theme.gridMajor : this.theme.grid;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        if ((x % 10 === 0) !== major) continue;
        ctx.moveTo(x * TILE, y0 * TILE);
        ctx.lineTo(x * TILE, y1 * TILE);
      }
      for (let y = y0; y <= y1; y++) {
        if ((y % 10 === 0) !== major) continue;
        ctx.moveTo(x0 * TILE, y * TILE);
        ctx.lineTo(x1 * TILE, y * TILE);
      }
      ctx.stroke();
    }
    void map;
  }

  private drawSelection(ctx: CanvasRenderingContext2D, map: MapDef, scale: number): void {
    const selection = this.app.selection;
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    if (selection.kind === "cell") rect = { x: selection.x, y: selection.y, w: selection.w ?? 1, h: selection.h ?? 1 };
    if (selection.kind === "event") {
      const event = map.events?.find((item) => item.id === selection.eventId);
      if (event) rect = { x: event.x, y: event.y, w: event.w ?? 1, h: event.h ?? 1 };
    }
    if (!rect) return;
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = this.theme.select;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeRect(rect.x * TILE, rect.y * TILE, rect.w * TILE, rect.h * TILE);
    ctx.setLineDash([]);
  }

  private drawDrag(ctx: CanvasRenderingContext2D, scale: number): void {
    const drag = this.drag;
    if (drag?.kind === "rect") {
      const x = Math.min(drag.from.x, drag.to.x);
      const y = Math.min(drag.from.y, drag.to.y);
      const w = Math.abs(drag.from.x - drag.to.x) + 1;
      const h = Math.abs(drag.from.y - drag.to.y) + 1;
      ctx.fillStyle = "rgba(255,209,102,0.22)";
      ctx.fillRect(x * TILE, y * TILE, w * TILE, h * TILE);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = this.theme.select;
      ctx.strokeRect(x * TILE, y * TILE, w * TILE, h * TILE);
    } else if (drag?.kind === "move" && drag.moved) {
      const map = this.app.currentMap();
      const event = map?.events?.find((item) => item.id === drag.eventId);
      if (event) {
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = this.theme.accent;
        ctx.strokeRect(drag.at.x * TILE, drag.at.y * TILE, (event.w ?? 1) * TILE, (event.h ?? 1) * TILE);
      }
    }
  }

  private drawHover(ctx: CanvasRenderingContext2D, scale: number): void {
    const hover = this.app.hover;
    if (!hover || this.drag?.kind === "pan") return;
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = this.theme.hover;
    ctx.strokeRect(hover.x * TILE, hover.y * TILE, TILE, TILE);
  }

  // ---- pointer tools ----------------------------------------------------------

  private bindPointer(): void {
    const canvas = this.canvas;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ax = event.clientX - rect.left;
      const ay = event.clientY - rect.top;
      if (event.ctrlKey || event.metaKey || !event.shiftKey) {
        // Wheel and trackpad pinch (ctrlKey) zoom around the pointer;
        // continuous for pinch, preset steps for a mouse wheel.
        if (event.ctrlKey && Math.abs(event.deltaY) < 40) {
          const zoom = Math.min(8, Math.max(0.25, this.app.view.zoom * Math.exp(-event.deltaY * 0.01)));
          this.setZoom(zoom, ax, ay);
        } else {
          this.zoomStep(event.deltaY < 0 ? 1 : -1, ax, ay);
        }
      } else {
        this.app.view.panX += event.deltaX / this.app.view.zoom;
        this.app.view.panY += event.deltaY / this.app.view.zoom;
        this.app.emit("view");
      }
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", () => {
      this.drag = null;
      this.cacheRevision = "";
      this.requestDraw();
    });
    canvas.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.app.hover = null;
        this.app.emit("hover");
      }
    });
  }

  private eventAt(map: MapDef, x: number, y: number): GameEvent | undefined {
    const events = map.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (x >= event.x && y >= event.y && x < event.x + (event.w ?? 1) && y < event.y + (event.h ?? 1)) return event;
    }
    return undefined;
  }

  private pointerDown(event: PointerEvent): void {
    this.canvas.focus();
    const map = this.app.currentMap();
    if (!map) return;
    if (event.button === 1 || (event.button === 0 && this.spaceHeld)) {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { kind: "pan", startX: event.clientX, startY: event.clientY, panX: this.app.view.panX, panY: this.app.view.panY };
      this.canvas.classList.add("panning");
      return;
    }
    const cell = this.cellAt(event.clientX, event.clientY);
    if (!cell.inside) return;
    const tool = this.app.tool;
    const erase = event.button === 2 || tool === "eraser";
    if (event.button !== 0 && event.button !== 2) return;
    this.canvas.setPointerCapture(event.pointerId);

    if (tool === "select" || tool === "event") {
      if (event.button === 2) return;
      const hit = this.eventAt(map, cell.x, cell.y);
      if (hit) {
        const current = this.app.selection;
        const page = current.kind === "event" && current.eventId === hit.id ? current.page : 0;
        this.app.select({ kind: "event", eventId: hit.id, page });
        this.drag = { kind: "move", eventId: hit.id, grabDX: cell.x - hit.x, grabDY: cell.y - hit.y, at: { x: hit.x, y: hit.y }, moved: false };
        return;
      }
      if (tool === "event") {
        this.createEvent(map, cell.x, cell.y);
        return;
      }
      this.app.select({ kind: "cell", x: cell.x, y: cell.y });
      return;
    }
    if (tool === "picker") {
      this.pick(map, cell.x, cell.y);
      return;
    }
    if (tool === "fill") {
      if (event.button === 2) return;
      this.fill(map, cell.x, cell.y);
      return;
    }
    if (tool === "rect") {
      this.drag = { kind: "rect", erase, from: { x: cell.x, y: cell.y }, to: { x: cell.x, y: cell.y } };
      this.requestDraw();
      return;
    }
    // pencil / eraser
    this.drag = { kind: "paint", erase, cells: new Map(), last: { x: cell.x, y: cell.y } };
    this.addStrokeCell(map, cell.x, cell.y);
    this.requestDraw();
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.kind === "pan") {
      this.app.view.panX = drag.panX - (event.clientX - drag.startX) / this.app.view.zoom;
      this.app.view.panY = drag.panY - (event.clientY - drag.startY) / this.app.view.zoom;
      this.app.emit("view");
      return;
    }
    const map = this.app.currentMap();
    if (!map) return;
    const cell = this.cellAt(event.clientX, event.clientY);
    const hover = cell.inside ? { x: cell.x, y: cell.y } : null;
    if (hover?.x !== this.app.hover?.x || hover?.y !== this.app.hover?.y) {
      this.app.hover = hover;
      this.app.emit("hover");
    }
    if (!drag) return;
    const cx = Math.max(0, Math.min(map.width - 1, cell.x));
    const cy = Math.max(0, Math.min(map.height - 1, cell.y));
    if (drag.kind === "paint") {
      // Bresenham from the previous cell so fast strokes stay continuous.
      let x = drag.last.x;
      let y = drag.last.y;
      const dx = Math.abs(cx - x);
      const dy = -Math.abs(cy - y);
      const sx = x < cx ? 1 : -1;
      const sy = y < cy ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.addStrokeCell(map, x, y);
        if (x === cx && y === cy) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
      }
      drag.last = { x: cx, y: cy };
      this.requestDraw();
    } else if (drag.kind === "rect") {
      drag.to = { x: cx, y: cy };
      this.requestDraw();
    } else if (drag.kind === "move") {
      const event = map.events?.find((item) => item.id === drag.eventId);
      if (!event) return;
      const nx = Math.max(0, Math.min(map.width - (event.w ?? 1), cx - drag.grabDX));
      const ny = Math.max(0, Math.min(map.height - (event.h ?? 1), cy - drag.grabDY));
      if (nx !== drag.at.x || ny !== drag.at.y) {
        drag.at = { x: nx, y: ny };
        drag.moved = nx !== event.x || ny !== event.y;
        this.requestDraw();
      }
    }
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    this.canvas.classList.toggle("panning", this.spaceHeld);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const map = this.app.currentMap();
    if (!drag || !map || drag.kind === "pan") return;
    if (drag.kind === "paint") this.commitStroke(map, drag.cells, drag.erase);
    else if (drag.kind === "rect") this.commitRect(map, drag);
    else if (drag.kind === "move" && drag.moved) {
      this.app.run("update-event", { map: map.id, event: drag.eventId, changes: { x: drag.at.x, y: drag.at.y } }, `Move event ${drag.eventId}`);
    }
    this.requestDraw();
  }

  private strokeValue(erase: boolean): TileId | "pass" | "block" | null {
    if (this.app.layer === "passage") return erase || this.app.passageBrush === "clear" ? null : this.app.passageBrush;
    return erase ? null : this.app.brush;
  }

  private addStrokeCell(map: MapDef, x: number, y: number): void {
    const drag = this.drag;
    if (drag?.kind !== "paint") return;
    const index = y * map.width + x;
    if (drag.cells.has(index)) return;
    drag.cells.set(index, true);
    if (this.app.layer === "ground" || this.app.layer === "upper") {
      this.previewCell(map, x, y, this.strokeValue(drag.erase) as TileId | null);
    }
  }

  private commitStroke(map: MapDef, cells: Map<number, true>, erase: boolean): void {
    const list = [...cells.keys()].map((index) => [index % map.width, Math.floor(index / map.width)]);
    if (list.length === 0) return;
    const noun = list.length === 1 ? "cell" : "cells";
    if (this.app.layer === "edges") {
      const brush = erase ? { kind: "clear" } : this.app.edgeBrush;
      this.app.run("paint-edges", { map: map.id, cells: list, brush }, `Edges on ${list.length} ${noun}`);
    } else {
      const value = this.strokeValue(erase);
      const verb = value === null ? "Erase" : "Paint";
      const response = this.app.run("paint-cells", { map: map.id, layer: this.app.layer, cells: list, value }, `${verb} ${list.length} ${this.app.layer} ${noun}`);
      // A refused stroke leaves the document unchanged; force a cache pass
      // so the preview cells are compared with it and repainted.
      if (response && !response.ok) this.cacheRevision = "";
    }
  }

  private commitRect(map: MapDef, drag: Extract<Drag, { kind: "rect" }>): void {
    const x = Math.min(drag.from.x, drag.to.x);
    const y = Math.min(drag.from.y, drag.to.y);
    const width = Math.abs(drag.from.x - drag.to.x) + 1;
    const height = Math.abs(drag.from.y - drag.to.y) + 1;
    if (this.app.layer === "ground" || this.app.layer === "upper") {
      const tile = drag.erase ? null : this.app.brush;
      this.app.run("paint-rect", { map: map.id, layer: this.app.layer, x, y, width, height, tile }, `${tile === null ? "Erase" : "Paint"} ${width}×${height} rectangle`);
      return;
    }
    const cells: Map<number, true> = new Map();
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) cells.set(py * map.width + px, true);
    this.commitStroke(map, cells, drag.erase);
  }

  private fill(map: MapDef, x: number, y: number): void {
    if (this.app.layer !== "ground" && this.app.layer !== "upper") {
      this.app.notify("info", "Fill works on the ground and upper layers; use the brush or rectangle for passage.");
      return;
    }
    this.app.run("fill-region", { map: map.id, layer: this.app.layer, x, y, tile: this.app.brush }, `Fill from (${x},${y})`);
  }

  private pick(map: MapDef, x: number, y: number): void {
    const index = y * map.width + x;
    if (this.app.layer === "passage") {
      const override = (map.passage ?? []).find(([cell]) => cell === index)?.[1];
      this.app.passageBrush = override ?? "clear";
      this.app.setTool("pencil");
      return;
    }
    const tile = this.app.layer === "upper"
      ? (map.upper ?? []).find(([cell]) => cell === index)?.[1] ?? null
      : map.ground[index] ?? null;
    if (tile === null) {
      this.app.notify("info", `(${x},${y}) is empty on the ${this.app.layer} layer.`);
      return;
    }
    this.app.setBrush(tile);
    this.app.setTool("pencil");
  }

  private createEvent(map: MapDef, x: number, y: number): void {
    const id = uniqueEventId(map.events ?? []);
    const response = this.app.run("add-event", {
      map: map.id,
      event: { id, x, y, pages: [{ trigger: "action", commands: [] }] },
    }, `New event ${id}`);
    if (response?.ok) this.app.select({ kind: "event", eventId: id, page: 0 });
  }
}

function baseBlocked(sheet: Sheet, cell: number): boolean {
  if (sheet.defaultPassage === "block") return !(sheet.pass ?? []).includes(cell);
  return (sheet.block ?? []).includes(cell);
}

function drawEdgeArrow(ctx: CanvasRenderingContext2D, px: number, py: number, dir: string, enter: boolean): void {
  // A small triangle on the named edge: blue pointing in (no entry from that
  // side), orange pointing out (no exit that way).
  ctx.fillStyle = enter ? "rgba(90,170,255,0.95)" : "rgba(255,160,64,0.95)";
  const c = TILE / 2;
  const tip = enter ? 4 : 0;
  const base = enter ? 0 : 4;
  ctx.beginPath();
  if (dir === "up") { ctx.moveTo(px + c, py + tip); ctx.lineTo(px + c - 3, py + base); ctx.lineTo(px + c + 3, py + base); }
  else if (dir === "down") { ctx.moveTo(px + c, py + TILE - tip); ctx.lineTo(px + c - 3, py + TILE - base); ctx.lineTo(px + c + 3, py + TILE - base); }
  else if (dir === "left") { ctx.moveTo(px + tip, py + c); ctx.lineTo(px + base, py + c - 3); ctx.lineTo(px + base, py + c + 3); }
  else { ctx.moveTo(px + TILE - tip, py + c); ctx.lineTo(px + TILE - base, py + c - 3); ctx.lineTo(px + TILE - base, py + c + 3); }
  ctx.closePath();
  ctx.fill();
}

export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
