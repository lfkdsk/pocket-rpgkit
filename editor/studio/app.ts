/// <reference lib="dom" />
// editor/studio/app.ts — Studio's application state. The document and its
// history live in an EditSession (editor/api/session.ts); this object adds
// only view state: the open map, selection, tool, brush, zoom, theme and
// notices. Every document change goes through run()/transaction(), which
// call the shared protocol and surface its errors.

import type { CommandAddress } from "../engine/commands.ts";
import type { MapDef, Project, TileId } from "../../src/engine/types.ts";
import { EditSession, type SessionOperation, type SessionProblem } from "../api/session.ts";
import type { EditCommandName, EditResponse } from "../api/types.ts";

export type Tool = "select" | "pencil" | "rect" | "fill" | "picker" | "eraser" | "event";
export type PaintLayer = "ground" | "upper" | "passage" | "edges";
export type PassageBrush = "pass" | "block" | "clear";
export type EdgeBrushValue = { kind: "enter" | "exit"; dir: "up" | "down" | "left" | "right" } | { kind: "clear" };

export type Selection =
  | { kind: "none" }
  | { kind: "cell"; x: number; y: number; w?: number; h?: number }
  | { kind: "event"; eventId: string; page: number; command?: CommandAddress };

export interface Notice {
  id: number;
  level: "info" | "ok" | "error";
  text: string;
}

export interface DocumentOrigin {
  /** "example:sunstone", "file:name.json" or "restored". */
  label: string;
  /** Where Save writes: "storage" (the host's one saved document) or the
   * folder or file the document was opened from. */
  savesTo: string;
}

export interface ViewState {
  zoom: number;
  /** Map-pixel coordinate at the canvas' top-left corner. */
  panX: number;
  panY: number;
}

export interface LayerVisibility {
  ground: boolean;
  upper: boolean;
  events: boolean;
  passage: boolean;
  grid: boolean;
}

type Listener = (reason: string) => void;

export class StudioApp {
  session: EditSession | null = null;
  origin: DocumentOrigin | null = null;
  mapId = "";
  selection: Selection = { kind: "none" };
  tool: Tool = "pencil";
  layer: PaintLayer = "ground";
  brush: TileId | null = null;
  passageBrush: PassageBrush = "block";
  edgeBrush: EdgeBrushValue = { kind: "enter", dir: "up" };
  recentTiles: TileId[] = [];
  view: ViewState = { zoom: 2, panX: 0, panY: 0 };
  visible: LayerVisibility = { ground: true, upper: true, events: true, passage: false, grid: true };
  hover: { x: number; y: number } | null = null;
  /** Set when a jump (from the problems list) should flash the inspector's
   * event section on its next render; the inspector clears it. */
  pulse = false;
  /** An event the pointer is over outside the canvas (the inspector's event
   * list); the canvas outlines it. */
  highlight: string | null = null;
  notices: Notice[] = [];
  problems: SessionProblem[] = [];
  /** Wall-clock milliseconds of the last protocol call (status bar). */
  lastOpMs = 0;
  private listeners = new Set<Listener>();
  private noticeId = 0;
  private unsubscribe: (() => void) | null = null;

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.listeners) listener(reason);
  }

  // ---- document --------------------------------------------------------------

  load(session: EditSession, origin: DocumentOrigin): void {
    this.unsubscribe?.();
    this.session = session;
    this.origin = origin;
    this.unsubscribe = session.subscribe(() => this.emit("document"));
    const maps = session.maps();
    const start = session.globals().start.map;
    this.mapId = maps.some((map) => map.id === start) ? start : maps[0]?.id ?? "";
    this.selection = { kind: "none" };
    this.recentTiles = [];
    const sheet = session.sheets()[0];
    this.brush = sheet ? `${sheet.id}.0` : null;
    const map = this.currentMap();
    const firstTile = map?.ground.find((tile) => tile !== null);
    if (firstTile) this.brush = firstTile;
    this.refreshProblems();
    this.emit("load");
  }

  currentMap(): MapDef | undefined {
    if (!this.session || !this.mapId) return undefined;
    try {
      return this.session.map(this.mapId);
    } catch (error) {
      this.notify("error", `Map ${this.mapId} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  openMap(id: string): void {
    if (id === this.mapId) return;
    this.mapId = id;
    this.highlight = null;
    this.selection = { kind: "none" };
    this.emit("map");
  }

  /** Run one protocol operation as one undo step; errors become notices. */
  run(command: EditCommandName, args: Record<string, unknown>, label?: string): EditResponse | undefined {
    if (!this.session) return undefined;
    const started = performance.now();
    const response = this.session.run(command, args, label ?? command);
    this.lastOpMs = performance.now() - started;
    this.after(response);
    return response;
  }

  /** Several operations as a single undo step. */
  transaction(label: string, operations: SessionOperation[]): EditResponse | undefined {
    if (!this.session) return undefined;
    const started = performance.now();
    const response = this.session.transaction(label, operations);
    this.lastOpMs = performance.now() - started;
    this.after(response);
    return response;
  }

  /** Replace the whole inline project (an accepted agent proposal) as a
   * single undo step. */
  replaceProject(label: string, project: Project): EditResponse | undefined {
    if (!this.session) return undefined;
    const started = performance.now();
    const response = this.session.replaceInline(label, project);
    this.lastOpMs = performance.now() - started;
    if (response.ok && response.changed) this.reconcileView();
    this.after(response);
    return response;
  }

  private after(response: EditResponse): void {
    if (!response.ok) {
      this.notify("error", response.error.message);
      return;
    }
    if (response.changed) this.refreshProblems();
    this.emit("edit");
  }

  undo(): void {
    const response = this.session?.undo();
    if (response && !response.ok) this.notify("error", `Undo failed: ${response.error.message}`);
    this.afterHistory();
  }

  redo(): void {
    const response = this.session?.redo();
    if (response && !response.ok) this.notify("error", `Redo failed: ${response.error.message}`);
    this.afterHistory();
  }

  jumpTo(depth: number): void {
    this.session?.jumpTo(depth);
    this.afterHistory();
  }

  private afterHistory(): void {
    if (!this.session) return;
    this.reconcileView();
    this.refreshProblems();
    this.emit("history");
  }

  /** The open map or selected event may have disappeared or been renamed. */
  private reconcileView(): void {
    const session = this.session;
    if (!session) return;
    if (!session.maps().some((map) => map.id === this.mapId)) this.mapId = session.maps()[0]?.id ?? "";
    const selection = this.selection;
    if (selection.kind === "event") {
      const event = this.currentMap()?.events?.find((item) => item.id === selection.eventId);
      if (!event) this.selection = { kind: "none" };
      else if (selection.page >= event.pages.length) this.selection = { kind: "event", eventId: event.id, page: 0 };
    }
  }

  refreshProblems(): void {
    if (!this.session) {
      this.problems = [];
      return;
    }
    // Sharded validation reads every shard; keep it to inline documents and
    // to explicit "Validate" requests for packs (see validateNow()).
    this.problems = this.session.kind === "inline" ? this.session.validate() : this.problems;
  }

  validateNow(): void {
    if (!this.session) return;
    this.problems = this.session.validate();
    this.emit("problems");
  }

  // ---- view state -------------------------------------------------------------

  select(selection: Selection): void {
    this.selection = selection;
    this.emit("selection");
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit("tool");
  }

  setLayer(layer: PaintLayer): void {
    this.layer = layer;
    if (layer === "passage" || layer === "edges") this.visible.passage = true;
    this.emit("tool");
  }

  setBrush(tile: TileId | null): void {
    this.brush = tile;
    if (tile !== null) {
      this.recentTiles = [tile, ...this.recentTiles.filter((item) => item !== tile)].slice(0, 12);
    }
    this.emit("brush");
  }

  notify(level: Notice["level"], text: string): void {
    const notice = { id: ++this.noticeId, level, text };
    this.notices = [...this.notices.slice(-4), notice];
    this.emit("notice");
    if (level !== "error") {
      setTimeout(() => this.dismiss(notice.id), 4000);
    }
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.emit("notice");
  }
}
