/// <reference lib="dom" />
// A cached whole-map thumbnail with an independently updated viewport box.

import type { StudioApp } from "./app.ts";
import type { ArtRegistry } from "./art.ts";
import type { MapCanvas } from "./canvas.ts";
import { h } from "./dom.ts";

const MAX_WIDTH = 184;
const MAX_HEIGHT = 136;

export class Minimap {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly viewport: HTMLElement;
  lastBuildMs = 0;
  private cacheKey = "";
  private cssWidth = 1;
  private cssHeight = 1;
  private drag: { pointer: number; offsetX: number; offsetY: number } | null = null;

  constructor(root: HTMLElement, private app: StudioApp, private mapCanvas: MapCanvas, private art: ArtRegistry) {
    this.root = root;
    this.root.classList.add("minimap");
    this.root.dataset.testid = "minimap";
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "application");
    this.root.setAttribute("aria-label", "Map overview; click or drag to pan");
    this.canvas = h("canvas", { class: "minimap-image", "aria-hidden": "true" });
    this.viewport = h("div", { class: "minimap-viewport", "data-testid": "minimap-viewport", "aria-hidden": "true" });
    root.append(this.canvas, this.viewport);
    root.addEventListener("pointerdown", (event) => this.pointerDown(event));
    root.addEventListener("pointermove", (event) => this.pointerMove(event));
    root.addEventListener("pointerup", (event) => this.pointerUp(event));
    root.addEventListener("pointercancel", () => { this.drag = null; });
    root.addEventListener("keydown", (event) => this.keydown(event));
    app.on((reason) => {
      if (reason === "hover" || reason === "notice" || reason === "selection") return;
      // The cache key already carries map/document/art revisions. Tool,
      // layer, opacity and camera changes only need a cheap viewport update;
      // a theme change alone needs a rebuild for the event-dot colour.
      this.render(reason === "theme");
    });
    art.onChange(() => this.render(true));
    this.render(true);
  }

  render(rebuild = false): void {
    const map = this.app.currentMap();
    this.root.hidden = !map;
    if (!map) return;
    const mapWidth = map.width * 16;
    const mapHeight = map.height * 16;
    const scale = Math.min(MAX_WIDTH / mapWidth, MAX_HEIGHT / mapHeight);
    this.cssWidth = Math.max(44, Math.round(mapWidth * scale));
    this.cssHeight = Math.max(32, Math.round(mapHeight * scale));
    this.root.style.width = `${this.cssWidth}px`;
    this.root.style.height = `${this.cssHeight}px`;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.cssWidth * dpr));
    const height = Math.max(1, Math.round(this.cssHeight * dpr));
    const key = `${this.app.mapId}|${this.app.session?.revision}|${this.art.revision}|${width}x${height}`;
    if (rebuild || key !== this.cacheKey) {
      const started = performance.now();
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.style.width = `${this.cssWidth}px`;
      this.canvas.style.height = `${this.cssHeight}px`;
      this.mapCanvas.drawGroundThumbnail(this.canvas);
      const ctx = this.canvas.getContext("2d")!;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-event").trim() || "#7ce0c3";
      const dot = Math.max(2, Math.round(dpr * 2));
      for (const event of map.events ?? []) {
        const x = Math.round(((event.x + (event.w ?? 1) / 2) / map.width) * width);
        const y = Math.round(((event.y + (event.h ?? 1) / 2) / map.height) * height);
        ctx.fillRect(x - Math.floor(dot / 2), y - Math.floor(dot / 2), dot, dot);
      }
      this.cacheKey = key;
      this.lastBuildMs = performance.now() - started;
    }
    this.positionViewport();
  }

  private positionViewport(): void {
    const view = this.mapCanvas.viewport();
    if (!view) return;
    const left = Math.max(0, Math.min(this.cssWidth, view.x / view.mapWidth * this.cssWidth));
    const top = Math.max(0, Math.min(this.cssHeight, view.y / view.mapHeight * this.cssHeight));
    const right = Math.max(0, Math.min(this.cssWidth, (view.x + view.width) / view.mapWidth * this.cssWidth));
    const bottom = Math.max(0, Math.min(this.cssHeight, (view.y + view.height) / view.mapHeight * this.cssHeight));
    const width = Math.max(5, right - left);
    const height = Math.max(5, bottom - top);
    this.viewport.style.left = `${Math.min(left, this.cssWidth - width)}px`;
    this.viewport.style.top = `${Math.min(top, this.cssHeight - height)}px`;
    this.viewport.style.width = `${Math.min(this.cssWidth, width)}px`;
    this.viewport.style.height = `${Math.min(this.cssHeight, height)}px`;
  }

  private point(event: PointerEvent): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    const view = this.mapCanvas.viewport()!;
    return {
      x: Math.max(0, Math.min(view.mapWidth, (event.clientX - rect.left) / rect.width * view.mapWidth)),
      y: Math.max(0, Math.min(view.mapHeight, (event.clientY - rect.top) / rect.height * view.mapHeight)),
    };
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.mapCanvas.viewport()) return;
    event.preventDefault();
    this.root.focus();
    this.root.setPointerCapture(event.pointerId);
    const point = this.point(event);
    const view = this.mapCanvas.viewport()!;
    const rect = this.viewport.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    this.drag = {
      pointer: event.pointerId,
      offsetX: inside ? point.x - (view.x + view.width / 2) : 0,
      offsetY: inside ? point.y - (view.y + view.height / 2) : 0,
    };
    this.mapCanvas.centerAt(point.x - this.drag.offsetX, point.y - this.drag.offsetY, false);
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    const point = this.point(event);
    this.mapCanvas.centerAt(point.x - drag.offsetX, point.y - drag.offsetY, true);
  }

  private pointerUp(event: PointerEvent): void {
    if (this.drag?.pointer !== event.pointerId) return;
    this.drag = null;
    if (this.root.hasPointerCapture(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
  }

  private keydown(event: KeyboardEvent): void {
    const view = this.mapCanvas.viewport();
    if (!view) return;
    const stepX = view.width / 8;
    const stepY = view.height / 8;
    let x = view.x + view.width / 2;
    let y = view.y + view.height / 2;
    if (event.key === "ArrowLeft") x -= stepX;
    else if (event.key === "ArrowRight") x += stepX;
    else if (event.key === "ArrowUp") y -= stepY;
    else if (event.key === "ArrowDown") y += stepY;
    else return;
    event.preventDefault();
    this.mapCanvas.centerAt(x, y, true);
  }
}

export function mountMinimap(root: HTMLElement, app: StudioApp, mapCanvas: MapCanvas, art: ArtRegistry): Minimap {
  return new Minimap(root, app, mapCanvas, art);
}
