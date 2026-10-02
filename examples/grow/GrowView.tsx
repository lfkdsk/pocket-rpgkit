// examples/grow/GrowView.tsx — D6 rightward rule-grown settlement.
//
// The camera follows the advancing road across grass, mud, sand and snow.
// Rendering is a bounded tile window: only columns intersecting the live
// viewport plus one overscan column mount. A wider/longer world therefore
// never leaves its history resident in the native scene graph.

import { batch, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, detachNode, insertNode, setProp } from "@pocketjs/framework/renderer";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { touches, BTN } from "@pocketjs/framework/input";
import { followCamera } from "../../src/engine/camera.ts";
import { deepClone } from "../../src/engine/clone.ts";
import {
  biomeAt, biomeBoundaryX, biomeTransitionKind, cameraXForState, createGrow, DEFAULT_PARAMS, naturalStampAt, warmWilderness, wildernessTileAt,
  growStateHash, liveFrameAtTick, rememberGrowGridHash,
  type GrowParams, type GrowState,
} from "./grow.ts";
import { GrowTimeline } from "./grow-timeline.ts";
import { growProject } from "./grow-project.ts";
import { AttractController } from "../../src/engine/attract.ts";
import { modalChanged, type Modal } from "../../src/engine/interpreter.ts";
import { walkPose, type WalkPose } from "../../src/engine/movement.ts";
import { centerOffset } from "../../src/engine/viewport.ts";
import type { Facing, Project } from "../../src/engine/types.ts";
import { PlayerSprite } from "../../src/ui/PlayerSprite.tsx";
import { DialogBox } from "../../src/ui/DialogBox.tsx";
import { GROW_CARAVAN, GROW_GROUND, GROW_NPC, GROW_PLAYER, GROW_SIM_GROUND, GROW_SIM_UPPER, GROW_TERRAIN, GROW_TERRAIN_BLOCK, GROW_UPPER } from "./assets-grow.ts";
import {
  causalTotalTicks, describeEvent, eventsNear, latestMajorEvent, MAJOR_EVENTS, SEASON_NAMES, seasonAt,
  type GrowEvent, type GrowEventKind,
} from "./grow-causal.ts";

const TILE = 16;
const PSP_W = 480;
const PSP_H = 272;
const TIMELINE_H = 16;
const AUTHORED_WORLD_H = DEFAULT_PARAMS.height * TILE;
const OVERSCAN = 1;
const NEXT_SEED = 0x9e37_79b9;
const STAMP_TOTAL_TICKS = 156;
const totalFor = (p: GrowParams): number => p.causal ? causalTotalTicks(p) : STAMP_TOTAL_TICKS;
// Timeline recording, then the wilderness warm-up, run ahead of the live
// growth one bounded slice per frame, so a scrub soon after launch or SQUARE
// finds both ready: the stamp timeline in 20 frames, the causal one (each
// tick simulates every village) in 240, one tick per frame so the recording
// stays inside a 60 Hz frame budget, its wilderness in about 20 more.
const prefillTicksFor = (p: GrowParams): number => p.causal ? 1 : 8;
const CAPTION_H = 13;
/** Timeline marker color by event family. */
const MARKER_COLOR: Partial<Record<GrowEventKind, string>> = {
  founded: "#ffe97a", "trade-opened": "#6fd3ff", "trade-road": "#6fd3ff", market: "#6fd3ff",
  "first-road": "#e0b070", paved: "#e0b070", bridge: "#e0b070",
  "poor-harvest": "#ff7a5c", famine: "#ff4a3a", cold: "#ff9ac0", drought: "#ff5a2a", exodus: "#ff4a3a", "forest-cleared": "#ff7a5c",
  abandoned: "#b0b0c0", "trade-lapsed": "#7a8aa0", intervention: "#c78bff",
};
interface Marker { x: number; color: string }
const WARM_COLUMNS_PER_FRAME = 8;
const TERRAIN_BLOCK_TILES = 16;
const CELL_CLASS = "absolute w-[16] h-[16]";

type Mode = "grow" | "play";
interface OverlayCell { key: string; x: number; y: number; src: string; w?: number; h?: number }
interface Viewport { w: number; h: number }
interface TileBounds { x0: number; x1: number; y0: number; y1: number }

interface CellStyle { posType: number; insetL: number; insetT: number }
/** One image node at tile (x, y) of its layer. */
interface MountedCell { node: NodeMirror; src: string; x: number; y: number; style: CellStyle }

/** Inline position of an image at tile (x, y); its class sizes it. */
function cellStyle(x: number, y: number): CellStyle {
  return { posType: 1, insetL: x * TILE, insetT: y * TILE };
}

/**
 * The image nodes of one cell layer. Without recycling, a cell leaving
 * the layer detaches its node and an arriving cell creates one; auto-growth
 * works that way while the camera scrolls. A timeline jump can replace every
 * visible cell in one frame, so while scrubbing a departing node is handed to
 * an arriving cell instead (new insets, maybe a new texture). Nodes still
 * unclaimed when the sync ends stay attached with no texture for the next
 * jump. Nodes are created only when none is spare or idle, so the pool
 * never holds more than the most cells the layer has shown at once.
 */
class CellNodes {
  readonly #root: NodeMirror;
  readonly #name: string;
  readonly #idleName: string;
  readonly #klass: string;
  // Released during the current sync; still attached and showing old art.
  readonly #spare: MountedCell[] = [];
  // Attached with the texture cleared, waiting for a later sync.
  readonly #idle: MountedCell[] = [];
  #recycling = false;

  constructor(root: NodeMirror, name: string, klass: string) {
    this.#root = root;
    this.#name = name;
    this.#idleName = `${name}-idle`;
    this.#klass = klass;
  }

  begin(recycling: boolean): void { this.#recycling = recycling; }

  release(cell: MountedCell): void {
    if (this.#recycling) this.#spare.push(cell);
    else detachNode(this.#root, cell.node);
  }

  place(x: number, y: number, src: string): MountedCell {
    const spare = this.#spare.pop();
    const idle = spare ? undefined : this.#idle.pop();
    const reused = spare ?? idle;
    if (reused) {
      this.move(reused, x, y);
      this.setSrc(reused, src);
      if (idle) setProp(reused.node, "debugName", this.#name);
      return reused;
    }
    const node = createElement("image");
    const style = cellStyle(x, y);
    setProp(node, "class", this.#klass);
    setProp(node, "style", style);
    setProp(node, "src", src);
    setProp(node, "debugName", this.#name);
    insertNode(this.#root, node);
    return { node, src, x, y, style };
  }

  move(cell: MountedCell, x: number, y: number): void {
    if (cell.x === x && cell.y === y) return;
    const style = cellStyle(x, y);
    setProp(cell.node, "style", style, cell.style);
    cell.style = style; cell.x = x; cell.y = y;
  }

  setSrc(cell: MountedCell, src: string): void {
    if (cell.src === src) return;
    setProp(cell.node, "src", src, cell.src);
    cell.src = src;
  }

  end(): void {
    for (const cell of this.#spare) this.#retire(cell);
    this.#spare.length = 0;
    this.#recycling = false;
  }

  #retire(cell: MountedCell): void {
    if (!this.#recycling) { detachNode(this.#root, cell.node); return; }
    this.setSrc(cell, "");
    setProp(cell.node, "debugName", this.#idleName);
    this.#idle.push(cell);
  }

  /** Detach every pooled node (the caller detaches its mounted cells). */
  clear(): void {
    for (const cell of this.#spare) detachNode(this.#root, cell.node);
    for (const cell of this.#idle) detachNode(this.#root, cell.node);
    this.#spare.length = 0;
    this.#idle.length = 0;
  }
}

function layerRoot(name: string, width: number, height: number): NodeMirror {
  const root = createElement("view");
  setProp(root, "style", { posType: 1, insetL: 0, insetT: 0, width, height });
  setProp(root, "debugName", name);
  return root;
}

function SparseGridLayer(props: {
  state: () => GrowState;
  bounds: () => TileBounds;
  rowOffset: () => number;
  renderedRows: () => number;
  mode: () => Mode;
  timeline: () => GrowTimeline;
  layer: "ground" | "upper";
  /** Hand departing cell nodes to arriving cells (timeline scrubbing). */
  recycle: () => boolean;
  onMounted: (count: number) => void;
}) {
  const root = layerRoot(`rpgkit-grow-${props.layer}-layer`,
    props.state().params.width * TILE, props.renderedRows() * TILE);
  const pool = new CellNodes(root, `rpgkit-grow-${props.layer === "ground" ? "gcell" : "ucell"}`, CELL_CLASS);
  const nodes = new Map<number, MountedCell>();
  const changed: number[] = [];
  let previous: { seed: number; tick: number; mode: Mode; offset: number; bounds: TileBounds } | undefined;

  const sourceAt = (s: GrowState, x: number, y: number, offset: number): string | undefined => {
    const authoredY = y - offset;
    if (props.layer === "ground") {
      if (authoredY < 0 || authoredY >= s.params.height) return undefined;
      const cell = s.ground[authoredY * s.params.width + x]!;
      return cell < 0 ? undefined : GROW_GROUND[cell] ?? GROW_SIM_GROUND[cell];
    }
    const grown = authoredY >= 0 && authoredY < s.params.height
      ? s.upper[authoredY * s.params.width + x]!
      : -1;
    const wrappedY = ((authoredY % s.params.height) + s.params.height) % s.params.height;
    const cell = grown >= 0 ? grown : wildernessTileAt(s, x, wrappedY);
    return GROW_UPPER[cell] ?? GROW_SIM_UPPER[cell];
  };

  const inside = (b: TileBounds, x: number, y: number): boolean =>
    x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const syncCell = (s: GrowState, b: TileBounds, offset: number, x: number, y: number): void => {
    if (!inside(b, x, y)) return;
    const key = y * s.params.width + x;
    const src = sourceAt(s, x, y, offset);
    const mounted = nodes.get(key);
    if (!src) {
      if (mounted) { nodes.delete(key); pool.release(mounted); }
      return;
    }
    if (mounted) pool.setSrc(mounted, src);
    else nodes.set(key, pool.place(x, y, src));
  };
  const syncAll = (s: GrowState, b: TileBounds, offset: number): void => {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) syncCell(s, b, offset, x, y);
  };
  // Every rendered row that shows authored row `authoredY`: ground cells
  // exist only on the authored rows, upper wilderness repeats outside them.
  const syncAuthored = (s: GrowState, b: TileBounds, offset: number, x: number, authoredY: number): void => {
    if (props.layer === "ground") { syncCell(s, b, offset, x, authoredY + offset); return; }
    const h = s.params.height;
    for (let y = b.y0 + ((((authoredY + offset - b.y0) % h) + h) % h); y <= b.y1; y += h) syncCell(s, b, offset, x, y);
  };
  const sync = (): void => {
    const s = props.state();
    const b = props.bounds();
    const offset = props.rowOffset();
    const mode = props.mode();
    if (previous && previous.seed === s.params.seed && previous.tick === s.tick
      && previous.mode === mode && previous.offset === offset
      && previous.bounds.x0 === b.x0 && previous.bounds.x1 === b.x1
      && previous.bounds.y0 === b.y0 && previous.bounds.y1 === b.y1) return;

    const reset = !previous || previous.seed !== s.params.seed
      || previous.mode !== mode || previous.offset !== offset;
    if (reset) pool.clear();
    pool.begin(!reset && props.recycle());
    for (const [key, mounted] of nodes) {
      if (reset || mounted.x < b.x0 || mounted.x > b.x1 || mounted.y < b.y0 || mounted.y > b.y1) {
        nodes.delete(key);
        pool.release(mounted);
      }
    }

    if (reset) {
      syncAll(s, b, offset);
    } else if (previous) {
      // Only cells visible before and after keep their nodes as they are.
      const kept: TileBounds = {
        x0: Math.max(b.x0, previous.bounds.x0), x1: Math.min(b.x1, previous.bounds.x1),
        y0: Math.max(b.y0, previous.bounds.y0), y1: Math.min(b.y1, previous.bounds.y1),
      };
      const overlap = kept.x0 <= kept.x1 && kept.y0 <= kept.y1;
      // A camera move evaluates only newly visible rows/columns. Existing
      // cells keep their nodes and texture bindings.
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
        if (!inside(previous.bounds, x, y)) syncCell(s, b, offset, x, y);
      }
      // A timeline jump re-evaluates the cells whose authored layers changed
      // between the two ticks, in either direction, each cell once however
      // many ticks it changed in. Only kept cells can be stale; the loop
      // above just evaluated every newly visible one.
      if (s.tick !== previous.tick && mode === "grow" && overlap) {
        const layers = props.layer === "ground" ? "ground" : "ground+upper";
        if (!props.timeline().changedCells(previous.tick, s.tick, layers, changed)) {
          syncAll(s, kept, offset);
        } else {
          const w = s.params.width;
          // Natural stamps are at most two cells wide, so an edit more than
          // one column outside the kept window cannot reach one of its cells.
          const x0 = kept.x0 - 1, x1 = kept.x1 + 1;
          for (let i = 0; i < changed.length; i++) {
            const index = changed[i]!;
            const x = index % w;
            if (x < x0 || x > x1) continue;
            const authoredY = (index - x) / w;
            syncAuthored(s, kept, offset, x, authoredY);
            // One edited tile can clear a complete natural stamp silhouette.
            // Refresh those art neighbors without changing timeline storage.
            if (props.layer === "upper") {
              const whole = naturalStampAt(s.params, x, authoredY);
              if (whole) {
                for (let dy = 0; dy < whole.h; dy++) for (let dx = 0; dx < whole.w; dx++) {
                  syncAuthored(s, kept, offset, whole.x + dx, whole.y + dy);
                }
              }
            }
          }
        }
      }
    }
    pool.end();
    previous = { seed: s.params.seed, tick: s.tick, mode, offset, bounds: { ...b } };
    props.onMounted(nodes.size);
  };

  sync();
  onFrame(sync);
  onCleanup(() => {
    for (const mounted of nodes.values()) detachNode(root, mounted.node);
    nodes.clear();
    pool.clear();
  });
  return root as unknown as ReturnType<typeof View>;
}

/** A keyed list of overlay images (terrain blocks and seams, villagers). */
function OverlayCellLayer(props: {
  cells: () => readonly OverlayCell[];
  name: string;
  cellName: string;
  /** Utility class that sizes each image. */
  klass: string;
  width: number;
  height: number;
  recycle: () => boolean;
}) {
  const root = layerRoot(props.name, props.width, props.height);
  const pool = new CellNodes(root, props.cellName, props.klass);
  const nodes = new Map<string, MountedCell>();
  let shown: readonly OverlayCell[] | undefined;
  const sync = (): void => {
    const cells = props.cells();
    if (cells === shown) return;
    shown = cells;
    const wanted = new Map<string, OverlayCell>();
    for (const cell of cells) wanted.set(cell.key, cell);
    pool.begin(props.recycle());
    for (const [key, mounted] of nodes) {
      if (!wanted.has(key)) { nodes.delete(key); pool.release(mounted); }
    }
    for (const cell of cells) {
      const mounted = nodes.get(cell.key);
      if (!mounted) { nodes.set(cell.key, pool.place(cell.x, cell.y, cell.src)); continue; }
      pool.move(mounted, cell.x, cell.y);
      pool.setSrc(mounted, cell.src);
    }
    pool.end();
  };
  sync();
  onFrame(sync);
  onCleanup(() => {
    for (const mounted of nodes.values()) detachNode(root, mounted.node);
    nodes.clear();
    pool.clear();
  });
  return root as unknown as ReturnType<typeof View>;
}

declare global {
  // eslint-disable-next-line no-var
  var __rpgGrowState: {
    mode: Mode; tick: number; total: number; auto: boolean; seed: number; hash: string;
    cameraX: number; frontierX: number; mounted: number; visibleX0: number; visibleX1: number;
    scrub?: { seekCount: number; timelineStepCalls: number; timelineSeeks: number };
    /** Causal rules: recorded events, timeline markers, the caption and a picked place. */
    events?: number; markers?: number; caption?: string; focusX?: number; caravans?: number;
    here?: { x: number; y: number; lines: string[] };
    /** Play mode: the camera over the generated map. */
    play?: { cameraX: number; cameraY: number };
  } | undefined;
  // eslint-disable-next-line no-var
  var __rpgSessionState: import("../../src/engine/session.ts").SessionState | undefined;
}

function PlayLayer(props: {
  project: Project; hz: number; viewport: () => Viewport;
  onCamera: (x: number, y: number) => void; onBack: () => void;
  onModal: (m: Modal | null) => void; onNotice: (n: number) => void;
}) {
  const project = props.project;
  const attract = new AttractController(project, [], { hz: props.hz, attractEnabled: false, onSelect: props.onBack });
  attract.startPlay();
  let state = attract.state;
  globalThis.__rpgSessionState = state;
  const map = project.maps[0]!;
  const worldW = map.width * TILE;
  const npcIds = (map.events ?? []).filter((e) => e.id.startsWith("villager-")).map((e) => e.id);
  const authored = new Map((map.events ?? []).map((e) => [e.id, { x: e.x * TILE, y: e.y * TILE }]));
  const [pose, setPose] = createSignal<WalkPose>(0);
  const [facing, setFacing] = createSignal<Facing>(0);
  let modal: Modal | null = null;
  let playerRef: NodeMirror | undefined;
  const npcPosition = npcIds.map((id) => createSignal(authored.get(id)!));
  const positionOf = (id: string, index: number, st = state): { x: number; y: number } => {
    const live = st.chars.chars[id];
    return live ? { x: live.px, y: live.py } : authored.get(id)!;
  };
  const idsInWindow = (st: typeof state, cameraX: number, cameraY: number): string[] => {
    const vp = props.viewport();
    return npcIds.filter((id, i) => {
      const p = positionOf(id, i, st);
      return p.x >= cameraX - TILE && p.x <= cameraX + vp.w + TILE
        && p.y >= cameraY - TILE && p.y <= cameraY + vp.h + TILE;
    });
  };
  const [visibleNpcIds, setVisibleNpcIds] = createSignal(idsInWindow(state, 0, 0));
  let jumpBatch: JumpBatch | undefined;
  onMount(() => {
    const entries: [NodeMirror, "translateX" | "translateY"][] = [];
    if (playerRef) entries.push([playerRef, "translateX"], [playerRef, "translateY"]);
    jumpBatch = createJumpBatch(entries);
    jumpBatch.set(0, state.move.px); jumpBatch.set(1, state.move.py);
    jumpBatch.commit();
  });
  onFrame((buttons) => {
    const prev = state;
    const result = attract.step(buttons);
    state = result.state;
    globalThis.__rpgSessionState = state;
    const vp = props.viewport();
    const cam = followCamera(state.move.px, state.move.py, TILE, state.move.facing, {
      worldW: Math.max(worldW, vp.w), worldH: Math.max(AUTHORED_WORLD_H, vp.h),
    });
    // followCamera uses the portable 480x272 focus constants. Adjust the
    // target by half the live viewport delta while retaining the proven
    // camera clamp and center behavior.
    const cameraX = Math.max(0, Math.min(worldW - vp.w, cam.x - (vp.w - PSP_W) / 2));
    const cameraY = Math.max(0, cam.y - (vp.h - PSP_H) / 2);
    props.onCamera(cameraX, cameraY);
    let moved = false;
    if (state.move.px !== prev.move.px || state.move.py !== prev.move.py) {
      jumpBatch?.set(0, state.move.px); jumpBatch?.set(1, state.move.py); moved = true;
    }
    for (let i = 0; i < npcIds.length; i++) {
      const id = npcIds[i]!; const a = prev.chars.chars[id]; const b = state.chars.chars[id];
      const fallback = authored.get(id)!;
      const ax = a?.px ?? fallback.x, ay = a?.py ?? fallback.y;
      const bx = b?.px ?? fallback.x, by = b?.py ?? fallback.y;
      if (ax !== bx || ay !== by) npcPosition[i]![1]({ x: bx, y: by });
    }
    if (moved || result.status.rewound) jumpBatch?.commit();
    const visible = idsInWindow(state, cameraX, cameraY);
    if (visible.length !== visibleNpcIds().length || visible.some((id, i) => id !== visibleNpcIds()[i])) {
      setVisibleNpcIds(visible);
    }
    batch(() => {
      const p = walkPose(state.move.phase); if (p !== pose()) setPose(p);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (modalChanged(modal, state.interp.modal)) modal = deepClone(state.interp.modal);
      props.onModal(modal); props.onNotice(result.status.rewindNotice);
    });
  });
  return <>
    <For each={visibleNpcIds()}>{(id) => {
      const i = npcIds.indexOf(id);
      return <Image src={GROW_NPC.villager} class="absolute w-[16] h-[16]" style={{ posType: 1, insetL: npcPosition[i]![0]().x, insetT: npcPosition[i]![0]().y }} debugName="rpgkit-grow-npc" />;
    }}</For>
    <PlayerSprite pose={pose()} facing={facing()} frames={GROW_PLAYER} ref={(n) => { playerRef = n; }} />
  </>;
}

export function GrowView() {
  const hz = simulationHz();
  const initialViewport = hostViewport(getOps());
  const [viewport, setViewport] = createSignal<Viewport>(initialViewport ? { ...initialViewport } : { w: PSP_W, h: PSP_H });
  let grow = createGrow(DEFAULT_PARAMS);
  let params: GrowParams = grow.params;
  let timeline = new GrowTimeline(params, grow);
  let total = totalFor(params);
  let auto = true;
  let mode: Mode = "grow";
  let mounted = 0;
  let growHash = timeline.hash(grow);
  let seekCount = 0;
  let scrubActive = false;
  // Columns below this have settled wilderness caches for the current seed.
  let warmedTo = 0;
  let groundMounted = 0;
  let upperMounted = 0;
  const [g, setG] = createSignal(grow, { equals: (a, b) =>
    a.tick === b.tick && a.cameraX === b.cameraX && a.params.seed === b.params.seed
  });
  const [modeSig, setModeSig] = createSignal<Mode>("grow");
  const [autoSig, setAutoSig] = createSignal(true);
  const [seedSig, setSeedSig] = createSignal(params.seed);
  const [playEpoch, setPlayEpoch] = createSignal(0);
  const [playDone, setPlayDone] = createSignal(grow);
  const [playProject, setPlayProject] = createSignal<Project>();
  const [playModal, setPlayModal] = createSignal<Modal | null>(null);
  const [playNotice, setPlayNotice] = createSignal(0);
  const [playCamX, setPlayCamX] = createSignal(0);
  const [playCamY, setPlayCamY] = createSignal(0);
  const itemCache = new Map<string, OverlayCell>();
  // Causal history: the whole record once the timeline is complete, an
  // event picked with UP/DOWN (its place holds the camera), a place picked
  // by pointer, and the timeline markers.
  const [history, setHistory] = createSignal<readonly GrowEvent[]>([]);
  const [picked, setPicked] = createSignal<GrowEvent>();
  const [focusX, setFocusX] = createSignal<number>();
  const [here, setHere] = createSignal<{ x: number; y: number }>();

  const fieldH = () => Math.max(TILE, viewport().h - (modeSig() === "grow" ? TIMELINE_H : 0));
  const activeWidthTiles = () => modeSig() === "play" ? playProject()!.maps[0]!.width : params.width;
  const renderedRows = () => modeSig() === "grow" ? Math.max(params.height, Math.ceil(fieldH() / TILE)) : params.height;
  const renderedWorldH = () => renderedRows() * TILE;
  const authoredRowOffset = () => modeSig() === "grow" ? Math.floor((renderedRows() - params.height) / 2) : 0;
  const activeWorldSize = () => ({ w: activeWidthTiles() * TILE, h: renderedWorldH() });
  const growCamY = () => fieldH() < AUTHORED_WORLD_H ? Math.floor((AUTHORED_WORLD_H - fieldH()) / 2) : 0;
  const cameraLead = () => modeSig() === "grow" ? Math.max(params.cameraLeadPx, viewport().w * 0.6) : params.cameraLeadPx;
  const cameraX = () => modeSig() === "grow" ? g().cameraX : playCamX();
  const cameraY = () => modeSig() === "grow" ? growCamY() : playCamY();
  const growCameraX = () => {
    const focus = focusX();
    if (focus !== undefined) return Math.max(0, Math.min(params.width * TILE - viewport().w, focus * TILE + TILE / 2 - Math.floor(viewport().w / 2)));
    return Math.max(0, g().cameraX + params.cameraLeadPx - cameraLead());
  };
  const visibleBounds = createMemo(() => {
    const vp = viewport();
    const presentedCameraX = modeSig() === "grow"
      ? growCameraX()
      : cameraX();
    const x0 = Math.max(0, Math.floor(presentedCameraX / TILE) - OVERSCAN);
    const x1 = Math.min(activeWidthTiles() - 1, Math.floor((presentedCameraX + vp.w - 1) / TILE) + OVERSCAN);
    const y0 = Math.max(0, Math.floor(cameraY() / TILE) - OVERSCAN);
    const y1 = Math.min(renderedRows() - 1, Math.floor((cameraY() + fieldH() - 1) / TILE) + OVERSCAN);
    return { x0, x1, y0, y1 };
  }, undefined, { equals: (a, b) => a?.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1 });
  const publish = () => {
    const b = visibleBounds();
    const timelineStats = timeline.stats();
    globalThis.__rpgGrowState = {
      mode, tick: grow.tick, total, auto, seed: params.seed, hash: growHash, cameraX: grow.cameraX,
      frontierX: grow.roadFrontierX, mounted, visibleX0: b.x0, visibleX1: b.x1,
      ...(scrubActive ? { scrub: { seekCount, timelineStepCalls: timelineStats.stepCalls, timelineSeeks: timelineStats.seeks } } : {}),
      ...(mode === "play" ? { play: { cameraX: playCamX(), cameraY: playCamY() } } : {}),
      ...(grow.sim ? {
        events: grow.sim.events.length, markers: markers().length, caption: caption(),
        caravans: visibleVillagers().filter((c) => c.src === GROW_CARAVAN).length,
        ...(focusX() !== undefined ? { focusX: focusX() } : {}),
        ...(here() ? { here: { ...here()!, lines: hereLines() } } : {}),
      } : {}),
    };
  };

  // Paused on the timeline (a scrub, or a finished growth): cell layers hand
  // departing nodes to arriving cells instead of destroying and creating them.
  const scrubbing = () => mode === "grow" && !auto;
  const itemFor = (key: string, x: number, y: number, src: string): OverlayCell => {
    const old = itemCache.get(key);
    if (old?.src === src) return old;
    const next = { key, x, y, src }; itemCache.set(key, next); return next;
  };
  const active = () => modeSig() === "play" ? playDone() : g();
  const visiblePeople = createMemo(active, undefined, { equals: (a, b) =>
    a?.villagers === b.villagers && a.params === b.params
  });
  const terrainBlocks = (): OverlayCell[] => {
    const { x0, x1, y0, y1 } = visibleBounds();
    const out: OverlayCell[] = [];
    const bx0 = Math.floor(x0 / TERRAIN_BLOCK_TILES);
    const bx1 = Math.floor(x1 / TERRAIN_BLOCK_TILES);
    const by0 = Math.floor(y0 / TERRAIN_BLOCK_TILES);
    const by1 = Math.floor(y1 / TERRAIN_BLOCK_TILES);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const x = bx * TERRAIN_BLOCK_TILES;
      // Default biome bands are two blocks wide. Jagged boundary cells are
      // painted by terrainSeams over this rectangular fill.
      const biome = Math.floor(x / params.biomeBandWidth) % 4;
      out.push(itemFor(`tb:${bx}:${by}`, x, by * TERRAIN_BLOCK_TILES, GROW_TERRAIN_BLOCK[biome]!));
    }
    return out;
  };
  const terrainSeams = (): OverlayCell[] => {
    seedSig();
    const { x0, x1, y0, y1 } = visibleBounds(); const out: OverlayCell[] = [];
    const firstBoundary = Math.max(1, Math.floor((x0 - 2) / params.biomeBandWidth));
    const lastBoundary = Math.ceil((x1 + 2) / params.biomeBandWidth);
    for (let boundary = firstBoundary; boundary <= lastBoundary; boundary++) for (let y = y0; y <= y1; y++) {
      const authoredY = ((y - authoredRowOffset()) % params.height + params.height) % params.height;
      const center = boundary * params.biomeBandWidth;
      const edge = biomeBoundaryX(params, boundary, authoredY);
      for (let x = Math.max(x0, Math.min(center, edge)); x <= Math.min(x1, Math.max(center, edge + 2)); x++) {
        const biome = biomeAt(params, x, authoredY);
        const kind = biomeTransitionKind(params, x, authoredY);
        const nominalBiome = Math.floor(x / params.biomeBandWidth) % 4;
        if (kind === "fill" && biome === nominalBiome) continue;
        out.push(itemFor(`ts:${x}:${y}`, x, y, GROW_TERRAIN[biome]![kind]));
      }
    }
    return out;
  };
  const villagerCells = (): OverlayCell[] => {
    if (modeSig() !== "grow") return [];
    const b = visibleBounds(), s = visiblePeople();
    const people = s.villagers.filter((v) => v.left === undefined && (!s.sim || s.houses[v.house]!.vacant === undefined)
      && v.x >= b.x0 && v.x <= b.x1 && v.y + authoredRowOffset() >= b.y0 && v.y + authoredRowOffset() <= b.y1)
      .map((v) => itemFor(`v:${v.house}`, v.x, v.y + authoredRowOffset(), GROW_NPC.villager));
    return [...people, ...caravanCells(b)];
  };
  /** One cart per open trade route, out and back once per two caravan periods. */
  const caravanCells = (b: TileBounds): OverlayCell[] => {
    const s = g();
    if (!s.sim || !s.params.causal) return [];
    const every = s.params.causal.caravanEvery;
    const span = Math.max(1, s.params.tickSeconds * hz);
    const frac = autoSig() ? Math.max(0, Math.min(0.999, (s.frame - liveFrameAtTick(s.params, hz, s.tick)) / span)) : 0;
    const out: OverlayCell[] = [];
    for (const link of s.sim.links) {
      // A cart is on the road only while a real caravan's round trip lasts.
      if (!link.active || link.cells.length < 2 || s.tick - link.lastCaravan >= every * 2) continue;
      const period = every * 2;
      const u = ((((s.tick - link.opened) % period) + period) % period + frac) / period;
      const along = u < 0.5 ? u * 2 : 2 - u * 2;
      const at = link.cells[Math.min(link.cells.length - 1, Math.floor(along * (link.cells.length - 1)))]!;
      const x = at % s.params.width, y = (at - x) / s.params.width + authoredRowOffset();
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      out.push({ key: `c:${link.a}-${link.b}`, x, y, src: GROW_CARAVAN });
    }
    return out;
  };
  const visibleTerrainBlocks = createMemo(terrainBlocks);
  const visibleTerrainSeams = createMemo(terrainSeams);
  const visibleVillagers = createMemo(villagerCells, undefined, { equals: (a, b) => a.length === b.length && a.every((c, i) => c === b[i] || (c.key === b[i]!.key && c.x === b[i]!.x && c.y === b[i]!.y)) });
  const refreshMounted = () => { mounted = visibleTerrainBlocks().length + visibleTerrainSeams().length + groundMounted + upperMounted + visibleVillagers().length; };
  const pruneItemCache = () => {
    const b = visibleBounds();
    for (const [key, cell] of itemCache) {
      if (cell.x < b.x0 || cell.x > b.x1 || cell.y < b.y0 || cell.y > b.y1) itemCache.delete(key);
    }
  };
  const yearOf = (tick: number) => `Y${Math.floor(Math.max(0, tick - 1) / ((params.causal?.seasonTicks ?? 12) * 4)) + 1} ${SEASON_NAMES[seasonAt(params, Math.max(1, tick))]}`;
  const caption = (): string => {
    const s = g();
    if (!s.sim) return "";
    // A held camera narrates its own place; otherwise the whole world.
    const focus = focusX();
    const b = visibleBounds();
    const e = picked() ?? (focus === undefined
      ? latestMajorEvent(s, s.tick, b.x0, b.x1) ?? latestMajorEvent(s)
      : latestMajorEvent(s, s.tick, focus - 20, focus + 20));
    return e ? `${yearOf(e.tick)}  ${describeEvent(s, e)}` : `${yearOf(s.tick)}  UNSETTLED LAND`;
  };
  const hereLines = (): string[] => {
    const at = here(), s = g();
    if (!at || !s.sim) return [];
    const near = eventsNear(s, at.x, at.y, 3);
    if (!near.length) return ["NOTHING HAS HAPPENED HERE YET"];
    return near.slice(-3).reverse().map((e) => `${yearOf(e.tick)} ${describeEvent(s, e)}`);
  };
  const majorHistory = createMemo(() => history().filter((e) => MAJOR_EVENTS.has(e.kind)));
  const markers = createMemo((): Marker[] => {
    const w = viewport().w;
    const byX = new Map<number, Marker>();
    if (total <= 0) return [];
    for (const e of majorHistory()) {
      const x = Math.min(w - 2, Math.max(0, Math.round((e.tick / total) * w) - 1));
      if (!byX.has(x)) byX.set(x, { x, color: MARKER_COLOR[e.kind] ?? "#ffffff" });
    }
    return [...byX.values()];
  });
  /** UP/DOWN: step to the previous/next recorded major event and look at it. */
  const stepEvent = (dir: -1 | 1) => {
    const list = majorHistory();
    if (!list.length) return;
    const current = picked();
    let index = current ? list.indexOf(current) : -1;
    if (index < 0) {
      // From the playhead: the last event at or before it, or the first after.
      index = -1;
      for (let i = 0; i < list.length; i++) if (list[i]!.tick <= grow.tick) index = i;
      index = dir < 0 ? index : index + 1;
      if (dir < 0 && current === undefined && index >= 0 && list[index]!.tick === grow.tick) index--;
    } else index += dir;
    const next = list[Math.max(0, Math.min(list.length - 1, index))]!;
    seekTo(next.tick);
    batch(() => { setPicked(next); setFocusX(next.x); setHere(undefined); });
    publish();
  };
  const clearPick = () => batch(() => { setPicked(undefined); setFocusX(undefined); });
  const syncProject = () => { const done = grow.phase === "done" ? grow : timeline.done(); setPlayDone(done); setPlayProject(growProject(done)); };
  const seekTo = (tick: number) => {
    if (mode !== "grow") return;
    scrubActive = true; seekCount++;
    const k = Math.max(0, Math.min(total, Math.round(tick)));
    const canonicalFrame = liveFrameAtTick(params, hz, k);
    if (k === grow.tick && !auto && grow.frame === canonicalFrame && grow.cameraX === grow.cameraFromX) return;
    const cached = timeline.at(k, grow); growHash = timeline.hash(cached);
    grow = { ...cached, hz, frame: canonicalFrame };
    auto = false; batch(() => { setG(grow); setAutoSig(false); }); refreshMounted(); publish();
  };
  const advanceLiveFrame = (): GrowState => {
    const nextFrame = grow.frame + 1;
    const period = grow.params.tickSeconds * hz;
    const due = grow.phase === "done" ? grow.tick : Math.max(0, Math.floor(nextFrame / period + 1e-9));
    const target = Math.min(due, timeline.furthestTick);
    let metadata = grow;
    for (let tick = grow.tick + 1; tick <= target; tick++) {
      const frame = timeline.frame(tick)!;
      for (const edit of frame.edits) {
        const grid = edit.layer === "ground" ? grow.ground : edit.layer === "upper" ? grow.upper : edit.layer === "road" ? grow.road : grow.wear!;
        grid[edit.index] = edit.after;
      }
      metadata = frame.state;
    }
    const next: GrowState = { ...metadata, ground: grow.ground, upper: grow.upper, road: grow.road,
      hz, frame: nextFrame, grew: target !== grow.tick };
    if (grow.wear) next.wear = grow.wear;
    next.cameraX = cameraXForState(next);
    const frame = timeline.frame(target);
    if (frame) rememberGrowGridHash(next, frame.gridHash);
    return next;
  };
  const changeSeed = () => {
    grow = createGrow({ ...params, seed: (params.seed + NEXT_SEED) >>> 0 }); params = grow.params; timeline = new GrowTimeline(params, grow); total = totalFor(params);
    batch(() => { setHistory([]); setPicked(undefined); setFocusX(undefined); setHere(undefined); }); growHash = timeline.hash(grow); auto = true; scrubActive = false; seekCount = 0; warmedTo = 0; itemCache.clear();
    batch(() => { setG(grow); setAutoSig(true); setSeedSig(params.seed); setPlayDone(grow); setPlayProject(undefined); setPlayCamX(0); setPlayCamY(0); }); refreshMounted(); publish();
  };
  const enterPlay = () => {
    if (grow.phase !== "done") return; mode = "play"; syncProject(); setPlayCamX(0); setPlayCamY(0); setPlayModal(null); setPlayNotice(0); setModeSig("play"); setPlayEpoch((e) => e + 1); refreshMounted(); publish();
  };
  const backToGrow = () => { mode = "grow"; setPlayModal(null); setPlayNotice(0); setModeSig("grow"); refreshMounted(); publish(); };

  let pointerDown = false;
  interface MouseLine { t: string; x: number | null; y: number | null; d: boolean }
  const mouseEvents: MouseLine[] = [];
  const stripTick = (x: number) => Math.round((Math.max(0, Math.min(viewport().w, x)) / viewport().w) * total);
  // A press on the map (not the strip) picks that place: the panel lists
  // what happened within three tiles of it up to the current tick.
  let mapPress = false, touchOnMap = false;
  const pickPlace = (px: number, py: number) => {
    if (!grow.sim) return;
    const x = Math.floor((px - worldX()) / TILE), y = Math.floor((py - worldY()) / TILE) - authoredRowOffset();
    if (x < 0 || x >= params.width || y < 0 || y >= params.height) return;
    batch(() => { setHere({ x, y }); setPicked(undefined); });
  };
  const pollPointer = (): number | undefined => {
    if (mode !== "grow") return undefined;
    const ops = getOps(); const lines = ops.svcPoll?.();
    if (lines) for (const line of lines.split("\n")) if (line) try { const m = JSON.parse(line) as MouseLine; if (m.t === "mouse") mouseEvents.push(m); } catch {}
    const y0 = viewport().h - TIMELINE_H;
    let pending: number | undefined;
    let mapContact: { x: number; y: number } | undefined;
    for (const c of touches()) { if (c.y >= y0) pending = stripTick(c.x); else mapContact = c; }
    if (mapContact && !touchOnMap) pickPlace(mapContact.x, mapContact.y);
    touchOnMap = mapContact !== undefined;
    for (const ev of mouseEvents.splice(0)) {
      if (ev.x === null || ev.y === null) { if (!ev.d) { pointerDown = false; mapPress = false; } continue; }
      if (ev.d && (ev.y >= y0 || pointerDown)) { pointerDown = true; pending = stripTick(ev.x); }
      else if (ev.d && !mapPress) { mapPress = true; pickPlace(ev.x, ev.y); }
      else if (!ev.d) { pointerDown = false; mapPress = false; }
    }
    return pending;
  };

  let prevButtons = 0, heldDir = 0, heldFrames = 0;
  onFrame((buttons) => {
    const nextVp = hostViewport(getOps());
    if (nextVp && (nextVp.w !== viewport().w || nextVp.h !== viewport().h)) setViewport({ ...nextVp });
    if (mode === "play") { refreshMounted(); publish(); prevButtons = buttons; return; }
    if (!timeline.complete) {
      // Per virtual second, not per frame: the markers appear at the same
      // virtual time at every rate.
      timeline.prefillTo(Math.min(total, timeline.furthestTick + Math.ceil(prefillTicksFor(params) * 60 / hz)));
      if (timeline.complete) {
        total = timeline.furthestTick;
        const last = timeline.snapshot(total)?.state;
        if (last?.sim) setHistory(last.sim.events);
      }
    } else if (warmedTo <= timeline.frontierX + Math.ceil(viewport().w / TILE) + OVERSCAN + 1) {
      // The camera never shows more than a viewport past the final frontier.
      warmWilderness(params, warmedTo, warmedTo + WARM_COLUMNS_PER_FRAME - 1);
      warmedTo += WARM_COLUMNS_PER_FRAME;
    }
    // Scrubbing keeps the camera on a place picked with UP/DOWN, so its
    // history can be watched; the caption follows the playhead again.
    const pointerTick = pollPointer(); if (pointerTick !== undefined) { setPicked(undefined); seekTo(pointerTick); }
    const pressed = buttons & ~prevButtons;
    let dir = 0; if (buttons & BTN.LEFT) dir = -1; else if (buttons & BTN.RIGHT) dir = 1;
    if (dir !== heldDir) { heldDir = dir; heldFrames = 0; if (dir) { setPicked(undefined); seekTo(grow.tick + dir); } }
    else if (dir && ++heldFrames > 12 && heldFrames % 4 === 0) seekTo(grow.tick + dir);
    if (pressed & BTN.UP) stepEvent(-1);
    if (pressed & BTN.DOWN) stepEvent(1);
    if (pressed & BTN.TRIANGLE) { clearPick(); auto = !auto; if (auto && grow.phase === "done") { grow = createGrow(params); growHash = timeline.hash(grow); itemCache.clear(); } batch(() => { setAutoSig(auto); setG(grow); }); }
    if (pressed & BTN.SQUARE) changeSeed();
    if ((pressed & BTN.CIRCLE) && grow.phase === "done") enterPlay();
    if (auto && grow.phase !== "done") {
      const before = grow.tick; grow = advanceLiveFrame();
      growHash = growStateHash(grow);
      // cameraX changes between action boundaries, so publish every frame.
      if (grow.tick !== before || grow.cameraX !== g().cameraX) setG(grow);
      if (grow.phase === "done") { auto = false; batch(() => { setG(grow); setAutoSig(false); }); }
    }
    refreshMounted(); pruneItemCache(); publish(); prevButtons = buttons;
  });

  const timelineFill = () => total ? (g().tick / total) * viewport().w : 0;
  /** Each founded village's name and people, over its plaza. */
  // One slot per band stays mounted (unfounded ones are blank), so a
  // timeline jump retitles labels instead of creating or destroying nodes.
  const townLabels = createMemo(() => {
    const s = g();
    if (!s.sim) return [];
    return Array.from({ length: Math.min(8, s.params.settlements) }, (_, id) => {
      const t = s.sim!.settlements[id];
      // A space, not "": an empty string would unmount the text node.
      if (!t) return { x: 0, y: 0, text: " ", color: "#e8eef8" };
      return {
        x: t.cx, y: t.cy + 1,
        text: t.status === "abandoned" ? `${t.name} (RUINS)` : `${t.name} ${t.pop}`,
        color: t.status === "abandoned" ? "#b0b0c0" : t.hunger >= 3 ? "#ff8a7a" : t.hunger > 0 ? "#ffd27a" : "#e8eef8",
      };
    });
  }, [], { equals: (a, b) => a.length === b.length && a.every((l, i) => l.text === b[i]!.text && l.color === b[i]!.color) });
  const seedHex = () => seedSig().toString(16).toUpperCase().padStart(8, "0");
  const worldOffset = () => centerOffset(activeWorldSize(), { w: viewport().w, h: fieldH() });
  const worldX = () => worldOffset().x - (modeSig() === "grow" ? growCameraX() : cameraX());
  const worldY = () => worldOffset().y - cameraY();

  return <View class="w-full h-full overflow-hidden bg-black">
    <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 0, insetT: 0, width: viewport().w, height: viewport().h }} debugName="rpgkit-grow-frame">
      <View class="absolute" style={{ posType: 1, insetL: worldX(), insetT: worldY() }} debugName="rpgkit-grow-camera">
        <OverlayCellLayer cells={visibleTerrainBlocks} name="rpgkit-grow-block-layer" cellName="rpgkit-grow-terrain-block" klass="absolute w-[256] h-[256]" width={params.width * TILE} height={renderedRows() * TILE} recycle={scrubbing} />
        <OverlayCellLayer cells={visibleTerrainSeams} name="rpgkit-grow-seam-layer" cellName="rpgkit-grow-terrain-seam" klass={CELL_CLASS} width={params.width * TILE} height={renderedRows() * TILE} recycle={scrubbing} />
        <SparseGridLayer state={active} bounds={visibleBounds} rowOffset={authoredRowOffset} renderedRows={renderedRows} mode={modeSig} timeline={() => timeline} layer="ground" recycle={scrubbing} onMounted={(count) => { groundMounted = count; refreshMounted(); publish(); }} />
        <OverlayCellLayer cells={visibleVillagers} name="rpgkit-grow-villager-layer" cellName="rpgkit-grow-gvillager" klass={CELL_CLASS} width={params.width * TILE} height={renderedRows() * TILE} recycle={scrubbing} />
        <Show when={playEpoch() > 0 && modeSig() === "play"} keyed>
          <PlayLayer project={playProject()!} hz={hz} viewport={viewport} onCamera={(x, y) => { setPlayCamX(x); setPlayCamY(y); }} onBack={backToGrow} onModal={setPlayModal} onNotice={setPlayNotice} />
        </Show>
        <SparseGridLayer state={active} bounds={visibleBounds} rowOffset={authoredRowOffset} renderedRows={renderedRows} mode={modeSig} timeline={() => timeline} layer="upper" recycle={scrubbing} onMounted={(count) => { upperMounted = count; refreshMounted(); publish(); }} />
        <Show when={modeSig() === "grow" && g().sim}>
          <Index each={townLabels()}>{(label) =>
            <View class="absolute flex-row justify-center" style={{ posType: 1, insetL: label().x * TILE + TILE / 2 - 56, insetT: (label().y + authoredRowOffset()) * TILE + 3, width: 112, height: 12 }} debugName="rpgkit-grow-town">
              <View style={{ bgColor: "#0b1626", opacity: label().text !== " " ? 0.72 : 0, height: 12 }}>
                <Text class="text-xs" style={{ textColor: label().color, lineHeight: 12, height: 12, insetL: 3, insetR: 3 }}>{label().text}</Text>
              </View>
            </View>
          }</Index>
          <Show when={here()}>
            <View class="absolute" style={{ posType: 1, insetL: here()!.x * TILE, insetT: (here()!.y + authoredRowOffset()) * TILE, width: TILE, height: TILE, bgColor: "#ffe97a", opacity: 0.5 }} debugName="rpgkit-grow-here-cell" />
          </Show>
        </Show>
      </View>
    </View>
    <Show when={modeSig() === "play"}>
      <DialogBox modal={playModal} legend={() => playModal() ? "next" : "talk"} />
      <Show when={playNotice() > 0}><View class="absolute flex-row justify-center" style={{ posType: 1, insetT: 40, insetL: 0, insetR: 0 }} debugName="rpgkit-grow-rewind"><Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>REWIND 3 SEC</Text></View></Show>
    </Show>
    <Show when={modeSig() === "grow"}>
      <View class="absolute" style={{ posType: 1, insetT: 4, insetL: 6, width: 164, height: 31, bgColor: "#0b1626", opacity: 0.84 }} debugName="rpgkit-grow-plate" />
      <Text class="text-xs" style={{ posType: 1, insetT: 6, insetL: 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{`SEED 0x${seedHex()}`}</Text>
      <Text class="text-xs" style={{ posType: 1, insetT: 19, insetL: 12, textColor: "#9fd0ff", lineHeight: 12, height: 12 }}>{`TICK ${String(g().tick).padStart(3, "0")}/${total} ${autoSig() ? "GROWING" : "PAUSED"}`}</Text>
      <View class="absolute" style={{ posType: 1, insetT: 4, insetR: 6, width: 128, height: g().sim ? 56 : 43, bgColor: "#0b1626", opacity: 0.76 }} debugName="rpgkit-grow-help" />
      <Text class="text-xs" style={{ posType: 1, insetT: 6, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>L/R SCRUB</Text>
      <Text class="text-xs" style={{ posType: 1, insetT: 19, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>TRI PLAY/PAUSE</Text>
      <Text class="text-xs" style={{ posType: 1, insetT: 32, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{g().phase === "done" ? "SQR SEED  ENTER" : "SQR SEED"}</Text>
      <Show when={g().sim}>
        <Text class="text-xs" style={{ posType: 1, insetT: 45, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>UP/DN EVENTS</Text>
      </Show>
      <Show when={g().sim}>
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: viewport().h - TIMELINE_H - CAPTION_H, width: viewport().w, height: CAPTION_H, bgColor: "#0b1626", opacity: 0.8 }} debugName="rpgkit-grow-caption" />
        <Text class="text-xs" style={{ posType: 1, insetL: 6, insetT: viewport().h - TIMELINE_H - CAPTION_H + 1, textColor: picked() ? "#ffe97a" : "#e8eef8", lineHeight: 12, height: 12 }}>{caption()}</Text>
        <Show when={here()}>
          <View class="absolute" style={{ posType: 1, insetT: 38, insetL: 6, width: Math.min(viewport().w - 12, 300), height: 14 + hereLines().length * 12, bgColor: "#0b1626", opacity: 0.84 }} debugName="rpgkit-grow-here" />
          <Text class="text-xs" style={{ posType: 1, insetT: 40, insetL: 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{`HERE ${here()!.x},${here()!.y}`}</Text>
          <For each={hereLines()}>{(line, i) =>
            <Text class="text-xs" style={{ posType: 1, insetT: 52 + i() * 12, insetL: 12, textColor: "#e8eef8", lineHeight: 12, height: 12 }}>{line}</Text>
          }</For>
        </Show>
      </Show>
      <View class="absolute" style={{ posType: 1, insetL: 0, insetT: viewport().h - TIMELINE_H, width: viewport().w, height: TIMELINE_H, bgColor: "#101a2c" }} debugName="rpgkit-grow-timeline">
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 6, width: timelineFill(), height: 4, bgColor: "#4a90d9" }} debugName="rpgkit-grow-tfill" />
        <For each={markers()}>{(m) =>
          <View class="absolute" style={{ posType: 1, insetL: m.x, insetT: 1, width: 2, height: 4, bgColor: m.color }} debugName="rpgkit-grow-marker" />
        }</For>
        <View class="absolute" style={{ posType: 1, insetL: Math.max(0, timelineFill() - 2), insetT: 4, width: 4, height: 8, bgColor: "#ffe97a" }} debugName="rpgkit-grow-knob" />
      </View>
    </Show>
    <Show when={modeSig() === "play"}><View class="absolute flex-row justify-end" style={{ posType: 1, insetT: 4, insetR: 6, bgColor: "#0b1626", opacity: 0.7 }}><Text class="text-xs" style={{ textColor: "#9fd0ff", lineHeight: 13, height: 13, insetL: 6, insetT: 1, insetR: 6, insetB: 1 }}>L REWIND 3S   SELECT BACK</Text></View></Show>
  </View>;
}
