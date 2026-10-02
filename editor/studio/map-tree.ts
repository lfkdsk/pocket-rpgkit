/// <reference lib="dom" />
// editor/studio/map-tree.ts — the map list. Rows are virtualized: only the
// visible window (plus overscan) is in the DOM, so a sharded pack with
// hundreds of maps scrolls as cheaply as a three-map project. Opening a
// sharded map parses only that shard. Dragging a row (or Alt+Up/Down)
// reorders inline projects' maps with one `move-map` operation; a sharded
// pack's map order is its fixed mapIndex, so packs only open maps.

import type { SessionMapSummary } from "../api/session.ts";
import type { StudioApp } from "./app.ts";
import { emptyState, h, icon, replace } from "./dom.ts";

export const MAP_ROW_HEIGHT = 30;
const OVERSCAN = 6;

/** Rows [start, end) to mount for a scroll position (pure; tested). */
export function visibleRowRange(scrollTop: number, viewport: number, count: number, rowHeight = MAP_ROW_HEIGHT, overscan = OVERSCAN): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return [start, end];
}

/** The `move-map` index for dropping map `id` into gap `slot` of the shown
 * (possibly filtered) list, 0..shown.length; null when nothing moves. */
export function mapDropIndex(order: readonly string[], shown: readonly string[], id: string, slot: number): number | null {
  const from = order.indexOf(id);
  if (from < 0 || shown.length === 0) return null;
  const clamped = Math.max(0, Math.min(shown.length, slot));
  // A gap immediately before or after the dragged row is the same visible
  // position. With a filter, moving there must not silently cross maps hidden
  // between the two shown rows.
  const shownFrom = shown.indexOf(id);
  if (shownFrom >= 0) {
    const shownTo = clamped > shownFrom ? clamped - 1 : clamped;
    if (shownTo === shownFrom) return null;
  }
  const insert = clamped < shown.length ? order.indexOf(shown[clamped]!) : order.indexOf(shown[shown.length - 1]!) + 1;
  if (insert < 0) return null;
  const to = insert > from ? insert - 1 : insert;
  return to === from ? null : to;
}

/** Gap index under a pointer at content offset `y` (scrollTop included). */
export function mapDropSlot(y: number, count: number, rowHeight = MAP_ROW_HEIGHT): number {
  return Math.max(0, Math.min(count, Math.round(y / rowHeight)));
}

const DRAG_THRESHOLD = 4;
const EDGE_SCROLL = 28;

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
  /** A press on a row; becomes a drag once it moves a few pixels. */
  let press: { id: string; pointerId: number; startY: number; dragging: boolean; slot: number; clientY: number } | null = null;
  let suppressClick = false;
  let edgeTimer = 0;
  const dropLine = h("div", { class: "map-drop-line", "aria-hidden": "true" });

  function moveMap(id: string, index: number): void {
    const label = `Move map ${id}`;
    if (app.run("move-map", { map: id, index }, label)?.ok) app.notify("info", `${label} to position ${index + 1}`);
  }

  function canReorder(): boolean {
    return app.session?.kind === "inline";
  }

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
      const dragged = press?.dragging && press.id === map.id;
      return h("div", {
        class: `map-row${active ? " active" : ""}${dragged ? " dragging" : ""}`,
        role: "option",
        "aria-selected": String(active),
        style: `top:${index * MAP_ROW_HEIGHT}px`,
        dataset: { map: map.id },
        title: `${map.name ? `${map.name} — ` : ""}${map.id} (${map.width}×${map.height})${map.entry ? `\n${map.entry}` : ""}${canReorder() ? "\nDrag to reorder (Alt+↑/↓)" : ""}`,
        onclick: () => {
          if (suppressClick) suppressClick = false;
          else app.openMap(map.id);
        },
      },
      icon("map"),
      h("span", { class: "map-name" }, map.name ?? map.id),
      map.name ? h("span", { class: "map-id" }, map.id) : null,
      map.id === start_ ? h("span", { class: "badge", title: "Start map" }, "start") : null,
      dirty.has(map.id) ? h("span", { class: "badge dirty", title: "Unsaved changes" }, "●") : null,
      h("span", { class: "map-size" }, `${map.width}×${map.height}`));
    });
    const dragging = press?.dragging ? press : null;
    // In the 2 px gap above the slot's row; the first slot stays inside the list.
    if (dragging) {
      dropLine.style.top = `${Math.max(3, dragging.slot * MAP_ROW_HEIGHT - 1)}px`;
      const noChange = mapDropIndex(maps.map((map) => map.id), shown.map((map) => map.id), dragging.id, dragging.slot) === null;
      dropLine.classList.toggle("no-change", noChange);
      dropLine.dataset.note = noChange ? (filter && shown.length < maps.length ? "Hidden maps stay in place" : "No change") : "";
    }
    const empty = shown.length === 0
      ? filter
        ? emptyState("map", "No map matches", `No map id or name contains “${filter}”.`, { label: "Clear filter", onClick: () => { search.value = ""; filter = ""; renderRows(); } })
        : app.session
          ? emptyState("map", "No maps", "Create or import a map to begin building the world.")
          : emptyState("open", "No project open", "Open or drop a project to start editing maps.")
      : null;
    replace(scroller, spacer, ...rows, dragging ? dropLine : null, empty);
  }

  function slotAt(clientY: number): number {
    const rect = scroller.getBoundingClientRect();
    return mapDropSlot(clientY - rect.top + scroller.scrollTop, shown.length);
  }

  function edgeScroll(): void {
    edgeTimer = 0;
    if (!press?.dragging) return;
    const rect = scroller.getBoundingClientRect();
    const delta = press.clientY < rect.top + EDGE_SCROLL ? -8 : press.clientY > rect.bottom - EDGE_SCROLL ? 8 : 0;
    if (delta === 0) return;
    scroller.scrollTop += delta;
    press.slot = slotAt(press.clientY);
    renderRows();
    edgeTimer = window.setTimeout(edgeScroll, 30);
  }

  function endDrag(commit: boolean): void {
    const ended = press;
    press = null;
    stopTrackingPointer();
    if (edgeTimer) window.clearTimeout(edgeTimer);
    edgeTimer = 0;
    scroller.classList.remove("drag-active");
    if (!ended?.dragging) return;
    suppressClick = true;
    // A drag that ends outside any row produces no click to swallow.
    setTimeout(() => { suppressClick = false; }, 0);
    renderRows();
    if (!commit) return;
    const index = mapDropIndex(maps.map((map) => map.id), shown.map((map) => map.id), ended.id, ended.slot);
    if (index !== null) moveMap(ended.id, index);
    else if (filter && shown.length < maps.length) app.notify("info", "Map order unchanged; a drop beside the same visible neighbours does not cross hidden maps.");
  }

  function stopTrackingPointer(): void {
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerUp, true);
    window.removeEventListener("pointercancel", pointerCancel, true);
  }

  function pointerMove(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    press.clientY = event.clientY;
    if (!press.dragging) {
      if (Math.abs(event.clientY - press.startY) < DRAG_THRESHOLD) return;
      if (!canReorder()) {
        stopTrackingPointer();
        press = null;
        app.notify("info", "A sharded pack's map order is fixed; reorder maps in an inline project or with rpgkit-edit.");
        return;
      }
      press.dragging = true;
      scroller.classList.add("drag-active");
    }
    event.preventDefault();
    press.slot = slotAt(event.clientY);
    renderRows();
    if (!edgeTimer) edgeScroll();
  }

  function pointerUp(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    endDrag(true);
  }

  function pointerCancel(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    endDrag(false);
  }

  scroller.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(".map-row");
    const id = row?.dataset.map;
    if (!id) return;
    if (press) {
      stopTrackingPointer();
      endDrag(false);
    }
    press = { id, pointerId: event.pointerId, startY: event.clientY, dragging: false, slot: 0, clientY: event.clientY };
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
  });

  scroller.addEventListener("scroll", () => renderRows());
  scroller.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && press?.dragging) {
      event.preventDefault();
      endDrag(false);
      return;
    }
    const at = shown.findIndex((map) => map.id === app.mapId);
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const neighbour = shown[at + (event.key === "ArrowUp" ? -1 : 1)];
      if (at < 0 || !neighbour) return;
      if (!canReorder()) {
        app.notify("info", "A sharded pack's map order is fixed; reorder maps in an inline project or with rpgkit-edit.");
        return;
      }
      const order = maps.map((map) => map.id);
      moveMap(app.mapId, order.indexOf(neighbour.id));
      return;
    }
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
