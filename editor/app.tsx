// editor/app.tsx — the tile-map editor shell.
//
//   root View (dark, overflow-hidden)
//     header row      LAYER DOC < >      UNDO REDO SAVE
//     [no-svc banner] gamepad-mode legend, only without a companion
//     PalettePanel    eraser + every sheet cell of the current map
//     Canvas          ground, event markers, upper star cells, cursor
//     status bar      doc / map / layer / selection / mode / save result
//
// Input has TWO live modes, neither silent:
//   - rpgkit-editor companion (desktop host, --companions rpgkit-editor):
//     real mouse + keyboard arrive as svc JSON lines (svc.ts). Left click
//     paints, right click / shift erases, drag strokes, wheel scrolls the
//     palette, cmd+z / cmd+shift+z / cmd+s drive undo/redo/save.
//   - no companion (goldens, hosts/sim without injected ops, browsers): a
//     visible amber banner names the controls and the same editor runs from
//     buttons: d-pad moves the cursor across canvas/palette/header, CIRCLE
//     paints, CROSS erases, SQUARE/TRIANGLE undo/redo, L/R switch maps,
//     SELECT toggles the layer, START saves. A missing companion must
//     never leave a window whose buttons are silently dead.
//
// Documents: the editor boots on the first bundled example document
// (engine/projects.ts; a copy saved on data.fs wins). With the companion,
// the host's --file arrives as a {t:"load"} line and replaces it; from
// then on SAVE writes that file and DOC stays on it, so the open document
// can never be saved over a different project's file.

import { batch, createMemo, createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import type { GameEvent, Page, Project, TileId } from "../src/engine/types.ts";
import {
  addPage,
  canRedo,
  canUndo,
  copyPage,
  createEditorState,
  createEventAt,
  currentMap,
  deleteMap,
  deletePage,
  deleteSelectedEvent,
  duplicateMap,
  duplicateSelectedEvent,
  edgePaintCell,
  edgeStrokeEnd,
  edgeStrokeStart,
  eventMarkers,
  exportProject,
  mapReferences,
  markSaved,
  movePage,
  moveSelectedEvent,
  newMap,
  paintCell,
  paletteTiles,
  redo,
  renameMap,
  renameSelectedEvent,
  resizeMap,
  resizeSelectedEvent,
  selectEvent,
  selectLayer,
  selectMap,
  selectPage,
  selectPassageBrush,
  selectTile,
  setMapName,
  setMapSheets,
  slotForTile,
  strokeEnd,
  strokeStart,
  undo,
  updateSelectedPage,
  type EdgeBrush,
  type EditorState,
  type MapReference,
} from "./engine/model.ts";
import { loadProject, serializeProjectPreservingSource, validateProject } from "./engine/document.ts";
import { BUNDLED_PROJECTS } from "./engine/projects.ts";
import { createTileTextures } from "./engine/textures.ts";
import {
  HEADER_H,
  STATUS_H,
  PAL_COLS,
  PAL_GRID_TOP,
  PAL_PITCH,
  PAL_W,
  clampCam,
  EVENT_TOOL_COLS,
  EVENT_TOOL_IDS,
  PASS_TOOL_COLS,
  PASS_TOOL_IDS,
  PASS_TOOL_LABELS,
  fittedView,
  headerButtons,
  hitEventTool,
  hitPassTool,
  hitTest,
  type PassTool,
} from "./engine/layout.ts";
import { HEADER_ORDER, initialCursor, stepCursor, type Cursor } from "./engine/cursor.ts";
import { connectSvc, type HostLine, type Svc } from "./svc.ts";
import { hasFs, readProject, writeProject } from "./store.ts";
import { Banner, EventPanel, HeaderButton, PalettePanel, type PaletteThumb } from "./ui/panels.tsx";
import { PassPanel } from "./ui/pass-panel.tsx";
import { Canvas, type CellEdges } from "./ui/canvas.tsx";
import { DIM, GOOD, BAD } from "./ui/panels.tsx";
import {
  eventDragDestination,
  topmostEventAt,
  type EventDragPreview,
} from "./engine/event-canvas.ts";
import {
  CONDITION_KINDS,
  EDITABLE_COMMAND_OPS,
  battleBranchPath,
  choiceBranchPath,
  commandAddressKey,
  copyCommand,
  defaultCommand,
  deleteCommand,
  getCommandList,
  ifBranchPath,
  insertCommand,
  moveCommand,
  updateCommand,
  type CommandAddress,
  type ConditionKind,
  type EditableCommandOp,
} from "./engine/commands.ts";
import {
  addPageCondition,
  commandInspectorRows,
  conditionFields,
  deletePageCondition,
  editCommandField,
  editPageConditionField,
  editPageField,
  editPageRouteField,
  eventGeometryValue,
  nextFieldValue,
  pageFieldDescriptors,
  pageRouteFieldDescriptors,
  type EditableField,
  type InspectorCommandRow as EditableCommandRow,
} from "./engine/event-fields.ts";
import {
  createEventInspectorLayout,
  hitTestEventInspector,
  ZERO_INSPECTOR_SCROLL,
  type EventInspectorAction,
  type InspectorScrollOffsets,
} from "./engine/event-layout.ts";
import {
  createMapInspectorLayout,
  hitTestMapInspector,
  type MapInspectorAction,
  type MapField,
} from "./engine/map-layout.ts";
import { EventInspector, flattenInspectorConditions } from "./ui/event-inspector.tsx";
import { MapInspector } from "./ui/map-inspector.tsx";
import {
  buildPlaytestProject,
  playtestStartCell,
  capturePlaytestCarry,
  diagnosePlaytestProject,
  playtestDebugRows,
  playtestRowEdit,
  type PlaytestCarry,
  type PlaytestIssue,
} from "./engine/playtest.ts";
import {
  hitTestPlaytest,
  playtestPanelRect,
  playtestRowsPerPage,
  type PlaytestTab,
} from "./engine/playtest-layout.ts";
import { createPlaytestAssets } from "./engine/playtest-view.ts";
import type { GameAssets } from "../src/ui/game-assets.ts";
import type { SessionState } from "../src/engine/session.ts";
import { PlaytestSurface, type PlaytestPort } from "./ui/playtest.tsx";

type Notice = { kind: "info" | "good" | "bad"; text: string };

// Fallback logical viewport when the host reports none (the fixed 480x272
// profile the goldens and the sim tests boot at).
const SCREEN_W = 480;
const SCREEN_H = 272;

interface DocSlot {
  id: string;
  project: Project;
  sourceText: string;
}

function bootDoc(index: number): DocSlot {
  const bundled = BUNDLED_PROJECTS[index]!;
  // A previously exported copy on data.fs wins over the bundled document.
  const onFs = readProject(bundled.id);
  if (onFs && "text" in onFs) {
    const loaded = loadProject(onFs.text);
    if (loaded.errors.length === 0) return { id: bundled.id, project: loaded.project, sourceText: onFs.text };
  }
  return { id: bundled.id, project: loadProject(bundled.json).project, sourceText: bundled.json };
}

export function EditorApp(): JSX.Element {
  const svc: Svc | null = connectSvc();
  const fsOk = hasFs();

  const vp0 = hostViewport(getOps());
  const [vp, setVp] = createSignal(vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H });
  const [docIndex, setDocIndex] = createSignal(0);
  const [doc, setDoc] = createSignal<DocSlot>(bootDoc(0));
  const [editor, setEditor] = createSignal<EditorState>(createEditorState(doc().project));
  const [cam, setCam] = createSignal({ x: 0, y: 0 });
  const [notice, setNotice] = createSignal<Notice>({
    kind: "info",
    text: svc
      ? fsOk
        ? "POINTER MODE (companion): LEFT PAINT, RIGHT/SHIFT ERASE"
        : "POINTER MODE (companion; no data.fs: SAVE GOES TO THE HOST FILE)"
      : "NO COMPANION - GAMEPAD MODE (SEE BANNER)",
  });
  const [palScroll, setPalScroll] = createSignal(0);
  const [hover, setHover] = createSignal<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = createSignal<Cursor>(initialCursor(0, 0));
  const [savedText, setSavedText] = createSignal<string | null>(null);
  const [loadNotice, setLoadNotice] = createSignal<string | null>(null);
  /** True once the host's --file document is open: SAVE writes that file,
   *  so DOC must not swap another project in under it. */
  const [hostFile, setHostFile] = createSignal(false);
  const [eventMode, setEventMode] = createSignal(false);
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [eventPlacement, setEventPlacement] = createSignal({ x: 0, y: 0 });
  const [dragPreview, setDragPreview] = createSignal<EventDragPreview | null>(null);
  const [inspectorSelection, setInspectorSelection] = createSignal<{
    condition: number | null;
    command: number | null;
  }>({ condition: null, command: null });
  const [inspectorFocus, setInspectorFocus] = createSignal<EventInspectorAction | null>(null);
  const [inputBuffer, setInputBuffer] = createSignal("");
  const [inspectorScroll, setInspectorScroll] = createSignal<InspectorScrollOffsets>({
    ...ZERO_INSPECTOR_SCROLL,
  });
  const [passTool, setPassTool] = createSignal<PassTool>("pass");
  const [mapInspectorOpen, setMapInspectorOpen] = createSignal(false);
  const [mapFocus, setMapFocus] = createSignal<MapInspectorAction | null>(null);
  const [mapInput, setMapInput] = createSignal("");
  const [deleteRefs, setDeleteRefs] = createSignal<{
    mapId: string;
    references: MapReference[];
  } | null>(null);
  const [mapReferencePage, setMapReferencePage] = createSignal(0);
  const [pendingPick, setPendingPick] = createSignal<{
    mapIndex: number;
    eventId: string;
    pageIndex: number;
    address: CommandAddress;
    /** Object identity pins the exact command revision. Map switches retain
     *  it; undo/redo and structural command changes do not. */
    command: Page["commands"][number];
  } | null>(null);
  const [playProject, setPlayProject] = createSignal<Project | null>(null);
  const [playAssets, setPlayAssets] = createSignal<GameAssets | null>(null);
  const [playState, setPlayState] = createSignal<SessionState | null>(null);
  const [playDebug, setPlayDebug] = createSignal(false);
  const [playTab, setPlayTab] = createSignal<PlaytestTab>("switch");
  const [playPage, setPlayPage] = createSignal(0);
  const [playIssues, setPlayIssues] = createSignal<PlaytestIssue[]>([]);
  const [carryPrevious, setCarryPrevious] = createSignal(false);
  const [lastPlayCarry, setLastPlayCarry] = createSignal<PlaytestCarry | null>(null);
  const [playStartCell, setPlayStartCell] = createSignal<{ mapId: string; x: number; y: number } | null>(null);

  // Input transactions live beside the reactive editor state. Mode changes
  // must close both halves together: reducer strokes and these UI latches.
  let pointerDown: false | "paint" | "erase" | "event" | "pass" | "edge" = false;
  let eventDrag: { event: GameEvent; start: { x: number; y: number } } | null = null;
  let pointerX = PAL_W;
  let prevButtons = 0;
  let strokeOpen = false;
  let edgeStrokeOpen = false;
  let playPointerDown = false;
  let playPort: PlaytestPort | null = null;

  const tileTextures = createTileTextures();

  const map = createMemo(() => currentMap(editor()));
  const markers = createMemo(() => eventMarkers(map()));
  /** PASS mode: the active layer is the passage override layer. Event mode
   *  is orthogonal to the layer (the layer cycle passes through PASS on the
   *  way to EVENT), so it must exclude event mode explicitly. */
  const passMode = createMemo(() => !eventMode() && editor().layer === "passage");
  const passageDense = createMemo(() => editor().passageDense[editor().mapIndex] ?? null);
  /** Per-cell dirEdges for the current map, resolved from each cell's ground
   *  tile sheet (dirEdges is sheet-level in this format). */
  const cellEdges = createMemo<(CellEdges | null)[]>(() => {
    const m = map();
    const out: (CellEdges | null)[] = new Array(m.width * m.height).fill(null);
    const sheets = new Map(editor().project.sheets.map((sheet) => [sheet.id, sheet]));
    for (let i = 0; i < m.ground.length; i++) {
      const tile = m.ground[i];
      if (typeof tile !== "string") continue;
      const match = /^([a-z0-9_-]+)\.(\d+)$/.exec(tile);
      if (!match) continue;
      const edges = sheets.get(match[1]!)?.dirEdges?.[String(Number(match[2]!))];
      if (edges) out[i] = edges;
    }
    return out;
  });
  const selectedEvent = createMemo<GameEvent | null>(() => {
    const id = editor().selectedEventId;
    return id === null ? null : (map().events ?? []).find((event) => event.id === id) ?? null;
  });
  const activePage = createMemo<Page | null>(() =>
    selectedEvent()?.pages[editor().selectedPageIndex] ?? null,
  );
  const conditionRows = createMemo(() => flattenInspectorConditions(activePage() ?? undefined));
  const commandRows = createMemo<EditableCommandRow[]>(() =>
    commandInspectorRows(activePage()?.commands ?? []),
  );
  const inspectorLayout = createMemo(() => {
    const event = selectedEvent();
    if (!event) return null;
    return createEventInspectorLayout({
      width: vp().w,
      height: vp().h - HEADER_H,
      pageCount: event.pages.length,
      activePage: editor().selectedPageIndex,
      conditions: conditionRows(),
      commands: commandRows(),
      scroll: inspectorScroll(),
    });
  });
  const mapInspectorLayout = createMemo(() => {
    if (!mapInspectorOpen()) return null;
    const pendingDelete = deleteRefs();
    return createMapInspectorLayout({
      width: vp().w,
      height: vp().h - HEADER_H,
      referenceCount: pendingDelete?.references.length ?? 0,
      referencePage: mapReferencePage(),
      showNotice: notice().text.length > 0,
    });
  });
  // Content-compared: a paint stroke replaces the project object, but the
  // palette (and the 133 thumbnail nodes under it) only changes with the
  // map's sheets.
  const palette = createMemo(() => paletteTiles(editor()), undefined, { equals: sameTiles });
  const selectedSlot = createMemo(() => slotForTile(palette(), editor().tile));
  const banner = createMemo(() => svc === null);
  const fit = createMemo(() => fittedView(vp().w, vp().h, banner()));
  const viewCols = () => fit().cols;
  const viewRows = () => fit().rows;

  const texKey = (tile: TileId): string => (tile === null ? "" : tileTextures.key(tile) ?? "");

  const thumbs = createMemo<PaletteThumb[]>(() =>
    palette().map((tile, slot) => ({
      slot,
      tileKey: tile,
      src: texKey(tile),
      label: tile ?? "erase",
    })),
  );

  const clampCameraTo = (state: EditorState, next: { x: number; y: number }) => {
    const m = currentMap(state);
    return {
      x: clampCam(next.x, m.width, viewCols()),
      y: clampCam(next.y, m.height, viewRows()),
    };
  };

  const resetForProject = (project: Project, message: Notice): void => {
    batch(() => {
      setEditor(createEditorState(project));
      setCam({ x: 0, y: 0 });
      setCursor(initialCursor(0, 0));
      setHover(null);
      setPalScroll(0);
      setEventMode(false);
      setInspectorOpen(false);
      setMapInspectorOpen(false);
      setMapFocus(null);
      setMapInput("");
      setDeleteRefs(null);
      setMapReferencePage(0);
      setPendingPick(null);
      setPassTool("pass");
      setEventPlacement({ x: 0, y: 0 });
      setPlayStartCell(null);
      setDragPreview(null);
      setInspectorSelection({ condition: null, command: null });
      setInspectorFocus(null);
      setInputBuffer("");
      setInspectorScroll({ ...ZERO_INSPECTOR_SCROLL });
      setNotice(message);
    });
  };

  const switchDoc = (): void => {
    if (hostFile()) {
      setNotice({ kind: "bad", text: "DOC IS THE HOST --file; RELAUNCH TO OPEN ANOTHER PROJECT" });
      return;
    }
    const nextIndex = (docIndex() + 1) % BUNDLED_PROJECTS.length;
    setDocIndex(nextIndex);
    const slot = bootDoc(nextIndex);
    setDoc(slot);
    setSavedText(null);
    resetForProject(slot.project, { kind: "info", text: `OPENED ${slot.id}: ${slot.project.title}` });
  };

  const switchMap = (delta: number): void => {
    const e = editor();
    const count = e.project.maps.length;
    const next = (e.mapIndex + delta + count) % count;
    if (next === e.mapIndex) return;
    const switched = selectMap(e, next);
    setDeleteRefs(null);
    setMapReferencePage(0);
    // pendingPick survives map switches: picking a target on another map is
    // the whole point of the flow.
    batch(() => {
      setEditor(switched);
      setCam(clampCameraTo(switched, cam()));
      setPlayStartCell(null);
    });
  };

  const performSave = (): void => {
    let e = editor();
    if (e.stroke) {
      e = strokeEnd(e);
      setEditor(e);
    }
    if (e.edgeStroke) {
      e = edgeStrokeEnd(e);
      setEditor(e);
    }
    const candidate = exportProject(e);
    const errors = validateProject(candidate);
    if (errors.length > 0) {
      setNotice({
        kind: "bad",
        text: `EXPORT REFUSED: ${errors.length} schema error(s), first: ${errors[0]!.path} ${errors[0]!.msg}`,
      });
      return;
    }
    const baseline = doc();
    const text = serializeProjectPreservingSource(
      baseline.sourceText,
      baseline.project,
      candidate,
    );
    const finish = (message: string): void => {
      batch(() => {
        setSavedText(text);
        setDoc({ ...baseline, project: candidate, sourceText: text });
        setEditor(markSaved(editor()));
        setNotice({ kind: "good", text: message });
      });
    };
    if (svc) {
      // The desktop host persists {t:"save"} lines atomically to --file.
      svc.save(text);
      finish(`SAVED ${text.length} bytes TO HOST FILE`);
      return;
    }
    if (fsOk) {
      const result = writeProject(doc().id, text);
      if ("error" in result) {
        setNotice({ kind: "bad", text: `SAVE FAILED: ${result.error}` });
        return;
      }
      finish(`SAVED ${result.bytes} bytes TO ${result.path}`);
      return;
    }
    // Explicit, visible failure: no silent drop (the fs API's same rule).
    setNotice({
      kind: "bad",
      text: "NO SAVE CHANNEL: RELAUNCH WITH THE rpgkit-editor COMPANION OR A DATA.FS HOST",
    });
  };

  /** Commit any live paint transaction and clear every pointer/gamepad
   *  latch before a mode boundary changes how releases are interpreted. */
  const finishActiveInput = (): void => {
    let e = editor();
    if (e.stroke) e = strokeEnd(e);
    if (e.edgeStroke) e = edgeStrokeEnd(e);
    if (e !== editor()) setEditor(e);
    pointerDown = false;
    eventDrag = null;
    setDragPreview(null);
    strokeOpen = false;
    edgeStrokeOpen = false;
  };

  const startPlaytest = (): void => {
    if (inspectorFocus() || mapFocus()) {
      setNotice({ kind: "bad", text: "FINISH OR CANCEL THE ACTIVE FIELD BEFORE PLAY" });
      return;
    }
    finishActiveInput();
    const e = editor();
    const cell = playtestStartCell(e, playStartCell());
    const candidate = buildPlaytestProject(e, cell);
    const errors = validateProject(candidate);
    if (errors.length > 0) {
      setNotice({
        kind: "bad",
        text: `PLAY REFUSED: ${errors.length} schema error(s), first: ${errors[0]!.path} ${errors[0]!.msg}`,
      });
      return;
    }
    const issues = diagnosePlaytestProject(candidate);
    batch(() => {
      setInspectorOpen(false);
      setMapInspectorOpen(false);
      setPlayState(null);
      setPlayDebug(false);
      setPlayTab("switch");
      setPlayPage(0);
      setPlayIssues(issues);
      setPlayAssets(createPlaytestAssets(candidate));
      setPlayProject(candidate);
    });
  };

  const stopPlaytest = (): void => {
    const ended = playPort?.state() ?? playState();
    if (ended) setLastPlayCarry(capturePlaytestCarry(ended));
    playPointerDown = false;
    playPort = null;
    batch(() => {
      setPlayProject(null);
      setPlayAssets(null);
      setPlayState(null);
      setPlayDebug(false);
      setPlayPage(0);
      setNotice({ kind: "good", text: "PLAYTEST STOPPED; EDITS AND UNDO HISTORY PRESERVED" });
    });
  };

  const toggleCarryMode = (): void => {
    setCarryPrevious((value) => !value);
    setNotice({
      kind: "info",
      text: carryPrevious() ? "PLAY STATE: LAST RUN SWITCHES / VARIABLES" : "PLAY STATE: FRESH",
    });
  };

  const activatePlaytestHit = (hit: NonNullable<ReturnType<typeof hitTestPlaytest>>): void => {
    if (hit.kind === "stop") {
      stopPlaytest();
      return;
    }
    if (hit.kind === "debug") {
      setPlayDebug((open) => !open);
      return;
    }
    if (hit.kind === "tab") {
      setPlayTab(hit.tab);
      setPlayPage(0);
      return;
    }
    const project = playProject();
    const state = playPort?.state() ?? playState();
    if (!project || !state) return;
    const panel = playtestPanelRect(vp().w, vp().h, playIssues().length > 0);
    const perPage = playtestRowsPerPage(panel);
    const rows = playtestDebugRows(project, state, playTab());
    if (hit.kind === "page") {
      const pages = Math.max(1, Math.ceil(rows.length / perPage));
      setPlayPage((page) => Math.max(0, Math.min(pages - 1, page + hit.delta)));
      return;
    }
    const row = rows[playPage() * perPage + hit.row];
    if (!row) return;
    const edit = playtestRowEdit(row, hit.delta);
    if (edit) playPort?.edit(edit);
  };

  const handlePlaytestMouseLine = (line: HostLine): void => {
    if (line.t !== "mouse") return;
    if (line.x === undefined || line.y === undefined || !line.d) {
      playPointerDown = false;
      return;
    }
    if (playPointerDown) return;
    playPointerDown = true;
    const hit = hitTestPlaytest(
      line.x | 0,
      line.y | 0,
      vp().w,
      vp().h,
      playDebug(),
      playIssues().length > 0,
    );
    if (hit) activatePlaytestHit(hit);
  };

  const stepPlaytestButtons = (buttons: number): void => {
    const edge = buttons & ~prevButtons;
    if (edge & BTN.START) stopPlaytest();
    else if (edge & BTN.SELECT) setPlayDebug((open) => !open);
    prevButtons = buttons;
  };

  const toggleLayer = (): void => {
    finishActiveInput();
    const e = editor();
    if (eventMode()) {
      setEventMode(false);
      const next = selectLayer(e, "ground");
      setEditor(next);
      setNotice({ kind: "info", text: "LAYER: GROUND" });
      return;
    }
    if (e.layer === "ground") {
      const next = selectLayer(e, "upper");
      setEditor(next);
      setNotice({ kind: "info", text: "LAYER: UPPER" });
      return;
    }
    if (e.layer === "upper") {
      const next = selectLayer(e, "passage");
      setEditor(next);
      setNotice({ kind: "info", text: "MODE: PASSAGE (PASS/BLOCK/EDGE TOOLS)" });
      return;
    }
    setEventMode(true);
    setCursor((cursor) => cursor.zone === "palette"
      ? { ...cursor, slot: Math.min(cursor.slot, EVENT_TOOL_IDS.length - 1) }
      : cursor);
    setNotice({ kind: "info", text: "MODE: EVENTS" });
  };

  const activateHeader = (index: number): void => {
    const id = HEADER_ORDER[index];
    if (id === undefined) return;
    if (id === "layer") toggleLayer();
    else if (id === "doc") switchDoc();
    else if (id === "mapprev") switchMap(-1);
    else if (id === "mapnext") switchMap(1);
    else if (id === "map") toggleMapInspector();
    else if (id === "play") startPlaytest();
    else if (id === "state") toggleCarryMode();
    else if (id === "undo") {
      setPendingPick(null);
      const e = editor();
      if (canUndo(e)) {
        const u = undo(e);
        batch(() => {
          setEditor(u);
          setCam(clampCameraTo(u, cam()));
          setDeleteRefs(null);
          setMapReferencePage(0);
        });
      }
    } else if (id === "redo") {
      setPendingPick(null);
      const e = editor();
      if (canRedo(e)) {
        const r = redo(e);
        batch(() => {
          setEditor(r);
          setCam(clampCameraTo(r, cam()));
          setDeleteRefs(null);
          setMapReferencePage(0);
        });
      }
    } else if (id === "save") performSave();
  };

  const pickPalette = (slot: number): void => {
    const tile = palette()[slot] ?? null;
    setEditor(selectTile(editor(), tile));
    setNotice({ kind: "info", text: tile === null ? "ERASER SELECTED" : `TILE ${tile}` });
  };

  // --- event inspector ---------------------------------------------------
  const clearInspectorInput = (): void => {
    setInspectorFocus(null);
    setInputBuffer("");
  };

  const resetInspectorRows = (): void => {
    setInspectorSelection({ condition: null, command: null });
    clearInspectorInput();
    setInspectorScroll({ ...ZERO_INSPECTOR_SCROLL });
  };

  const openInspector = (): void => {
    if (!selectedEvent()) {
      setNotice({ kind: "bad", text: "SELECT AN EVENT BEFORE EDIT" });
      return;
    }
    resetInspectorRows();
    setMapInspectorOpen(false);
    setInspectorOpen(true);
  };

  const closeInspector = (): void => {
    clearInspectorInput();
    setInspectorOpen(false);
  };

  const currentConditionField = (
    action: Extract<EventInspectorAction, { kind: "condition-field" }>,
  ): EditableField | null => {
    const page = activePage();
    const row = conditionRows()[action.row];
    if (!page?.condition || !row) return null;
    if (row.source.kind === "all") {
      const condition = page.condition.all?.[row.source.index];
      return condition ? conditionFields(condition).find((field) => field.key === action.field) ?? null : null;
    }
    if (row.source.key === "switch" && page.condition.switch !== undefined) {
      return conditionFields({ kind: "switch", id: page.condition.switch }).find((field) => field.key === action.field) ?? null;
    }
    if (row.source.key === "selfSwitch" && page.condition.selfSwitch !== undefined) {
      return conditionFields({ kind: "selfSwitch", key: page.condition.selfSwitch }).find((field) => field.key === action.field) ?? null;
    }
    if (row.source.key === "variable" && page.condition.variable !== undefined) {
      return conditionFields({ kind: "variable", ...page.condition.variable }).find((field) => field.key === action.field) ?? null;
    }
    if (row.source.key === "item" && page.condition.item !== undefined) {
      return conditionFields({ kind: "item", id: page.condition.item, count: 1 }).find((field) => field.key === action.field) ?? null;
    }
    return null;
  };

  const editableFieldFor = (action: EventInspectorAction): EditableField | null => {
    const event = selectedEvent();
    const page = activePage();
    if (!event || !page) return null;
    if (action.kind === "event-field") {
      const value = action.field === "name"
        ? event.name ?? event.id
        : action.field === "x"
          ? event.x
          : action.field === "y"
            ? event.y
            : action.field === "w"
              ? event.w ?? 1
              : event.h ?? 1;
      return {
        key: action.field,
        label: action.field.toUpperCase(),
        value,
        kind: action.field === "name" ? "text" : "integer",
      };
    }
    if (action.kind === "page-field") {
      return pageFieldDescriptors(page).find((field) => field.key === action.field) ?? null;
    }
    if (action.kind === "route-field") {
      return pageRouteFieldDescriptors(page).find((field) => field.key === action.field) ?? null;
    }
    if (action.kind === "condition-field") return currentConditionField(action);
    if (action.kind === "command-field") {
      return commandRows()[action.row]?.fields.find((field) => field.key === action.field) ?? null;
    }
    return null;
  };

  const finishFieldEdit = (message?: string): void => {
    clearInspectorInput();
    if (message) setNotice({ kind: "info", text: message });
  };

  const commitInspectorField = (action: EventInspectorAction, raw: string): boolean => {
    const event = selectedEvent();
    const page = activePage();
    if (!event || !page) return false;
    if (action.kind === "event-field") {
      if (action.field === "name") {
        setEditor(renameSelectedEvent(editor(), raw));
        finishFieldEdit("EVENT NAME UPDATED");
        return true;
      }
      const parsed = eventGeometryValue(raw, action.field);
      if (!parsed.ok) {
        setNotice({ kind: "bad", text: parsed.error.toUpperCase() });
        return false;
      }
      if (action.field === "x") setEditor(moveSelectedEvent(editor(), parsed.value, event.y));
      else if (action.field === "y") setEditor(moveSelectedEvent(editor(), event.x, parsed.value));
      else if (action.field === "w") setEditor(resizeSelectedEvent(editor(), parsed.value, event.h ?? 1));
      else setEditor(resizeSelectedEvent(editor(), event.w ?? 1, parsed.value));
      finishFieldEdit("EVENT GEOMETRY UPDATED");
      return true;
    }
    if (action.kind === "page-field" || action.kind === "route-field") {
      const edited = action.kind === "page-field"
        ? editPageField(page, action.field, raw)
        : editPageRouteField(page, action.field, raw);
      if (!edited.ok) {
        setNotice({ kind: "bad", text: edited.error.toUpperCase() });
        return false;
      }
      setEditor(updateSelectedPage(editor(), () => edited.value));
      finishFieldEdit("PAGE UPDATED");
      return true;
    }
    if (action.kind === "condition-field") {
      if (action.readOnly) {
        setNotice({ kind: "bad", text: "EXTENSION CONDITION IS READ ONLY" });
        return false;
      }
      const row = conditionRows()[action.row];
      if (!row) return false;
      const edited = editPageConditionField(page, row.source, action.field, raw);
      if (!edited.ok) {
        setNotice({ kind: "bad", text: edited.error.toUpperCase() });
        return false;
      }
      setEditor(updateSelectedPage(editor(), () => edited.value));
      finishFieldEdit("CONDITION UPDATED");
      return true;
    }
    if (action.kind === "command-field") {
      if (action.readOnly) {
        setNotice({ kind: "bad", text: "COMMAND PAYLOAD IS READ ONLY" });
        return false;
      }
      const row = commandRows()[action.row];
      if (!row) return false;
      const edited = editCommandField(row.command, action.field, raw);
      if (!edited.ok) {
        setNotice({ kind: "bad", text: edited.error.toUpperCase() });
        return false;
      }
      const commands = updateCommand(page.commands, row.address, edited.value);
      setEditor(updateSelectedPage(editor(), (current) => ({ ...current, commands })));
      finishFieldEdit("COMMAND UPDATED");
      return true;
    }
    return false;
  };

  const beginInspectorField = (action: EventInspectorAction): void => {
    if ((action.kind === "condition-field" || action.kind === "command-field") && action.readOnly) {
      setNotice({ kind: "bad", text: "THIS FIELD IS DISPLAY ONLY" });
      return;
    }
    const field = editableFieldFor(action);
    if (!field || field.readOnly) {
      setNotice({ kind: "bad", text: "THIS FIELD IS DISPLAY ONLY" });
      return;
    }
    if (field.kind === "enum" || field.kind === "boolean") {
      commitInspectorField(action, nextFieldValue(field));
      return;
    }
    setInspectorFocus(action);
    setInputBuffer(String(field.value ?? ""));
  };

  const selectCommandKey = (commands: Page["commands"], key: string | null): void => {
    const rows = commandInspectorRows(commands);
    const command = key === null ? null : rows.findIndex((row) => row.key === key);
    setInspectorSelection((selection) => ({
      ...selection,
      command: command !== null && command >= 0 ? command : null,
    }));
  };

  const replaceCommands = (commands: Page["commands"], selectKey: string | null): void => {
    setEditor(updateSelectedPage(editor(), (page) => ({ ...page, commands })));
    selectCommandKey(commands, selectKey);
    clearInspectorInput();
  };

  const commitAddPrompt = (): boolean => {
    const focus = inspectorFocus();
    const page = activePage();
    if (!focus || !page) return false;
    const raw = inputBuffer().trim();
    if (focus.kind === "condition-action" && focus.action === "add") {
      if (!CONDITION_KINDS.includes(raw as ConditionKind)) {
        setNotice({ kind: "bad", text: `CONDITION MUST BE: ${CONDITION_KINDS.join(", ")}` });
        return false;
      }
      const next = addPageCondition(page, raw as ConditionKind);
      setEditor(updateSelectedPage(editor(), () => next));
      setInspectorSelection((selection) => ({
        ...selection,
        condition: flattenInspectorConditions(next).length - 1,
      }));
      finishFieldEdit(`ADDED ${raw.toUpperCase()} CONDITION`);
      return true;
    }
    if (focus.kind === "command-action" && focus.action === "add") {
      const [opText = "", branchText, ...extra] = raw.split("@");
      if (extra.length > 0 || !EDITABLE_COMMAND_OPS.includes(opText as EditableCommandOp)) {
        setNotice({ kind: "bad", text: `UNKNOWN EDITABLE COMMAND: ${opText || "(EMPTY)"}` });
        return false;
      }
      const selected = inspectorSelection().command;
      const selectedRow = selected === null ? null : commandRows()[selected] ?? null;
      const root = getCommandList(page.commands, []);
      let address: CommandAddress = selectedRow
        ? { path: selectedRow.address.path, index: selectedRow.address.index + 1 }
        : { path: [], index: root?.length ?? 0 };
      if (branchText !== undefined) {
        if (!selectedRow) {
          setNotice({ kind: "bad", text: "SELECT THE PARENT COMMAND FOR @BRANCH" });
          return false;
        }
        let path = null as ReturnType<typeof ifBranchPath> | null;
        if (selectedRow.command.op === "if" && (branchText === "then" || branchText === "else")) {
          path = ifBranchPath(selectedRow.address, branchText);
        } else if (selectedRow.command.op === "choices") {
          if (branchText === "cancel") path = choiceBranchPath(selectedRow.address, "cancel");
          else {
            const match = /^option([1-9][0-9]*)$/.exec(branchText);
            const option = match ? Number(match[1]) - 1 : -1;
            if (option >= 0 && option < selectedRow.command.options.length) {
              path = choiceBranchPath(selectedRow.address, option);
            }
          }
        } else if (selectedRow.command.op === "battle"
          && (branchText === "win" || branchText === "lose" || branchText === "escape")) {
          path = battleBranchPath(selectedRow.address, branchText);
        }
        const list = path ? getCommandList(page.commands, path) : null;
        if (!path || !list) {
          setNotice({ kind: "bad", text: `INVALID @BRANCH ${branchText.toUpperCase()}` });
          return false;
        }
        address = { path, index: list.length };
      }
      const commands = insertCommand(page.commands, address, defaultCommand(opText as EditableCommandOp));
      replaceCommands(commands, commandAddressKey(address));
      setNotice({ kind: "info", text: `ADDED ${opText.toUpperCase()} COMMAND${branchText ? ` @${branchText.toUpperCase()}` : ""}` });
      return true;
    }
    return false;
  };

  const activateInspector = (action: EventInspectorAction): void => {
    const page = activePage();
    if (!page) return;
    if (action.kind === "close") {
      closeInspector();
      return;
    }
    if (action.kind === "event-field" || action.kind === "page-field" || action.kind === "route-field"
      || action.kind === "condition-field" || action.kind === "command-field") {
      beginInspectorField(action);
      return;
    }
    if (action.kind === "page-select") {
      setEditor(selectPage(editor(), action.page));
      resetInspectorRows();
      return;
    }
    if (action.kind === "page-action") {
      const index = editor().selectedPageIndex;
      const next = action.action === "add"
        ? addPage(editor())
        : action.action === "delete"
          ? deletePage(editor())
          : action.action === "up"
            ? movePage(editor(), index - 1)
            : action.action === "down"
              ? movePage(editor(), index + 1)
              : copyPage(editor());
      setEditor(next);
      resetInspectorRows();
      return;
    }
    if (action.kind === "condition-select") {
      setInspectorSelection((selection) => ({ ...selection, condition: action.row }));
      clearInspectorInput();
      return;
    }
    if (action.kind === "condition-action") {
      if (action.action === "add") {
        setInspectorFocus(action);
        setInputBuffer("");
      } else {
        const selected = inspectorSelection().condition;
        const row = selected === null ? null : conditionRows()[selected];
        if (!row) {
          setNotice({ kind: "bad", text: "SELECT A CONDITION FIRST" });
          return;
        }
        setEditor(updateSelectedPage(editor(), (current) => deletePageCondition(current, row.source)));
        setInspectorSelection((selection) => ({ ...selection, condition: null }));
        clearInspectorInput();
      }
      return;
    }
    if (action.kind === "command-select") {
      setInspectorSelection((selection) => ({ ...selection, command: action.row }));
      clearInspectorInput();
      return;
    }
    if (action.kind === "command-pick") {
      beginPick(action.row);
      return;
    }
    if (action.kind === "command-action") {
      if (action.action === "add") {
        setInspectorFocus(action);
        setInputBuffer("");
        return;
      }
      const selected = inspectorSelection().command;
      const row = selected === null ? null : commandRows()[selected];
      if (!row) {
        setNotice({ kind: "bad", text: "SELECT A COMMAND FIRST" });
        return;
      }
      if (action.action === "delete") {
        replaceCommands(deleteCommand(page.commands, row.address), null);
      } else if (action.action === "copy") {
        const destination = { path: row.address.path, index: row.address.index + 1 };
        replaceCommands(copyCommand(page.commands, row.address, destination), commandAddressKey(destination));
      } else {
        const list = getCommandList(page.commands, row.address.path);
        const target = row.address.index + (action.action === "up" ? -1 : 1);
        if (list && target >= 0 && target < list.length) {
          const destination = { path: row.address.path, index: target };
          replaceCommands(moveCommand(page.commands, row.address, target), commandAddressKey(destination));
        }
      }
    }
  };

  const activateEventTool = (tool: (typeof EVENT_TOOL_IDS)[number]): void => {
    if (tool === "new") {
      const at = eventPlacement();
      setEditor(createEventAt(editor(), at.x, at.y));
      setNotice({ kind: "info", text: `NEW EVENT AT ${at.x},${at.y}` });
      // The newly created event is selected synchronously by the model.
      setInspectorSelection({ condition: null, command: null });
      setInspectorOpen(true);
      return;
    }
    if (!selectedEvent()) {
      setNotice({ kind: "bad", text: "SELECT AN EVENT FIRST" });
      return;
    }
    if (tool === "edit") openInspector();
    else if (tool === "copy") {
      setEditor(duplicateSelectedEvent(editor()));
      setNotice({ kind: "info", text: "EVENT COPIED" });
    } else {
      setEditor(deleteSelectedEvent(editor()));
      setNotice({ kind: "info", text: "EVENT DELETED" });
    }
  };

  // --- map inspector -------------------------------------------------------
  const closeMapInspector = (): void => {
    setMapFocus(null);
    setMapInput("");
    setDeleteRefs(null);
    setMapReferencePage(0);
    setMapInspectorOpen(false);
  };

  const toggleMapInspector = (): void => {
    if (mapInspectorOpen()) {
      closeMapInspector();
      return;
    }
    if (pendingPick()) return; // picking owns the canvas
    // the two inspectors are mutually exclusive (they share the canvas area)
    setInspectorOpen(false);
    setDeleteRefs(null);
    setMapReferencePage(0);
    setMapInspectorOpen(true);
  };

  const mapFieldValue = (field: MapField): string => {
    const m = currentMap(editor());
    if (field === "id") return m.id;
    if (field === "name") return m.name;
    if (field === "width") return String(m.width);
    if (field === "height") return String(m.height);
    return (m.sheets ?? []).join(",");
  };

  const commitMapField = (field: MapField, raw: string): boolean => {
    const e = editor();
    if (field === "id") {
      const r = renameMap(e, raw);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return false;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setNotice({ kind: "info", text: `MAP ID: ${raw.trim()}` });
      return true;
    }
    if (field === "name") {
      const r = setMapName(e, raw);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return false;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setNotice({ kind: "info", text: "MAP NAME UPDATED" });
      return true;
    }
    if (field === "width" || field === "height") {
      if (!/^-?\d+$/.test(raw.trim())) {
        setNotice({ kind: "bad", text: "SIZE MUST BE AN INTEGER" });
        return false;
      }
      const m = currentMap(e);
      const r = resizeMap(e, field === "width" ? Number(raw) : m.width, field === "height" ? Number(raw) : m.height);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return false;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setCam(clampCameraTo(r.state, cam()));
      setNotice(r.croppedEvents.length > 0
        ? { kind: "bad", text: `RESIZED; CROPPED ${r.croppedEvents.length} EVENT(S): ${r.croppedEvents.join(", ")} — UNDO RESTORES` }
        : { kind: "info", text: "MAP RESIZED" });
      return true;
    }
    // sheets
    const sheets = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const r = setMapSheets(e, sheets);
    if (!r.ok) {
      setNotice({ kind: "bad", text: r.error.toUpperCase() });
      return false;
    }
    setEditor(r.state);
    setDeleteRefs(null);
    setMapReferencePage(0);
    setNotice({ kind: "info", text: "MAP SHEETS UPDATED" });
    return true;
  };

  const activateMapInspector = (action: MapInspectorAction): void => {
    if (action.kind === "close") {
      closeMapInspector();
      return;
    }
    if (action.kind === "field") {
      setMapFocus(action);
      setMapInput(mapFieldValue(action.field));
      return;
    }
    if (action.kind === "reference-page") {
      const layout = mapInspectorLayout();
      if (!layout) return;
      setMapReferencePage(Math.max(
        0,
        Math.min(layout.referencePageCount - 1, layout.referencePage + action.delta),
      ));
      return;
    }
    const e = editor();
    if (action.action === "new") {
      // A new map inherits the current map's sheets and fills with the first
      // sheet's cell 0 (a walkable default) rather than blocking void.
      const sheets = currentMap(e).sheets ?? e.project.sheets.slice(0, 1).map((s) => s.id);
      const fill = sheets.length > 0 ? `${sheets[0]}.0` : null;
      const r = newMap(e, { sheets, fill });
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setCam(clampCameraTo(r.state, cam()));
      setNotice({ kind: "info", text: `NEW MAP: ${currentMap(r.state).id}` });
      return;
    }
    if (action.action === "dup") {
      const r = duplicateMap(e);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setCam(clampCameraTo(r.state, cam()));
      setNotice({ kind: "info", text: `DUPLICATED MAP: ${currentMap(r.state).id}` });
      return;
    }
    // del: a first click lists the transfers that target this map; a second
    // click (with the same map still active) confirms the delete.
    const mapId = currentMap(e).id;
    if (deleteRefs()?.mapId !== mapId) {
      const refs = mapReferences(e.project, mapId);
      if (refs.length > 0) {
        setDeleteRefs({ mapId, references: refs });
        setMapReferencePage(0);
        setNotice({ kind: "bad", text: `${refs.length} TRANSFER(S) TARGET THIS MAP — DEL AGAIN TO CONFIRM` });
        return;
      }
    }
    const r = deleteMap(e, true);
    if (!r.ok) {
      setNotice({ kind: "bad", text: r.error.toUpperCase() });
      return;
    }
    setEditor(r.state);
    setDeleteRefs(null);
    setMapReferencePage(0);
    setCam(clampCameraTo(r.state, cam()));
    setNotice({ kind: "info", text: "MAP DELETED" });
  };

  // --- passage tools --------------------------------------------------------
  const selectPassTool = (tool: PassTool): void => {
    setPassTool(tool);
    setNotice({ kind: "info", text: `PASS TOOL: ${PASS_TOOL_LABELS[tool]}` });
  };

  /** The edge brush for the current pass tool, or null for cell brushes. */
  const edgeBrushFor = (tool: PassTool): EdgeBrush | null => {
    if (tool === "clr-edge") return { kind: "clear" };
    if (tool === "in-down" || tool === "out-down") return { kind: tool === "in-down" ? "enter" : "exit", dir: "down" };
    if (tool === "in-left" || tool === "out-left") return { kind: tool === "in-left" ? "enter" : "exit", dir: "left" };
    if (tool === "in-right" || tool === "out-right") return { kind: tool === "in-right" ? "enter" : "exit", dir: "right" };
    if (tool === "in-up" || tool === "out-up") return { kind: tool === "in-up" ? "enter" : "exit", dir: "up" };
    return null;
  };

  // --- transfer target picking ----------------------------------------------
  const beginPick = (row: number): void => {
    const e = editor();
    const event = selectedEvent();
    const cmdRow = commandRows()[row];
    if (!event || !cmdRow) return;
    setPendingPick({
      mapIndex: e.mapIndex,
      eventId: event.id,
      pageIndex: e.selectedPageIndex,
      address: cmdRow.address,
      command: cmdRow.command,
    });
    setInspectorOpen(false);
    setMapInspectorOpen(false);
    clearInspectorInput();
    setMapFocus(null);
    setMapInput("");
    setNotice({ kind: "info", text: "PICK TRANSFER TARGET: CLICK A CELL (L/R SWITCH MAPS, ESC CANCELS)" });
  };

  const applyPick = (tx: number, ty: number): void => {
    const pick = pendingPick();
    if (!pick) return;
    const targetMapId = currentMap(editor()).id;
    let e = selectMap(editor(), pick.mapIndex);
    e = selectEvent(e, pick.eventId, pick.pageIndex);
    const page = e.project.maps[pick.mapIndex]?.events?.find((ev) => ev.id === pick.eventId)?.pages[pick.pageIndex];
    const list = page ? getCommandList(page.commands, pick.address.path) : null;
    const command = list?.[pick.address.index];
    if (!page || !command || command !== pick.command || command.op !== "transfer") {
      setPendingPick(null);
      setNotice({ kind: "bad", text: "PICK CANCELLED: COMMAND CHANGED" });
      return;
    }
    const keepDir = typeof command.dir === "string" ? command.dir : "down";
    let edited = editCommandField(command, "map", targetMapId);
    if (!edited.ok) {
      setPendingPick(null);
      setNotice({ kind: "bad", text: edited.error.toUpperCase() });
      return;
    }
    edited = editCommandField(edited.value, "x", String(tx));
    if (edited.ok) edited = editCommandField(edited.value, "y", String(ty));
    if (edited.ok) edited = editCommandField(edited.value, "dir", keepDir);
    if (!edited.ok) {
      setPendingPick(null);
      setNotice({ kind: "bad", text: edited.error.toUpperCase() });
      return;
    }
    const commands = updateCommand(page.commands, pick.address, edited.value);
    const next = updateSelectedPage(e, (current) => ({ ...current, commands }));
    setEditor(next);
    // The pick may have switched maps; clamp the camera back to the event's map.
    setCam(clampCameraTo(next, cam()));
    setPendingPick(null);
    setInspectorOpen(true);
    setInspectorSelection({ condition: null, command: null });
    setNotice({ kind: "info", text: `TARGET SET: ${targetMapId} ${tx},${ty} ${keepDir}` });
  };

  // --- pointer interaction ------------------------------------------------
  // false      no button held
  // "paint"    primary held (left)
  // "erase"    secondary/shift held
  // "pass"     passage override stroke (PASS mode cell brush)
  // "edge"     sheet dirEdges stroke (PASS mode edge brush)
  const cellPaint = (tx: number, ty: number): void => {
    const e = editor();
    const m = currentMap(e);
    if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return;
    setEditor(paintCell(e, ty * m.width + tx));
  };

  const hitAt = (x: number, y: number) => {
    const m = map();
    return hitTest(x, y, vp().w, vp().h, fit().frame, cam().x, cam().y, palette().length, palScroll(), {
      w: m.width,
      h: m.height,
    });
  };

  const handleMouseLine = (m: HostLine): void => {
    if (m.t !== "mouse") return;
    if (playProject()) {
      handlePlaytestMouseLine(m);
      return;
    }
    // A bare release (host Reset on focus loss) ends the stroke anywhere.
    if (m.x === undefined || m.y === undefined) {
      if (pointerDown === "paint" || pointerDown === "erase" || pointerDown === "pass") {
        setEditor(strokeEnd(editor()));
      } else if (pointerDown === "edge") {
        setEditor(edgeStrokeEnd(editor()));
      }
      eventDrag = null;
      setDragPreview(null);
      pointerDown = false;
      return;
    }
    const x = m.x | 0;
    const y = m.y | 0;
    pointerX = x;

    if (mapInspectorOpen()) {
      if (m.d && !pointerDown) {
        pointerDown = "event";
        if (y < HEADER_H) {
          const hit = hitAt(x, y);
          if (hit?.kind === "button") activateHeader(HEADER_ORDER.indexOf(hit.id));
        } else {
          const layout = mapInspectorLayout();
          if (layout) {
            const action = hitTestMapInspector(layout, x, y - HEADER_H);
            if (action) activateMapInspector(action);
          }
        }
      } else if (!m.d) {
        pointerDown = false;
      }
      return;
    }

    if (inspectorOpen()) {
      if (m.d && !pointerDown) {
        pointerDown = "event";
        if (y < HEADER_H) {
          const hit = hitAt(x, y);
          if (hit?.kind === "button") activateHeader(HEADER_ORDER.indexOf(hit.id));
        } else {
          const layout = inspectorLayout();
          if (layout) {
            const action = hitTestEventInspector(layout, x, y - HEADER_H);
            if (action) activateInspector(action);
          }
        }
      } else if (!m.d) {
        pointerDown = false;
      }
      return;
    }

    if (m.d) {
      const erase = m.b === 2 || m.sh === true;
      const kind: "paint" | "erase" = erase ? "erase" : "paint";
      if (!pointerDown) {
        // Press edge: buttons and palette slots activate only here, so a
        // drag that starts on the header does not repaint the map.
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") setPlayStartCell({ mapId: map().id, x: hit.tx, y: hit.ty });
        if (hit?.kind === "button") {
          pointerDown = kind;
          activateHeader(HEADER_ORDER.indexOf(hit.id));
          return;
        }
        // Transfer-target picking owns canvas cells in every mode.
        if (pendingPick() && hit?.kind === "cell") {
          applyPick(hit.tx, hit.ty);
          return;
        }
        if (passMode() && x < PAL_W && y >= HEADER_H && y < vp().h - STATUS_H) {
          const tool = hitPassTool(x, y - HEADER_H);
          if (tool) selectPassTool(tool);
          return;
        }
        if (passMode() && hit?.kind === "cell") {
          const tool = passTool();
          const edgeBrush = edgeBrushFor(tool);
          setHover({ x: hit.tx, y: hit.ty });
          if (edgeBrush) {
            setEditor(edgeStrokeStart(editor(), edgeBrush));
            setEditor(edgePaintCell(editor(), hit.ty * map().width + hit.tx));
            pointerDown = "edge";
          } else {
            let e = selectPassageBrush(editor(), tool === "block" ? "block" : "pass");
            e = strokeStart(e, tool === "clear");
            setEditor(e);
            cellPaint(hit.tx, hit.ty);
            pointerDown = "pass";
          }
          return;
        }
        pointerDown = kind;
        if (eventMode() && x < PAL_W && y >= HEADER_H && y < vp().h - STATUS_H) {
          const tool = hitEventTool(x, y - HEADER_H);
          if (tool) activateEventTool(tool);
          return;
        }
        if (eventMode() && hit?.kind === "cell") {
          const event = topmostEventAt(markers(), hit.tx, hit.ty);
          setHover({ x: hit.tx, y: hit.ty });
          setEventPlacement({ x: hit.tx, y: hit.ty });
          setEditor(selectEvent(editor(), event?.id ?? null));
          pointerDown = "event";
          const authored = event ? (map().events ?? []).find((candidate) => candidate.id === event.id) : null;
          if (authored && !erase) eventDrag = { event: authored, start: { x: hit.tx, y: hit.ty } };
          return;
        }
        if (hit?.kind === "palette") {
          pickPalette(hit.slot);
          return;
        }
        if (hit?.kind === "cell") {
          setEditor(strokeStart(editor(), erase));
          setHover({ x: hit.tx, y: hit.ty });
          cellPaint(hit.tx, hit.ty);
        }
      } else if (pointerDown === "event" && eventDrag) {
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          const destination = eventDragDestination(eventDrag.event, eventDrag.start, {
            x: hit.tx,
            y: hit.ty,
          }, { width: map().width, height: map().height });
          setHover({ x: hit.tx, y: hit.ty });
          setDragPreview({ id: eventDrag.event.id, ...destination });
        }
      } else if (pointerDown === "edge") {
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          setHover({ x: hit.tx, y: hit.ty });
          setEditor(edgePaintCell(editor(), hit.ty * map().width + hit.tx));
        }
      } else {
        // Held move: only canvas cells extend the stroke.
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          setHover({ x: hit.tx, y: hit.ty });
          cellPaint(hit.tx, hit.ty);
        }
      }
    } else if (pointerDown) {
      if (pointerDown === "event") {
        const preview = dragPreview();
        if (preview && eventDrag?.event.id === preview.id) {
          setEditor(moveSelectedEvent(editor(), preview.x, preview.y));
          setEventPlacement({ x: preview.x, y: preview.y });
        }
        eventDrag = null;
        setDragPreview(null);
      } else if (pointerDown === "edge") {
        setEditor(edgeStrokeEnd(editor()));
      } else {
        setEditor(strokeEnd(editor()));
      }
      pointerDown = false;
    }
    if (!m.d) {
      const hit = hitAt(x, y);
      if (hit?.kind === "cell") {
        setHover({ x: hit.tx, y: hit.ty });
        if (eventMode()) setEventPlacement({ x: hit.tx, y: hit.ty });
      } else {
        setHover(null);
      }
    }
  };

  // --- buttons interaction (always live; the gamepad mode without svc) ---
  const stepButtons = (buttons: number): void => {
    if (playProject()) {
      stepPlaytestButtons(buttons);
      return;
    }
    const edge = buttons & ~prevButtons;
    const released = prevButtons & ~buttons;
    // With a pointer companion the host ALSO mirrors keys as buttons
    // (vendor/pocketjs/hosts/desktop/src/buttons.rs: z/x/a/s map to
    // CROSS/CIRCLE/SQUARE/TRIANGLE), so a cmd+z chord would undo AND erase
    // and a plain "z" would erase the cell under the cursor.
    // Pointer mode therefore lets buttons move the cursor only; activation
    // comes from the mouse and cmd-key chords. The gamepad fallback (no
    // companion) keeps the full button vocabulary.
    const pointerMode = svc !== null;
    if (inspectorOpen() || mapInspectorOpen()) {
      if (!pointerMode) {
        if (edge & BTN.CROSS) {
          if (inspectorOpen()) closeInspector();
          else closeMapInspector();
        }
        if (edge & BTN.SQUARE) activateHeader(HEADER_ORDER.indexOf("undo"));
        if (edge & BTN.TRIANGLE) activateHeader(HEADER_ORDER.indexOf("redo"));
        if (edge & BTN.START) performSave();
      }
      prevButtons = buttons;
      return;
    }
    let cur = cursor();
    let c = cam();
    const moveWorld = (dir: 0 | 1 | 2 | 3) => {
      const r = stepCursor(cur, dir, {
        mapW: map().width,
        mapH: map().height,
        viewCols: viewCols(),
        viewRows: viewRows(),
        camX: c.x,
        camY: c.y,
        paletteSize: eventMode()
          ? EVENT_TOOL_IDS.length
          : passMode()
            ? PASS_TOOL_IDS.length
            : palette().length,
        paletteCols: eventMode()
          ? EVENT_TOOL_COLS
          : passMode()
            ? PASS_TOOL_COLS
            : undefined,
        headerSize: HEADER_ORDER.length,
      });
      cur = r.cursor;
      c = { x: r.camX, y: r.camY };
    };
    if (edge & BTN.UP) moveWorld(2);
    if (edge & BTN.DOWN) moveWorld(0);
    if (edge & BTN.LEFT) moveWorld(1);
    if (edge & BTN.RIGHT) moveWorld(3);
    if (!pointerMode) {
      if (edge & BTN.SELECT) toggleLayer();
      if (edge & BTN.LTRIGGER) switchMap(-1);
      if (edge & BTN.RTRIGGER) switchMap(1);
      if (edge & BTN.SQUARE) activateHeader(HEADER_ORDER.indexOf("undo"));
      if (edge & BTN.TRIANGLE) activateHeader(HEADER_ORDER.indexOf("redo"));
      if (edge & BTN.START) performSave();
    }
    if (!pointerMode && cur.zone === "canvas" && (edge & (BTN.CIRCLE | BTN.CROSS))) {
      setPlayStartCell({ mapId: map().id, x: cur.tx, y: cur.ty });
    }

    // Transfer-target picking owns the canvas in every mode.
    if (!pointerMode && pendingPick() && cur.zone === "canvas" && (edge & BTN.CIRCLE)) {
      applyPick(cur.tx, cur.ty);
    } else if (!pointerMode && pendingPick() && (edge & BTN.CROSS)) {
      // CROSS cancels a pending pick instead of deleting an event.
      setPendingPick(null);
      setNotice({ kind: "info", text: "PICK CANCELLED" });
    } else if (!pointerMode && eventMode() && edge & (BTN.CIRCLE | BTN.CROSS)) {
      const remove = (edge & BTN.CROSS) !== 0;
      if (cur.zone === "palette") {
        if (!remove) activateEventTool(EVENT_TOOL_IDS[cur.slot] ?? "new");
      } else if (cur.zone === "header") {
        if (!remove) activateHeader(cur.button);
      } else {
        setEventPlacement({ x: cur.tx, y: cur.ty });
        const event = topmostEventAt(markers(), cur.tx, cur.ty);
        setEditor(selectEvent(editor(), event?.id ?? null));
        if (remove && event) setEditor(deleteSelectedEvent(selectEvent(editor(), event.id)));
      }
    } else if (!pointerMode && passMode() && edge & (BTN.CIRCLE | BTN.CROSS)) {
      if (cur.zone === "palette") {
        if (edge & BTN.CIRCLE) selectPassTool(PASS_TOOL_IDS[cur.slot] ?? "pass");
      } else if (cur.zone === "header") {
        if (edge & BTN.CIRCLE) activateHeader(cur.button);
      } else if (cur.zone === "canvas" && !strokeOpen && !edgeStrokeOpen) {
        const m = map();
        if (cur.tx < m.width && cur.ty < m.height) {
          const tool = passTool();
          const edgeBrush = edgeBrushFor(tool);
          if (edgeBrush) {
            setEditor(edgeStrokeStart(editor(), edgeBrush));
            setEditor((e) => edgePaintCell(e, cur.ty * m.width + cur.tx));
            edgeStrokeOpen = true;
          } else {
            let e = selectPassageBrush(editor(), tool === "block" ? "block" : "pass");
            e = strokeStart(e, tool === "clear");
            setEditor(e);
            strokeOpen = true;
          }
        }
      }
    } else if (!pointerMode && edge & (BTN.CIRCLE | BTN.CROSS)) {
      const erase = (edge & BTN.CROSS) !== 0;
      if (cur.zone === "palette") {
        if (!erase) pickPalette(cur.slot);
      } else if (cur.zone === "header") {
        if (!erase) activateHeader(cur.button);
      } else if (!strokeOpen) {
        strokeOpen = true;
        setEditor(strokeStart(editor(), erase));
      }
    }
    if (!pointerMode && !eventMode() && !passMode() && strokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => paintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && passMode() && strokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => paintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && passMode() && edgeStrokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => edgePaintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && !eventMode() && !passMode() && released & (BTN.CIRCLE | BTN.CROSS) && strokeOpen) {
      setEditor((e) => strokeEnd(e));
      strokeOpen = false;
    }
    if (!pointerMode && passMode() && released & (BTN.CIRCLE | BTN.CROSS)) {
      if (strokeOpen) {
        setEditor((e) => strokeEnd(e));
        strokeOpen = false;
      }
      if (edgeStrokeOpen) {
        setEditor((e) => edgeStrokeEnd(e));
        edgeStrokeOpen = false;
      }
    }

    batch(() => {
      setCursor(cur);
      if (c.x !== cam().x || c.y !== cam().y) setCam(c);
      // Keep the gamepad cursor's palette row inside the scrolled strip.
      if (cur.zone === "palette" && !eventMode()) {
        const columns = passMode() ? PASS_TOOL_COLS : PAL_COLS;
        const rowTop = Math.floor(cur.slot / columns) * PAL_PITCH;
        const view = vp().h - HEADER_H - STATUS_H - PAL_GRID_TOP - PAL_PITCH;
        const y = palScroll();
        if (rowTop < y) setPalScroll(rowTop);
        else if (rowTop > y + view) setPalScroll(Math.max(0, rowTop - view));
      }
    });
    prevButtons = buttons;
  };

  // --- per-frame pump -----------------------------------------------------
  onFrame((buttons) => {
    if (playProject()) {
      if (svc) {
        for (const line of svc.poll()) {
          if (line.t === "resize" && line.w !== undefined && line.h !== undefined) {
            setVp({ w: line.w, h: line.h });
          } else if (line.t === "mouse") {
            handlePlaytestMouseLine(line);
          } else if (line.t === "key" && (line.k === "Escape" || line.k === "Esc")) {
            stopPlaytest();
          }
        }
      }
      stepPlaytestButtons(buttons);
      return;
    }
    if (svc) {
      for (const line of svc.poll()) {
        if (line.t === "resize" && line.w !== undefined && line.h !== undefined) {
          setVp({ w: line.w, h: line.h });
        } else if (line.t === "load" && typeof line.text === "string") {
          const text = line.text;
          const loaded = loadProject(text);
          if (loaded.errors.length === 0) {
            // Name the slot after the bundled example the file came from
            // (the launcher points --file at an example document).
            const match = BUNDLED_PROJECTS.findIndex((b) => b.title === loaded.project.title);
            if (match >= 0) setDocIndex(match);
            setDoc({
              id: match >= 0 ? BUNDLED_PROJECTS[match]!.id : "file",
              project: loaded.project,
              sourceText: text,
            });
            setHostFile(true);
            setSavedText(text);
            setLoadNotice(`HOST FILE ${text.length} bytes`);
            resetForProject(loaded.project, { kind: "info", text: `LOADED ${text.length} bytes FROM HOST FILE` });
          } else {
            setNotice({
              kind: "bad",
              text: `HOST FILE REJECTED: ${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`,
            });
          }
        } else if (line.t === "mouse") {
          handleMouseLine(line);
        } else if (line.t === "scroll" && typeof line.dy === "number") {
          if (inspectorOpen()) {
            const layout = inspectorLayout();
            const amount = Math.sign(line.dy) * 36;
            if (layout && pointerX < layout.leftWidth) {
              setInspectorScroll((scroll) => ({
                ...scroll,
                conditionsY: Math.max(0, scroll.conditionsY + amount),
              }));
            } else {
              setInspectorScroll((scroll) => ({
                ...scroll,
                commandsY: Math.max(0, scroll.commandsY + amount),
              }));
            }
            continue;
          }
          // Clamp so the last palette row can reach the panel bottom but
          // the strip never scrolls into emptiness.
          const panelH = vp().h - HEADER_H - STATUS_H;
          const stripH = PAL_GRID_TOP + Math.ceil(palette().length / PAL_COLS) * PAL_PITCH;
          const max = Math.max(0, stripH - panelH);
          setPalScroll((y) => Math.max(0, Math.min(max, y + Math.sign(line.dy!) * 16)));
        } else if (line.t === "ch" && typeof line.s === "string") {
          if (mapFocus()) setMapInput((value) => (value + line.s!).slice(0, 4096));
          else if (inspectorFocus()) setInputBuffer((value) => (value + line.s!).slice(0, 4096));
        } else if (line.t === "paste" && typeof line.text === "string") {
          if (mapFocus()) setMapInput((value) => (value + line.text!).slice(0, 4096));
          else if (inspectorFocus()) setInputBuffer((value) => (value + line.text!).slice(0, 4096));
        } else if (line.t === "key") {
          const name = line.k ?? "";
          const focus = inspectorFocus();
          const mapFocusAction = mapFocus();
          if (pendingPick() && (name === "Escape" || name === "Esc")) {
            setPendingPick(null);
            setNotice({ kind: "info", text: "PICK CANCELLED" });
          } else if (mapFocusAction && mapFocusAction.kind === "field" && name === "Enter") {
            if (commitMapField(mapFocusAction.field, mapInput())) {
              setMapFocus(null);
              setMapInput("");
            }
          } else if (mapFocusAction && (name === "Escape" || name === "Esc")) {
            setMapFocus(null);
            setMapInput("");
          } else if (mapFocusAction && name === "Backspace") {
            setMapInput((value) => value.slice(0, -1));
          } else if (!mapFocusAction && mapInspectorOpen() && (name === "Escape" || name === "Esc")) {
            closeMapInspector();
          } else if (focus && name === "Enter") {
            if (focus.kind === "condition-action" || focus.kind === "command-action") commitAddPrompt();
            else commitInspectorField(focus, inputBuffer());
          } else if (focus && (name === "Escape" || name === "Esc")) {
            clearInspectorInput();
          } else if (focus && name === "Backspace") {
            setInputBuffer((value) => value.slice(0, -1));
          } else if (!focus && inspectorOpen() && (name === "Escape" || name === "Esc")) {
            closeInspector();
          } else if (line.cmd && (name === "z" || name === "Z")) {
            activateHeader(HEADER_ORDER.indexOf(line.sh ? "redo" : "undo"));
          } else if (line.cmd && (name === "y" || name === "Y")) {
            activateHeader(HEADER_ORDER.indexOf("redo"));
          } else if (line.cmd && (name === "s" || name === "S")) {
            performSave();
          } else if (name === "Undo") activateHeader(HEADER_ORDER.indexOf("undo"));
          else if (name === "Redo") activateHeader(HEADER_ORDER.indexOf("redo"));
        }
      }
    }
    stepButtons(buttons);
  });

  // --- test/dev hooks -----------------------------------------------------
  (globalThis as Record<string, unknown>).__rpgkitEditorState = () => ({
    editor: editor(),
    cam: cam(),
    cursor: cursor(),
    hover: hover(),
    notice: notice(),
    hasSvc: svc !== null,
    hasFs: fsOk,
    docId: doc().id,
    savedText: savedText(),
    loadNotice: loadNotice(),
    hostFile: hostFile(),
    eventMode: eventMode(),
    passMode: passMode(),
    passTool: passTool(),
    inspectorOpen: inspectorOpen(),
    mapInspectorOpen: mapInspectorOpen(),
    mapFocus: mapFocus(),
    mapInput: mapInput(),
    deleteRefs: deleteRefs(),
    mapReferencePage: mapReferencePage(),
    pendingPick: pendingPick(),
    eventPlacement: eventPlacement(),
    inspectorSelection: inspectorSelection(),
    inspectorFocus: inspectorFocus(),
    inputBuffer: inputBuffer(),
    uploaded: tileTextures.uploaded(),
    playtest: playProject() !== null,
    playProject: playProject(),
    playState: playState(),
    playDebug: playDebug(),
    playTab: playTab(),
    playPage: playPage(),
    playIssues: playIssues(),
    carryPrevious: carryPrevious(),
    hasLastPlayState: lastPlayCarry() !== null,
    playStartCell: playStartCell(),
  });
  (globalThis as Record<string, unknown>).__rpgkitEditorInject = (json: string) => {
    const loaded = loadProject(json);
    if (loaded.errors.length > 0) return { ok: false, errors: loaded.errors };
    setDoc({ id: "injected", project: loaded.project, sourceText: json });
    setSavedText(json);
    resetForProject(loaded.project, { kind: "info", text: "INJECTED PROJECT JSON" });
    return { ok: true };
  };
  (globalThis as Record<string, unknown>).__rpgkitEditorExport = (): unknown => {
    const e = editor();
    const candidate = exportProject(e);
    return {
      ok: validateProject(candidate).length === 0,
      errors: validateProject(candidate),
      text: serializeProjectPreservingSource(doc().sourceText, doc().project, candidate),
    };
  };

  const buttonsRow = createMemo(() => headerButtons(vp().w));

  const statusLine = (): string => {
    const e = editor();
    const m = currentMap(e);
    const dirty = e.dirty ? "*" : "";
    const mode = svc ? "PTR" : "PAD";
    const sel = eventMode()
      ? e.selectedEventId ?? "NO EVENT"
      : passMode()
        ? PASS_TOOL_LABELS[passTool()]
        : e.tile ?? "ERASE";
    const h = hover();
    const pos = h ? ` ${h.x},${h.y}` : "";
    const layer = eventMode() ? "EVENTS" : passMode() ? "PASS" : e.layer.toUpperCase();
    const pick = pendingPick() ? " | PICK TARGET" : "";
    const selectedStart = playStartCell();
    const start = selectedStart?.mapId === m.id ? ` | START ${selectedStart.x},${selectedStart.y}` : "";
    return `${mode} | ${doc().id}${dirty} | ${m.id} ${m.width}x${m.height} | ${layer} | ${sel}${pos}${start}${pick} | ${notice().text}`;
  };

  return (
    <View class="w-full h-full" style={{ bgColor: "#10131b" }} debugName="editor-root">
      {playProject() && playAssets() ? (
        <PlaytestSurface
          project={playProject()!}
          assets={playAssets()!}
          carry={carryPrevious() ? lastPlayCarry() : null}
          width={vp().w}
          height={vp().h}
          debugOpen={playDebug()}
          tab={playTab()}
          page={playPage()}
          issues={playIssues()}
          onState={(state) => setPlayState(state)}
          onPort={(port) => {
            playPort = port;
          }}
        />
      ) : (
        <>
      <View
        class="absolute flex-row items-center"
        style={{ posType: 1, insetL: 0, insetT: 0, width: vp().w, height: HEADER_H, bgColor: "#1b2230" }}
        debugName="editor-header"
      >
        <For each={buttonsRow()}>
          {(b, i) => (
            <HeaderButton
              label={headerLabel(b.id, eventMode(), editor().layer, carryPrevious(), b.w)}
              x={b.x}
              w={b.w}
              focus={cursor().zone === "header" && cursor().button === i()}
              enabled={headerEnabled(b.id, editor(), hostFile())}
            />
          )}
        </For>
      </View>

      {inspectorOpen() && selectedEvent() ? (
        <View
          class="absolute"
          style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: vp().w, height: vp().h - HEADER_H }}
        >
          <EventInspector
            width={vp().w}
            height={vp().h - HEADER_H}
            event={selectedEvent()!}
            activePage={editor().selectedPageIndex}
            commandRows={commandRows()}
            selection={inspectorSelection()}
            focus={inspectorFocus()}
            inputBuffer={inputBuffer()}
            scroll={inspectorScroll()}
          />
        </View>
      ) : mapInspectorOpen() ? (
        <View
          class="absolute"
          style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: vp().w, height: vp().h - HEADER_H }}
        >
          <MapInspector
            width={vp().w}
            height={vp().h - HEADER_H}
            map={map()}
            references={deleteRefs()?.references ?? []}
            referencePage={mapReferencePage()}
            notice={notice()}
            focus={mapFocus()}
            inputBuffer={mapInput()}
          />
        </View>
      ) : (
        <>
          {banner() ? <Banner width={Math.max(0, vp().w - PAL_W)} /> : null}

          {eventMode() ? (
            <EventPanel
              selected={selectedEvent()}
              cursorTool={cursor().zone === "palette" ? cursor().slot : -1}
              panelH={vp().h - HEADER_H - STATUS_H}
            />
          ) : passMode() ? (
            <PassPanel
              selected={passTool()}
              cursorTool={cursor().zone === "palette" ? cursor().slot : -1}
              panelH={vp().h - HEADER_H - STATUS_H}
            />
          ) : (
            <PalettePanel
              thumbs={thumbs()}
              selectedSlot={selectedSlot() < 0 ? 0 : selectedSlot()}
              cursorSlot={cursor().zone === "palette" ? cursor().slot : -1}
              scrollY={palScroll()}
              panelH={vp().h - HEADER_H - STATUS_H}
            />
          )}

          <Canvas
            map={map()}
            upper={editor().upperDense[editor().mapIndex]!}
            passage={passageDense()}
            edges={cellEdges()}
            camX={cam().x}
            camY={cam().y}
            cols={viewCols()}
            rows={viewRows()}
            frame={fit().frame}
            texKey={texKey}
            events={markers()}
            eventMode={eventMode()}
            selectedEventId={editor().selectedEventId}
            dragPreview={dragPreview()}
            hover={hover()}
            cursorZone={cursor().zone}
            cursor={cursor().zone === "canvas" ? { x: cursor().tx, y: cursor().ty } : { x: -99, y: -99 }}
          />

          <View
            class="absolute flex-row items-center"
            style={{
              posType: 1,
              insetL: 0,
              insetT: vp().h - STATUS_H,
              width: vp().w,
              height: STATUS_H,
              bgColor: "#1b2230",
            }}
            debugName="editor-status"
          >
            <Text
              class="text-xs"
              style={{
                insetL: 4,
                textColor: notice().kind === "bad" ? BAD : notice().kind === "good" ? GOOD : DIM,
                lineHeight: 12,
                height: 12,
              }}
            >
              {statusLine()}
            </Text>
          </View>
        </>
      )}
        </>
      )}
    </View>
  );
}

function headerLabel(
  id: (typeof HEADER_ORDER)[number],
  eventMode: boolean,
  layer: EditorState["layer"],
  carryPrevious: boolean,
  width: number,
): string {
  if (id === "layer") return eventMode ? "EVENT" : layer === "ground" ? "GROUND" : layer === "upper" ? "UPPER" : "PASS";
  if (id === "doc") return "DOC";
  if (id === "mapprev") return "<";
  if (id === "mapnext") return ">";
  if (id === "map") return "MAP";
  if (id === "play") return "PLAY";
  if (id === "state") return width < 36 ? (carryPrevious ? "L" : "F") : carryPrevious ? "STATE LAST" : "STATE FRESH";
  if (id === "undo") return "UNDO";
  if (id === "redo") return "REDO";
  return "SAVE";
}

function headerEnabled(id: (typeof HEADER_ORDER)[number], e: EditorState, hostFile: boolean): boolean {
  if (id === "doc") return !hostFile;
  if (id === "undo") return canUndo(e);
  if (id === "redo") return canRedo(e);
  return true;
}

function sameTiles(a: TileId[], b: TileId[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
