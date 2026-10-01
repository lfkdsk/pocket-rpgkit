/// <reference lib="dom" />
// editor/studio/map-tree.ts — the map list. Rows are virtualized: only the
// visible window (plus overscan) is in the DOM, so a sharded pack with
// hundreds of maps scrolls as cheaply as a three-map project. Opening a
// sharded map parses only that shard.

import type { SessionMapSummary } from "../api/session.ts";
import type { StudioApp } from "./app.ts";
import { h, icon, replace } from "./dom.ts";

export const MAP_ROW_HEIGHT = 30;
const OVERSCAN = 6;

/** Rows [start, end) to mount for a scroll position (pure; tested). */
export function visibleRowRange(scrollTop: number, viewport: number, count: number, rowHeight = MAP_ROW_HEIGHT, overscan = OVERSCAN): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return [start, end];
}

export function mountMapTree(root: HTMLElement, app: StudioApp): void {
  let filter = "";
  const search = h("input", {
    type: "search",
    class: "map-search",
    placeholder: "Filter maps",
    "aria-label": "Filter maps",
    oninput: () => { filter = search.value.trim().toLowerCase(); scroller.scrollTop = 0; renderRows(); },
  });
  const count = h("span", { class: "muted count" });
  const header = h("div", { class: "panel-header" }, h("span", { class: "panel-title" }, "Maps"), count);
  const spacer = h("div", { class: "map-spacer" });
  const scroller = h("div", { class: "map-scroller", role: "listbox", "aria-label": "Maps", tabIndex: 0 }, spacer);
  root.append(header, h("div", { class: "map-search-wrap" }, search), scroller);

  let maps: SessionMapSummary[] = [];
  let shown: SessionMapSummary[] = [];
  let dirty = new Set<string>();

  function refresh(): void {
    maps = app.session?.maps() ?? [];
    const entries = new Set(app.session?.dirtyEntries() ?? []);
    dirty = new Set(maps.filter((map) => map.entry && entries.has(map.entry)).map((map) => map.id));
    renderRows();
  }

  function renderRows(): void {
    shown = filter ? maps.filter((map) => map.id.toLowerCase().includes(filter) || (map.name ?? "").toLowerCase().includes(filter)) : maps;
    count.textContent = filter ? `${shown.length} / ${maps.length}` : String(maps.length);
    spacer.style.height = `${shown.length * MAP_ROW_HEIGHT}px`;
    const [start, end] = visibleRowRange(scroller.scrollTop, scroller.clientHeight || 400, shown.length);
    const start_ = app.session?.globals().start.map;
    const rows = shown.slice(start, end).map((map, offset) => {
      const index = start + offset;
      const active = map.id === app.mapId;
      return h("div", {
        class: `map-row${active ? " active" : ""}`,
        role: "option",
        "aria-selected": String(active),
        style: `top:${index * MAP_ROW_HEIGHT}px`,
        dataset: { map: map.id },
        title: `${map.name ? `${map.name} — ` : ""}${map.id} (${map.width}×${map.height})${map.entry ? `\n${map.entry}` : ""}`,
        onclick: () => app.openMap(map.id),
      },
      icon("map"),
      h("span", { class: "map-name" }, map.name ?? map.id),
      map.name ? h("span", { class: "map-id" }, map.id) : null,
      map.id === start_ ? h("span", { class: "badge", title: "Start map" }, "start") : null,
      dirty.has(map.id) ? h("span", { class: "badge dirty", title: "Unsaved changes" }, "●") : null,
      h("span", { class: "map-size" }, `${map.width}×${map.height}`));
    });
    replace(scroller, spacer, ...rows);
  }

  scroller.addEventListener("scroll", () => renderRows());
  scroller.addEventListener("keydown", (event) => {
    const at = shown.findIndex((map) => map.id === app.mapId);
    let next = at;
    if (event.key === "ArrowDown") next = Math.min(shown.length - 1, at + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = shown.length - 1;
    else return;
    event.preventDefault();
    const map = shown[next];
    if (!map) return;
    app.openMap(map.id);
    const top = next * MAP_ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + MAP_ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + MAP_ROW_HEIGHT - scroller.clientHeight;
  });
  new ResizeObserver(() => renderRows()).observe(scroller);
  app.on((reason) => {
    if (reason === "load" || reason === "edit" || reason === "history" || reason === "document" || reason === "saved") refresh();
    else if (reason === "map") renderRows();
  });
  refresh();
}
