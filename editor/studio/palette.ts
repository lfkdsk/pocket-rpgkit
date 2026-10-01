/// <reference lib="dom" />
// editor/studio/palette.ts — the brush panel under the map list: tile sheets
// of the current map (with zoom and a recently-used strip), or the passage /
// one-way edge brushes when those layers are active.

import type { Sheet, TileId } from "../../src/engine/types.ts";
import type { EdgeBrushValue, StudioApp } from "./app.ts";
import { ArtRegistry, TILE, parseTileId } from "./art.ts";
import { h, icon, replace } from "./dom.ts";

const DIRS = ["up", "down", "left", "right"] as const;
const ARROWS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

export function mountPalette(root: HTMLElement, app: StudioApp, art: ArtRegistry): void {
  let sheetId = "";
  /** Display scale; null fits the sheet to the panel width. */
  let zoom: number | null = null;
  const header = h("div", { class: "panel-header" });
  const body = h("div", { class: "palette-body" });
  root.append(header, body);

  function sheetsOfMap(): Sheet[] {
    const map = app.currentMap();
    const all = app.session?.sheets() ?? [];
    const declared = map?.sheets ?? all.map((sheet) => sheet.id);
    return declared.map((id) => all.find((sheet) => sheet.id === id)).filter((sheet): sheet is Sheet => !!sheet);
  }

  /** Largest scale (at least 1) that shows the whole sheet width. */
  function fitZoom(sheet = sheetsOfMap().find((item) => item.id === sheetId)): number {
    const width = root.clientWidth - 22;
    return sheet && width > 0 ? Math.max(1, width / (sheet.cols * TILE)) : 2;
  }

  function tileThumb(tile: string, size: number): HTMLCanvasElement {
    const canvas = h("canvas", { class: "tile-thumb", width: TILE, height: TILE, title: tile });
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const parsed = parseTileId(tile);
    const sheet = parsed && app.session?.sheets().find((item) => item.id === parsed.sheet);
    if (parsed && sheet) {
      const ctx = canvas.getContext("2d")!;
      const image = art.sheetImage(sheet.id) ?? art.placeholderSheet(sheet.id, sheet.cols, sheet.rows);
      ctx.drawImage(image, (parsed.cell % sheet.cols) * TILE, Math.floor(parsed.cell / sheet.cols) * TILE, TILE, TILE, 0, 0, TILE, TILE);
    }
    return canvas;
  }

  function renderTiles(): void {
    const sheets = sheetsOfMap();
    if (!sheets.some((sheet) => sheet.id === sheetId)) {
      const brushSheet = app.brush ? parseTileId(app.brush)?.sheet : undefined;
      sheetId = sheets.find((sheet) => sheet.id === brushSheet)?.id ?? sheets[0]?.id ?? "";
    }
    const sheet = sheets.find((item) => item.id === sheetId);
    replace(header,
      h("span", { class: "panel-title" }, "Tiles"),
      h("div", { class: "segmented small", role: "tablist", "aria-label": "Tile sheet" },
        sheets.map((item) => h("button", {
          type: "button",
          role: "tab",
          class: item.id === sheetId ? "active" : "",
          "aria-selected": String(item.id === sheetId),
          title: `Sheet ${item.id} (${item.cols}×${item.rows})`,
          onclick: () => { sheetId = item.id; render(); },
        }, item.id))),
      h("div", { class: "spacer" }),
      h("button", { type: "button", class: "icon-button tiny", title: "Smaller tiles", "aria-label": "Smaller tiles", onclick: () => { zoom = Math.max(1, Math.round((zoom ?? fitZoom()) - 1)); render(); } }, icon("zoomOut")),
      h("button", { type: "button", class: "icon-button tiny", title: "Larger tiles", "aria-label": "Larger tiles", onclick: () => { zoom = Math.min(4, Math.round((zoom ?? fitZoom()) + 1)); render(); } }, icon("zoomIn")),
    );
    const recent = app.recentTiles.filter((tile): tile is string => tile !== null && sheets.some((item) => item.id === parseTileId(tile)?.sheet));
    const recentStrip = h("div", { class: "recent-tiles", "aria-label": "Recently used tiles" },
      h("span", { class: "muted" }, "Recent"),
      recent.length === 0 ? h("span", { class: "muted" }, "—") : recent.map((tile) => {
        if (tile === null) return null;
        const button = h("button", {
          type: "button",
          class: `recent-tile${tile === app.brush ? " active" : ""}`,
          title: tile,
          "aria-label": `Tile ${tile}`,
          onclick: () => app.setBrush(tile),
        }, tileThumb(tile, 24));
        return button;
      }),
    );
    if (!sheet) {
      replace(body, recentStrip, h("p", { class: "empty" }, "This map declares no tile sheets."));
      return;
    }
    const status = art.sheetStatus(sheet.id);
    const canvas = h("canvas", {
      class: "palette-canvas",
      width: sheet.cols * TILE,
      height: sheet.rows * TILE,
      "aria-label": `Tile sheet ${sheet.id}`,
    });
    canvas.dataset.sheet = sheet.id;
    const scale = zoom ?? fitZoom(sheet);
    canvas.style.width = `${Math.floor(sheet.cols * TILE * scale)}px`;
    canvas.style.height = `${Math.floor(sheet.rows * TILE * scale)}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(art.sheetImage(sheet.id) ?? art.placeholderSheet(sheet.id, sheet.cols, sheet.rows), 0, 0);
    const brush = app.brush ? parseTileId(app.brush) : null;
    if (brush && brush.sheet === sheet.id) {
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 1;
      ctx.strokeRect((brush.cell % sheet.cols) * TILE + 0.5, Math.floor(brush.cell / sheet.cols) * TILE + 0.5, TILE - 1, TILE - 1);
    }
    canvas.addEventListener("click", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(((event.clientX - rect.left) / rect.width) * sheet.cols);
      const y = Math.floor(((event.clientY - rect.top) / rect.height) * sheet.rows);
      if (x < 0 || y < 0 || x >= sheet.cols || y >= sheet.rows) return;
      app.setBrush(`${sheet.id}.${y * sheet.cols + x}`);
      if (app.tool !== "pencil" && app.tool !== "rect" && app.tool !== "fill") app.setTool("pencil");
    });
    replace(body,
      recentStrip,
      status.source === "missing" || status.source === "broken"
        ? h("p", { class: "art-missing" }, icon("image"), ` No art for sheet “${sheet.id}” — showing numbered placeholders. Use Art… to choose a PNG.`)
        : null,
      h("div", { class: "palette-scroll" }, canvas),
      h("div", { class: "brush-line" },
        h("span", { class: "muted" }, "Brush"),
        app.brush ? tileThumb(app.brush, 20) : null,
        h("code", { "data-testid": "brush" }, app.brush ?? "eraser")),
    );
  }

  function renderPassage(): void {
    replace(header, h("span", { class: "panel-title" }, "Passage brush"));
    const options: [typeof app.passageBrush, string, string][] = [
      ["block", "Block", "Cells cannot be entered"],
      ["pass", "Pass", "Cells can always be entered"],
      ["clear", "Clear", "Remove the per-cell override"],
    ];
    replace(body, h("div", { class: "brush-grid" }, options.map(([value, label, hint]) => h("button", {
      type: "button",
      class: `brush-choice passage-${value}${app.passageBrush === value ? " active" : ""}`,
      "aria-pressed": String(app.passageBrush === value),
      title: hint,
      dataset: { brush: value },
      onclick: () => { app.passageBrush = value; app.emit("brush"); },
    }, h("span", { class: "swatch" }), label))),
    h("p", { class: "hint" }, "Paints per-cell overrides on this map. Right-click clears. Red tint = blocked by the tile sheet; X = blocked override; ○ = pass override."));
  }

  function renderEdges(): void {
    replace(header, h("span", { class: "panel-title" }, "One-way edges"));
    const isPack = app.session?.kind === "pack";
    const same = (a: EdgeBrushValue, b: EdgeBrushValue) => JSON.stringify(a) === JSON.stringify(b);
    const choice = (brush: EdgeBrushValue, label: string, hint: string) => h("button", {
      type: "button",
      class: `brush-choice${same(app.edgeBrush, brush) ? " active" : ""}`,
      "aria-pressed": String(same(app.edgeBrush, brush)),
      title: hint,
      disabled: isPack,
      onclick: () => { app.edgeBrush = brush; app.emit("brush"); },
    }, label);
    replace(body,
      isPack ? h("p", { class: "art-missing" }, icon("warn"), " Edges live on project-wide tile sheets; sharded packs cannot change them here.") : null,
      h("div", { class: "edge-grid" },
        h("span", { class: "muted" }, "No entry from"),
        DIRS.map((dir) => choice({ kind: "enter", dir }, `${ARROWS[dir]} ${dir}`, `Forbid entering the tile from ${dir}`)),
        h("span", { class: "muted" }, "No exit to"),
        DIRS.map((dir) => choice({ kind: "exit", dir }, `${ARROWS[dir]} ${dir}`, `Forbid leaving the tile ${dir}`)),
        choice({ kind: "clear" }, "Clear edges", "Remove one-way edges from the tile"),
      ),
      h("p", { class: "hint" }, "Edges belong to the painted cell's ground tile in its sheet, so every cell with that tile changes. Blue arrows point in (no entry), orange point out (no exit)."));
  }

  function render(): void {
    if (!app.session) {
      replace(header, h("span", { class: "panel-title" }, "Tiles"));
      replace(body);
      return;
    }
    if (app.layer === "passage") renderPassage();
    else if (app.layer === "edges") renderEdges();
    else renderTiles();
  }

  app.on((reason) => {
    if (reason === "hover" || reason === "view" || reason === "notice" || reason === "selection") return;
    render();
  });
  art.onChange(render);
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (zoom === null && root.clientWidth !== lastWidth) {
      lastWidth = root.clientWidth;
      render();
    }
  }).observe(root);
  render();
}
