// src/ui/GameView.tsx — a complete game screen for an rpgkit-project/v1
// document: maps, transfers, moving NPCs and all four triggers over the
// pure session reducer (engine/session.ts). The entry passes the project
// and its baked asset manifest (GameAssets, cooked with
// tools/lib/chunks.ts); examples/sunstone mounts its three-map game.
// An entry that also passes an attract tape gets attract mode and
// takeover/rewind: engine/attract.ts owns the fold and derives every press
// edge from the button mask, so a demo frame and a live frame reach the
// reducer identically. Without a tape the view folds live input directly.
//
//   root (overflow-hidden, black)
//     world frame (clips to the CURRENT map or viewport on each axis and
//                 centers undersized axes for black letterboxing)
//       translated world      follows the player on oversized axes
//       ground chunks         row-major 512x512 images
//       upper/actor plane       only current-map characters; actors and
//                               clipped upper rows share (y,x) paint order
//     DialogBox               text / choices (themed, with portraits when
//                             the entry passes theme / faces)
//     fade overlay            black, opacity ramps for a faded transfer
//
// Desktop windows publish their live logical size (hostViewport /
// ui.__viewport). The frame polls it the same way apps/launcher does, so
// camera bounds and letterbox placement follow every resize. Positions and
// the world camera commit through one precompiled jump batch; chunk images
// stay mounted while the player walks.

import { batch, createSignal, onCleanup, onMount, Show, type Accessor, type Component } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { useActions } from "@pocketjs/framework/actions";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { clampCamera, followCamera } from "../engine/camera.ts";
import { deepClone } from "../engine/clone.ts";
import type { ExtensionOptions, ExtensionRuntime } from "../engine/extensions.ts";
import { cloneScene, type BattleRules } from "../engine/battle.ts";
import { centerOffset } from "../engine/viewport.ts";
import {
  createSession,
  fadeOpacity,
  isSessionWorldIdle,
  prepareSessionMap,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SceneOptions,
  type SessionState,
} from "../engine/session.ts";
import { isProjectShell, MapNotReadyError } from "../engine/map-repository.ts";
import { AttractController, type AttractStatus } from "../engine/attract.ts";
import {
  activePage,
  effectiveEventAppearance,
  effectivePlayerAppearance,
  eventIdLess,
  modalChanged,
} from "../engine/interpreter.ts";
import type { CompiledAnim } from "../engine/interpreter.ts";
import type {
  CameraState,
  Facing,
  GameEvent,
  MapDef,
  MapRepository,
  ProjectSource,
  JsonValue,
  SpriteDef,
} from "../engine/types.ts";
import { PlayerSprite, playerImageKey } from "./PlayerSprite.tsx";
import { walkPose, type WalkPose } from "../engine/movement.ts";
import { TILE } from "../engine/tiles.ts";
import {
  cameraFocusAt,
  screenShakeOffset,
  type BalloonEffectState,
} from "../engine/screen.ts";
import { DialogBox } from "./DialogBox.tsx";
import type { UiTheme } from "./theme.ts";
import type { Modal } from "../engine/interpreter.ts";
import type {
  GameAssets,
  GameMapLayerAssets,
  GameScreenLayerAssets,
  MapLayerVariant,
  NpcArt,
  ScreenLayerVariant,
} from "./game-assets.ts";
import { AnimatedTiles, type AnimatedTilesStats } from "./AnimatedTiles.tsx";
import { MapAnimLayer, type MapAnimStats } from "./MapAnimLayer.tsx";
import { BalloonLayer, type BalloonAnchor } from "./BalloonLayer.tsx";
import { ScreenEffectsLayer, ScreenFadeLayer } from "./ScreenEffectsLayer.tsx";
import { ChunkLayer } from "./ChunkLayer.tsx";
import { StreamedChunkLayer, type StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import { actorDepth, OccludingUpperLayer } from "./OccludingUpperLayer.tsx";
import { startupProfileMark } from "../startup-profile.ts";
import { frameProfileMark } from "../frame-profile.ts";
import type { GameViewDemoConfig } from "./demo-contract.ts";

type Sprites = Record<string, SpriteDef>;

// The PocketJS spec screen; console hosts render at exactly this size.
const SCREEN_W = 480;
const SCREEN_H = 272;

/** Whether a project SpriteDef ever paints a character (static or walker). */
function spritePaints(def: SpriteDef | undefined): boolean {
  return !!def && (def.kind === "walker" || !!def.src);
}

/** Events that ever show a character image, indexed in stable mount order. */
function collectMapSlots(map: MapDef): GameEvent[] {
  const slots: GameEvent[] = [];
  for (const ev of [...(map.events as GameEvent[])].sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1))) {
    slots.push(ev);
  }
  return slots;
}

interface NpcRenderSlot {
  node: NodeMirror;
  px: number;
  py: number;
}

type NpcFrame = [number, number, string, 16 | 32, number, boolean];

function depthOrder(points: readonly (readonly [number, number, ...unknown[]])[], worldWidth: number): string {
  const actors = points
    .map((_, index) => index)
    .sort((a, b) => actorDepth(points[a]![0]!, points[a]![1]!, worldWidth)
      - actorDepth(points[b]![0]!, points[b]![1]!, worldWidth) || a - b);
  return `${points.map((point) => Math.floor((Math.floor(point[1]!) - 2) / TILE))}|${actors}`;
}

function npcFrame(
  state: SessionState,
  event: GameEvent,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  extensions: ExtensionRuntime,
): NpcFrame {
  const ch = state.chars.chars[event.id];
  const active = ch && event.pages[ch.pageIndex]
    ? { page: event.pages[ch.pageIndex]!, index: ch.pageIndex }
    : activePage(event, state.sw, state.mapId, state.move.facing, {
        runtime: extensions,
        ext: state.ext,
      }, { worldIdle: isSessionWorldIdle(state) });
  const appearance = effectiveEventAppearance(
    { pageIndex: active?.index ?? -1, sprite: active?.page.sprite ?? null },
    state.interp.eventAppearances?.[event.id],
  );
  const name = appearance.sprite;
  const art: NpcArt | "" = name && spritePaints(sprites[name]) ? (npcSrc[name] ?? "") : "";
  return [
    ch ? ch.px : event.x * TILE,
    ch ? ch.py : event.y * TILE,
    art === "" || typeof art === "string"
      ? art
      : playerImageKey(walkPose(ch ? ch.phase : 0), ch ? ch.facing : 0, art),
    typeof art === "string" ? 16 : art.h,
    appearance.opacity / 255,
    appearance.visible && art !== "",
  ];
}

function npcStyle(height: 16 | 32, depth: number, opacity: number, visible: boolean) {
  return {
    posType: 1,
    insetL: 0,
    insetT: TILE - height,
    width: TILE,
    height,
    zIndex: depth,
    opacity,
    display: visible ? 0 : 1,
  };
}

interface PlayerRenderFrame {
  src: string;
  height: 16 | 32;
  opacity: number;
  visible: boolean;
}

function playerFrame(
  state: SessionState,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  builtIn: GameAssets["player"],
  builtInHeight: 16 | 32,
): PlayerRenderFrame {
  const appearance = effectivePlayerAppearance(state.sw);
  if (appearance.sprite === null) {
    return {
      src: playerImageKey(walkPose(state.move.phase), state.move.facing, builtIn),
      height: builtInHeight,
      opacity: appearance.opacity / 255,
      visible: appearance.visible,
    };
  }
  const art = spritePaints(sprites[appearance.sprite]) ? npcSrc[appearance.sprite] : undefined;
  return {
    src: typeof art === "string"
      ? art
      : art
        ? playerImageKey(walkPose(state.move.phase), state.move.facing, art)
        : "",
    height: typeof art === "string" || art === undefined ? 16 : art.h,
    opacity: appearance.opacity / 255,
    visible: appearance.visible && art !== undefined,
  };
}

/** Per-map actor node pool statistics (GameView's onActorStats). */
export interface ActorPoolStats {
  /** The map whose events the pool is currently bound to. */
  mapId: string;
  /** Slots bound to a current-map event this frame. */
  active: number;
  /** Image nodes owned by the pool (>= active). Grows when a transfer
   *  destination has more events; never shrinks. */
  pooled: number;
  /** Nodes created over this component instance's life. */
  created: number;
}

/** The only mounted actor subtree. It owns one stable image slot per event
 *  of the CURRENT map and grows the slot pool when a transfer destination
 *  has more events, rebinding without replacing native nodes. The pool
 *  never shrinks, so revisiting a small map after a big one reuses the big
 *  pool's nodes (parked hidden); `cap` (the baked global maxActors) bounds
 *  the growth and stays the resource budget. */
function CurrentMapActors(props: {
  slots: () => readonly GameEvent[];
  /** Initial pool size: the start map's event count. */
  slotCount: number;
  /** Hard upper bound on pool growth (GameAssets.maxActors / inline max). */
  cap: number;
  /** The upper-plane root the actor nodes mount under. Growth inserts new
   *  nodes there so they stay siblings of the clipped upper rows. */
  host: () => NodeMirror | undefined;
  worldWidth: number;
  sprites: Sprites;
  npcSrc: GameAssets["npcSrc"];
  extensions: ExtensionRuntime;
  player: GameAssets["player"];
  playerHeight: 16 | 32;
  pose: Accessor<WalkPose>;
  facing: Accessor<Facing>;
  state: () => SessionState;
  worldNode: () => NodeMirror | undefined;
  camera: () => CameraState;
  onStats?: (stats: ActorPoolStats) => void;
  /** While false, the per-frame actor sync pauses (the pool stays mounted
   *  and hidden with the world). Omit for always active. */
  active?: Accessor<boolean>;
  /** Fired once per synced frame, after the active gate. */
  onSync?: () => void;
}) {
  startupProfileMark("ui-actors:start");
  const initial = props.state();
  let slots = props.slots();
  const stride = props.worldWidth;
  let created = 0;
  /** Create one pool slot. At mount `slots` holds the start map and the
   *  initial state is current, so slots bind their event's art directly.
   *  Growth (`hidden`) runs mid-transfer against the stale mount state; the
   *  same onFrame pass rebinds the new slots, so they start parked hidden
   *  with an empty source instead of writing a throwaway frame. */
  const newSlot = (index: number, hidden = false): NpcRenderSlot => {
    const source = hidden ? undefined : slots[index];
    const frame = source
      ? npcFrame(initial, source, props.sprites, props.npcSrc, props.extensions)
      : [0, 0, "", 16, 1, false] as const;
    const node = createElement("image");
    setProp(node, "style", npcStyle(
      frame[3], actorDepth(frame[0], frame[1], stride), frame[4], frame[5],
    ));
    setProp(node, "src", frame[2]);
    if (source) setProp(node, "debugName", `rpgkit-npc-${source.id}`);
    created++;
    return { node, px: frame[0], py: frame[1] };
  };
  const npcs: NpcRenderSlot[] = Array.from({ length: props.slotCount }, (_, index) => newSlot(index));
  startupProfileMark("ui-actors:pooled");

  const report = (): void => {
    props.onStats?.({ mapId: props.state().mapId, active: slots.length, pooled: npcs.length, created });
  };

  /** Grow the pool to `needed` slots, inserting only the delta nodes. The
   *  transfer rebind in the same onFrame pass configures their art, so new
   *  nodes start hidden. */
  const grow = (needed: number): void => {
    if (needed > props.cap) {
      throw new Error(
        `GameView: map ${JSON.stringify(props.state().mapId)} needs ${needed} actor slots; ` +
        `GameAssets.maxActors is ${props.cap}`,
      );
    }
    const host = props.host();
    if (!host) throw new Error("GameView: actor pool host is not mounted");
    while (npcs.length < needed) {
      const slot = newSlot(npcs.length, true);
      insertNode(host, slot.node);
      npcs.push(slot);
    }
  };

  const [playerDepth, setPlayerDepth] = createSignal(actorDepth(initial.move.px, initial.move.py, stride));
  const [playerVisual, setPlayerVisual] = createSignal(
    playerFrame(initial, props.sprites, props.npcSrc, props.player, props.playerHeight),
  );
  let hero: NodeMirror | undefined;
  let positions: JumpBatch | undefined;
  let { px, py } = initial.move;
  let { x: cx, y: cy } = props.camera();
  let order = depthOrder(
    [
      [initial.move.px, initial.move.py],
      ...npcs.slice(0, slots.length).map((npc) => [npc.px, npc.py] as const),
    ],
    stride,
  );

  const compilePositions = (): void => {
    const worldNode = props.worldNode();
    if (!worldNode || !hero) return;
    const entries: [NodeMirror, "translateX" | "translateY"][] = [
      [worldNode, "translateX"],
      [worldNode, "translateY"],
      [hero, "translateX"],
      [hero, "translateY"],
    ];
    for (let index = 0; index < slots.length; index++) {
      const npc = npcs[index]!;
      entries.push([npc.node, "translateX"], [npc.node, "translateY"]);
    }
    positions = createJumpBatch(entries);
    const state = props.state();
    const camera = props.camera();
    positions.set(0, -camera.x);
    positions.set(1, -camera.y);
    positions.set(2, state.move.px);
    positions.set(3, state.move.py);
    for (let index = 0; index < slots.length; index++) {
      const npc = npcs[index]!;
      positions!.set(4 + index * 2, npc.px);
      positions!.set(5 + index * 2, npc.py);
    }
    positions.commit();
    px = state.move.px;
    py = state.move.py;
    cx = camera.x;
    cy = camera.y;
  };

  onMount(() => {
    report();
    compilePositions();
  });

  onFrame(() => {
    if (props.active && !props.active()) return;
    props.onSync?.();
    const state = props.state();
    const next = props.slots();
    const transfer = next !== slots;
    if (transfer) {
      slots = next;
      if (slots.length > npcs.length) grow(slots.length);
    }
    let moved = false;
    let dirty = transfer;
    const camera = props.camera();
    if (!transfer && (camera.x !== cx || camera.y !== cy)) {
      positions?.set(0, -camera.x);
      positions?.set(1, -camera.y);
      moved = true;
    }
    if (!transfer && (state.move.px !== px || state.move.py !== py)) {
      positions?.set(2, state.move.px);
      positions?.set(3, state.move.py);
      moved = true;
      dirty = true;
    }

    const touched = transfer ? npcs.length : slots.length;
    const frames: NpcFrame[] = [];
    for (let index = 0; index < touched; index++) {
      const source = slots[index];
      const frame: NpcFrame = source
        ? npcFrame(state, source, props.sprites, props.npcSrc, props.extensions)
        : [0, 0, "", 16, 1, false];
      frames.push(frame);
      const npc = npcs[index]!;
      if (!transfer && source && (npc.px !== frame[0] || npc.py !== frame[1])) {
        positions?.set(4 + index * 2, frame[0]);
        positions?.set(5 + index * 2, frame[1]);
        moved = true;
        dirty = true;
      }
      npc.px = frame[0];
      npc.py = frame[1];
    }
    let reorder = transfer;
    if (dirty) {
      const nextOrder = depthOrder([
        [state.move.px, state.move.py],
        ...frames.slice(0, slots.length),
      ], stride);
      reorder ||= order !== nextOrder;
      order = nextOrder;
    }
    if (transfer) compilePositions();
    else if (moved) positions?.commit();
    if (reorder) setPlayerDepth(actorDepth(state.move.px, state.move.py, stride));
    for (let index = 0; index < touched; index++) {
      const frame = frames[index]!;
      const npc = npcs[index]!;
      const oldStyle = npc.node.domAttrs?.style as ReturnType<typeof npcStyle> | undefined;
      setProp(npc.node, "src", frame[2], npc.node.domAttrs?.src as string | undefined);
      setProp(npc.node, "style", npcStyle(
        frame[3],
        slots[index] && reorder ? actorDepth(frame[0], frame[1], stride) : oldStyle?.zIndex ?? 0,
        frame[4],
        frame[5],
      ), oldStyle);
      if (transfer) setProp(npc.node, "debugName", slots[index] ? `rpgkit-npc-${slots[index]!.id}` : undefined, npc.node.domAttrs?.debugName);
    }
    if (transfer) report();
    px = state.move.px;
    py = state.move.py;
    cx = camera.x;
    cy = camera.y;
    const nextPlayer = playerFrame(state, props.sprites, props.npcSrc, props.player, props.playerHeight);
    setPlayerVisual((current) =>
      current.src === nextPlayer.src &&
      current.height === nextPlayer.height &&
      current.opacity === nextPlayer.opacity &&
      current.visible === nextPlayer.visible
        ? current
        : nextPlayer,
    );
  });

  const view = (
    <>
      <PlayerSprite
        pose={props.pose()}
        facing={props.facing()}
        frames={props.player}
        src={playerVisual().src}
        height={playerVisual().height}
        opacity={playerVisual().opacity}
        visible={playerVisual().visible}
        zIndex={playerDepth()}
        debugName="rpgkit-player"
        ref={(node) => {
          hero = node;
        }}
      />
      {npcs.map((npc) => npc.node as any)}
    </>
  );
  startupProfileMark("ui-actors:end");
  return view;
}

const EMPTY_CHUNKS: Readonly<Record<string, readonly string[]>> = {};
const EMPTY_REFS: Readonly<Record<string, readonly (string | null)[]>> = {};
const EMPTY_COLUMNS: Readonly<Record<string, number>> = {};

function selectedVariant(
  id: string,
  assets: GameMapLayerAssets | GameScreenLayerAssets,
  state: SessionState,
): { name: string | null; variant: MapLayerVariant | ScreenLayerVariant | undefined; visible: boolean } {
  const override = state.interp.layers?.[id];
  const name = override?.variant ?? assets.defaultVariant ?? null;
  const variant = name === null ? undefined : assets.variants[name];
  if (name !== null && variant === undefined) {
    throw new Error(`GameView: layer ${JSON.stringify(id)} has no variant ${JSON.stringify(name)}`);
  }
  return {
    name,
    variant,
    visible: override?.visible ?? assets.defaultVisible ?? true,
  };
}

function maxLayerChunks(layer: GameMapLayerAssets): number {
  let max = 1;
  for (const variant of Object.values(layer.variants)) {
    if (!("chunks" in variant)) continue;
    for (const chunks of Object.values(variant.chunks)) max = Math.max(max, chunks.length);
  }
  return layer.maxChunks ?? max;
}

/** One optional extra world-space band. Its nodes stay mounted across
 * visibility and variant changes; a source key makes streamed textures
 * release/rebind without rebuilding any map art. */
function ExtraMapLayer(props: {
  id: string;
  layer: GameMapLayerAssets;
  mapId: Accessor<string>;
  revision: Accessor<number>;
  state: () => SessionState;
  camera: () => CameraState;
  viewport: () => { w: number; h: number };
  active: Accessor<boolean>;
}) {
  const selection = () => {
    props.revision();
    return selectedVariant(props.id, props.layer, props.state());
  };
  const variant = (): MapLayerVariant | undefined => {
    const value = selection().variant;
    if (value === undefined) return undefined;
    if (!("chunks" in value) && !("refs" in value)) {
      throw new Error(`GameView: map layer ${JSON.stringify(props.id)} selected a screen variant`);
    }
    if (props.layer.mode === "eager" && !("chunks" in value)) {
      throw new Error(`GameView: eager layer ${JSON.stringify(props.id)} requires eager variants`);
    }
    if (props.layer.mode === "streamed" && !("refs" in value)) {
      throw new Error(`GameView: streamed layer ${JSON.stringify(props.id)} requires streamed variants`);
    }
    return value;
  };
  const streamedVariant = () => {
    const value = variant();
    return value && "refs" in value ? value : undefined;
  };
  const eagerVariant = () => {
    const value = variant();
    return value && "chunks" in value ? value : undefined;
  };
  const firstStreamed = Object.values(props.layer.variants).find(
    (candidate): candidate is Extract<MapLayerVariant, { refs: unknown }> => "refs" in candidate,
  );
  if (props.layer.mode === "streamed") {
    if (!firstStreamed) throw new Error(`GameView: streamed layer ${JSON.stringify(props.id)} has no source`);
    for (const candidate of Object.values(props.layer.variants)) {
      if (!("refs" in candidate) || candidate.chunkPx !== firstStreamed.chunkPx) {
        throw new Error(`GameView: streamed layer ${JSON.stringify(props.id)} variants must share chunkPx`);
      }
    }
  }
  return props.layer.mode === "streamed" ? (
    <StreamedChunkLayer
      mapId={props.mapId()}
      refs={streamedVariant()?.refs ?? EMPTY_REFS}
      columns={streamedVariant()?.columns ?? EMPTY_COLUMNS}
      chunkPx={firstStreamed!.chunkPx}
      camera={props.camera}
      viewport={props.viewport}
      margin={streamedVariant()?.margin}
      loadBudget={streamedVariant()?.loadBudget}
      sourceKey={`${props.id}:${selection().name ?? ""}`}
      visible={selection().visible && streamedVariant() !== undefined}
      active={props.active}
      debugName={`rpgkit-layer-${props.id}`}
    />
  ) : (
    <ChunkLayer
      names={eagerVariant()?.chunks[props.mapId()] ?? []}
      columns={eagerVariant()?.columns[props.mapId()] ?? 1}
      slots={maxLayerChunks(props.layer)}
      visible={selection().visible && eagerVariant() !== undefined}
      debugName={`rpgkit-layer-${props.id}`}
    />
  );
}

function ScreenVisualLayer(props: {
  id: string;
  layer: GameScreenLayerAssets;
  revision: Accessor<number>;
  state: () => SessionState;
}) {
  const selection = () => {
    props.revision();
    return selectedVariant(props.id, props.layer, props.state());
  };
  const variant = (): ScreenLayerVariant | undefined => {
    const value = selection().variant;
    if (value === undefined) return undefined;
    if ("chunks" in value || "refs" in value) {
      throw new Error(`GameView: screen layer ${JSON.stringify(props.id)} selected a map variant`);
    }
    return value;
  };
  return (
    <View
      class="absolute w-full h-full"
      style={{
        posType: 1,
        bgColor: variant()?.color ?? "#00000000",
        opacity: variant()?.opacity ?? 1,
        display: selection().visible && variant() !== undefined ? 0 : 1,
      }}
      debugName={`rpgkit-screen-layer-${props.id}`}
    >
      <Image
        class="absolute w-full h-full"
        src={variant()?.image ?? ""}
        style={{ posType: 1, display: variant()?.image ? 0 : 1 }}
      />
    </View>
  );
}

function StartupProfileTail() {
  onMount(() => startupProfileMark("game-view:mounted"));
  return null;
}

// Bench-only mount/unmount tracing (frame-profile.ts): a pass-through
// component that records when a Show branch mounts and unmounts, so native
// QuickJS benches can attribute entry/exit frame time to the world subtree,
// the dialog box and the battle scene. Adds no nodes of its own.
function ProfileMount(props: { stage: string; children: JSX.Element }) {
  onMount(() => frameProfileMark(`${props.stage}:mount`));
  onCleanup(() => frameProfileMark(`${props.stage}:unmount`));
  return props.children;
}

// The view exposes its bare reducer state and camera to sim tests; the
// read-only globals carry no behavior.
declare global {
  // eslint-disable-next-line no-var
  var __rpgSessionState: SessionState | undefined;
  // eslint-disable-next-line no-var
  var __rpgGameCamera: CameraState | undefined;
}

/** A game-owned scene renderer is deliberately read-only. All animation,
 * selection and battle data must live in the supplied JSON state so replay
 * and rewind reproduce the same pixels. */
export interface BattleSceneViewProps {
  state: JsonValue;
  width: number;
  height: number;
  /** False while the once-mounted scene is hidden between battles. Resource
   * scopes use this edge to release the completed battle's texture pins. */
  active: boolean;
}

export type BattleSceneComponent = Component<BattleSceneViewProps>;

/** Optional host-side effects observe reducer state but cannot mutate it.
 * Keeping the component injected lets apps that do not opt in exclude an
 * effect implementation (and its host SDK imports) from their bundle. */
export interface GameEffectsProps {
  state: () => Readonly<SessionState>;
}

export type GameEffectsComponent = Component<GameEffectsProps>;

export interface GameViewProps {
  project: ProjectSource;
  /** Required with ProjectShell; omitted for backwards-compatible inline
   * projects. Local repositories acquire synchronously. */
  maps?: MapRepository;
  /** Pure game registrations forwarded to createSession(). */
  extensions?: ExtensionOptions;
  battle?: BattleRules;
  /** Full-screen scenes freeze map simulation unless explicitly enabled. */
  scene?: SceneOptions;
  /** Full-screen renderer used while SessionState.scene is a battle. Its
   * only inputs are reducer state and the live logical resolution. */
  battleScene?: BattleSceneComponent;
  /** Optional opt-in host effects, such as `pocket-rpgkit/ui/audio`. */
  effects?: GameEffectsComponent;
  assets: GameAssets;
  /** One u16 button mask per 60 Hz source frame (engine/attract-tape.ts).
   *  Present: attract/takeover/rewind drive the fold. Absent: live play. */
  attractTape?: readonly number[];
  /** Opt-in demo transport/menu runtime. Kept behind a factory so the base
   * GameView has no dependency on a concrete ui/demo implementation. */
  demo?: GameViewDemoConfig;
  /** DialogBox colours (ui/theme.ts); missing keys keep the kit default. */
  theme?: Partial<UiTheme>;
  /** DialogBox speaker portraits: NAME -> 64x64 image src. */
  faces?: Readonly<Record<string, string>>;
  /** DialogBox portrait column width (default 72). */
  faceWidth?: number;
  /** Optional diagnostics for streamed ground/upper residency. */
  onStreamStats?: (layer: "ground" | "upper", stats: StreamedChunkLayerStats) => void;
  /** Optional diagnostics for viewport-mounted animated tile sprites. */
  onAnimatedStats?: (layer: "below" | "above", stats: AnimatedTilesStats) => void;
  /** Optional diagnostics for state-driven map animation instances. */
  onMapAnimStats?: (layer: "below" | "above", stats: MapAnimStats) => void;
  /** Optional diagnostics for the per-map actor node pool. */
  onActorStats?: (stats: ActorPoolStats) => void;
  /** Per-frame heartbeat from each world layer's sync hook, fired only on
   *  frames the hook actually runs — so it stays silent while a scene gates
   *  the world. Tests use it to prove the hooks paused; omit in production. */
  onLayerSync?: (layer: "actors" | "mapAnimBelow" | "mapAnimAbove" | "balloons") => void;
  /** Browser repositories can report their frame barrier without putting
   * network timing into SessionState. null means ticking has resumed. */
  onMapLoading?: (mapId: string | null) => void;
}

export function GameView(props: GameViewProps) {
  startupProfileMark("game-view:start");
  const { project, assets } = props;
  const Effects = props.effects;
  // Shop box item display names, keyed by id (DialogBox falls back to the
  // raw id for anything absent). Derived once from the project's own item
  // catalog: the same source shop goods and inventory ids resolve against.
  const itemNames: Readonly<Record<string, { name: string }>> = Object.fromEntries(
    project.items.map((it) => [it.id, { name: it.name }]),
  );
  startupProfileMark("game-view:item-names");
  if ((props.battle === undefined) !== (props.battleScene === undefined)) {
    throw new Error("GameView: battle and battleScene must be registered together");
  }
  const BattleSceneView = props.battleScene;
  const stream = assets.stream;
  const hasAnimatedTiles = assets.animated !== undefined;
  const layerAssets = assets.layers ?? {};
  const groundLayer = layerAssets.ground?.placement === "ground" ? layerAssets.ground : undefined;
  const upperLayer = layerAssets.upper?.placement === "upper" ? layerAssets.upper : undefined;
  if (layerAssets.ground && !groundLayer) throw new Error("GameView: layer 'ground' must use placement 'ground'");
  if (layerAssets.upper && !upperLayer) throw new Error("GameView: layer 'upper' must use placement 'upper'");
  const expectedMode = stream ? "streamed" : "eager";
  if (groundLayer && groundLayer.mode !== expectedMode) {
    throw new Error(`GameView: ground variants must use ${expectedMode} sources`);
  }
  if (upperLayer && upperLayer.mode !== expectedMode) {
    throw new Error(`GameView: upper variants must use ${expectedMode} sources`);
  }
  for (const [id, layer] of [["ground", groundLayer], ["upper", upperLayer]] as const) {
    if (!layer) continue;
    for (const variant of Object.values(layer.variants)) {
      if (stream) {
        if (!("refs" in variant) || variant.chunkPx !== stream.chunkPx) {
          throw new Error(`GameView: ${id} streamed variants must share the base chunkPx`);
        }
      } else if (!("chunks" in variant)) {
        throw new Error(`GameView: ${id} eager variants require eager chunk sources`);
      }
    }
  }
  const extraBelow = Object.entries(layerAssets).filter(
    (entry): entry is [string, GameMapLayerAssets] => entry[1].placement === "below",
  );
  const extraAbove = Object.entries(layerAssets).filter(
    (entry): entry is [string, GameMapLayerAssets] => entry[1].placement === "above",
  );
  const screenLayers = Object.entries(layerAssets).filter(
    (entry): entry is [string, GameScreenLayerAssets] => entry[1].placement === "screen",
  );
  const screenLayerAssets = Object.fromEntries(screenLayers) as Record<string, GameScreenLayerAssets>;
  // The host rate selects how many fixed 60 Hz reference ticks each frame
  // folds. Time-bearing commands compile against that fixed reference.
  const hz = simulationHz();
  // The controller folds the published 60 Hz tape on its source timeline
  // and maps each host frame onto that timeline.
  const attract = props.attractTape !== undefined || props.demo !== undefined
    ? new AttractController(project, [...(props.attractTape ?? [])], {
        hz,
        maps: props.maps,
        extensions: props.extensions,
        battle: props.battle,
        scene: props.scene,
      })
    : null;
  const session: Session = attract
    ? attract.getSession()
    : createSession(project, hz, {
        maps: props.maps,
        extensions: props.extensions,
        battle: props.battle,
        scene: props.scene,
      });
  startupProfileMark("game-view:session");
  let state: SessionState = attract ? attract.state : startSession(project, session);
  const demoRuntime = props.demo
    ? props.demo.create({
        project,
        session,
        attract: attract!,
        getState: () => state,
      })
    : null;
  // A demo may synchronously load its initial validated chapter in create().
  // Make that controller state the render boot state before deriving any map,
  // camera, actor or scene model below.
  if (demoRuntime) state = attract!.state;
  const readState = (): Readonly<SessionState> => state;
  startupProfileMark("game-view:state");
  globalThis.__rpgSessionState = state;

  const mapsById = session.maps;
  const sprites = (project.sprites ?? {}) as Sprites;
  const initialMap = mapsById.get(state.mapId)!;
  const inlineMaxActors = isProjectShell(project)
    ? 0
    : Math.max(0, ...project.maps.map((map) => collectMapSlots(map).length));
  // The baked global maximum stays the resource budget and hard cap; the
  // pool itself starts at the current map's needs and grows on transfer.
  const actorSlotCap = Math.max(assets.maxActors ?? 0, inlineMaxActors);
  // The start map's slots are precached and mounted directly (no cache-miss
  // grow), so they pass the same cap check here: a sharded project whose
  // entry map declares more events than the budget allows is rejected up
  // front instead of silently overshooting the resource budget.
  const initialSlots = collectMapSlots(initialMap);
  if (initialSlots.length > actorSlotCap) {
    throw new Error(
      `GameView: map ${JSON.stringify(state.mapId)} needs ${initialSlots.length} actor slots; ` +
      `GameAssets.maxActors is ${actorSlotCap}`,
    );
  }
  const slotCache = new Map<string, GameEvent[]>([[state.mapId, initialSlots]]);
  const dimensions = isProjectShell(project)
    ? project.mapIndex
    : project.maps.map((map) => ({ id: map.id, width: map.width, height: map.height }));
  const dimensionsById = new Map(dimensions.map((map) => [map.id, map]));
  const worldWidth = Math.max(1, ...dimensions.map((map) => map.width * TILE));
  const currentSlots = (): readonly GameEvent[] => {
    for (const id of [...slotCache.keys()]) if (!mapsById.has(id)) slotCache.delete(id);
    let slots = slotCache.get(state.mapId);
    if (!slots) {
      const map = mapsById.get(state.mapId);
      if (!map) throw new Error(`GameView: map ${JSON.stringify(state.mapId)} is not resident`);
      slots = collectMapSlots(map);
      if (slots.length > actorSlotCap) {
        throw new Error(
          `GameView: map ${JSON.stringify(state.mapId)} needs ${slots.length} actor slots; ` +
          `GameAssets.maxActors is ${actorSlotCap}`,
        );
      }
      slotCache.set(state.mapId, slots);
    }
    return slots;
  };

  const [mapId, setMapId] = createSignal(state.mapId);
  // Compiled animation timing for the resident map (World.anims); an empty
  // map for projects without animations keeps the layer's frame math cheap.
  const EMPTY_ANIMS: ReadonlyMap<string, CompiledAnim> = new Map();
  const worldAnims = (): ReadonlyMap<string, CompiledAnim> =>
    session.worlds.get(state.mapId)?.anims ?? EMPTY_ANIMS;
  const [pose, setPose] = createSignal<WalkPose>(walkPose(state.move.phase));
  const [facing, setFacing] = createSignal<Facing>(state.move.facing);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [demo, setDemo] = createSignal<AttractStatus | null>(attract?.status() ?? null);
  const initialScene = cloneScene(state.scene);
  const [sceneActive, setSceneActive] = createSignal(initialScene !== null);
  // Visibility is deliberately separate from the renderer input. On exit the
  // hidden battle subtree retains its last state, so changing only the two
  // display gates cannot invalidate every accessor inside a large scene.
  const [battleViewState, setBattleViewState] = createSignal<JsonValue | undefined>(
    initialScene?.state,
  );
  const [worldAnimationTick, setWorldAnimationTick] = createSignal(
    attract?.worldAnimationTick() ?? 0,
  );
  // The battle scene mounts on first use and stays mounted (hidden) for the
  // rest of the session: re-entering a battle only swaps its state prop and
  // visibility, so entry/exit frames pay no scene mount/unmount cost.
  const [battleMounted, setBattleMounted] = createSignal(initialScene !== null);
  const [fatalError, setFatalError] = createSignal<string | null>(state.interp.error?.message ?? null);
  // Live host viewport: console hosts omit ui.__viewport (spec screen),
  // desktop windows publish and resize it. Polled in onFrame like
  // apps/launcher, so no host-specific subscription lives in the view.
  // hostViewport() returns ui.__viewport BY REFERENCE and the wasm host
  // mutates that same object on resize (hosts/web/wasm-ops.js), so keep a
  // private snapshot: comparing the shared object's fields would see the
  // new numbers through the signal's old value and never emit, leaving the
  // Solid style effect unpainted.
  const vp0 = hostViewport(getOps());
  const [viewport, setViewport] = createSignal(
    vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H },
  );
  const firstMapId = project.start.map;
  const mapSize = (id: string): { w: number; h: number } => {
    const assetSize = assets.world[id];
    if (assetSize) return assetSize;
    const indexed = dimensionsById.get(id);
    if (!indexed) throw new Error(`GameView: unknown map size ${JSON.stringify(id)}`);
    return { w: indexed.width * TILE, h: indexed.height * TILE };
  };
  const worldFrame = () => {
    const vp = viewport();
    const size = mapSize(mapId());
    const off = centerOffset(size, vp);
    return { x: off.x, y: off.y, w: Math.min(size.w, vp.w), h: Math.min(size.h, vp.h) };
  };
  const cameraFor = (st: SessionState): CameraState => {
    const vp = viewport();
    const size = mapSize(st.mapId);
    const effect = st.interp.screen;
    if (!effect?.camera && !effect?.shake) {
      return followCamera(st.move.px, st.move.py, project.tileSize, st.move.facing, {
        worldW: size.w,
        worldH: size.h,
        viewportW: vp.w,
        viewportH: vp.h,
      });
    }
    const focus = cameraFocusAt(effect.camera, {
      x: st.move.px + project.tileSize / 2,
      y: st.move.py + project.tileSize / 2,
    });
    const clamped = clampCamera(focus.x - vp.w / 2, focus.y - vp.h / 2, {
      worldW: size.w,
      worldH: size.h,
      viewportW: vp.w,
      viewportH: vp.h,
    });
    const shake = screenShakeOffset(effect.shake);
    return { x: clamped.x - shake.x, y: clamped.y - shake.y, facing: st.move.facing };
  };
  let camera = cameraFor(state);
  globalThis.__rpgGameCamera = camera;
  const [fade, setFade] = createSignal(0);
  const layerFingerprint = (value: SessionState): string =>
    value.interp.layers ? JSON.stringify(value.interp.layers) : "";
  let paintedLayers = layerFingerprint(state);
  const [layerRevision, setLayerRevision] = createSignal(0);
  const screenFingerprint = (value: SessionState): string => {
    const screen = value.interp.screen;
    return screen && (screen.fade || screen.tints || screen.flash || screen.backdrop)
      ? JSON.stringify([screen.fade, screen.tints, screen.flash, screen.backdrop])
      : "";
  };
  let paintedScreen = screenFingerprint(state);
  const [screenRevision, setScreenRevision] = createSignal(0);
  const presentedScreen = () => {
    screenRevision();
    return state.interp.screen;
  };
  const builtInLayer = (
    id: "ground" | "upper",
    definition: GameMapLayerAssets | undefined,
  ): { name: string | null; variant?: MapLayerVariant; visible: boolean } => {
    layerRevision();
    const override = state.interp.layers?.[id];
    if (!definition) {
      if (override?.variant !== undefined) {
        throw new Error(`GameView: layer ${JSON.stringify(id)} has no variant ${JSON.stringify(override.variant)}`);
      }
      return { name: null, visible: override?.visible ?? true };
    }
    const selection = selectedVariant(id, definition, state);
    const variant = selection.variant;
    if (variant && !("chunks" in variant) && !("refs" in variant)) {
      throw new Error(`GameView: built-in layer ${JSON.stringify(id)} selected a screen variant`);
    }
    return { name: selection.name, variant: variant as MapLayerVariant | undefined, visible: selection.visible };
  };
  const groundSelection = () => builtInLayer("ground", groundLayer);
  const upperSelection = () => builtInLayer("upper", upperLayer);
  const groundStreamVariant = () => {
    const variant = groundSelection().variant;
    return variant && "refs" in variant ? variant : undefined;
  };
  const groundEagerVariant = () => {
    const variant = groundSelection().variant;
    return variant && "chunks" in variant ? variant : undefined;
  };
  startupProfileMark("game-view:model");

  // Live play fires reducer edges from the action handlers. Under the
  // attract controller the legend is presentational: every press edge
  // (confirm, cancel, choices up/down) is derived from the folded button
  // mask (one unified input stream), so the view never fires edges itself.
  const edge = { confirm: false, cancel: false };
  const fire = (key: "confirm" | "cancel") =>
    attract
      ? undefined
      : () => {
          edge[key] = true;
        };
  const actions = useActions(() => {
    if (demoRuntime?.isOpen()) return {};
    // A full-screen scene is the sole foreground input owner. Map modals
    // remain parked in reducer state while the world is frozen, but must not
    // capture confirm/back until the scene closes and reveals them again.
    if (sceneActive()) {
      return {
        confirm: { label: "ok", run: fire("confirm") },
        back: { label: "back", run: fire("cancel") },
      };
    }
    const m = modal();
    if (m?.kind === "choices") {
      return {
        confirm: { label: "ok", run: fire("confirm") },
        ...(m.cancellable ? { back: { label: "back", run: fire("cancel") } } : {}),
      };
    }
    if (m?.kind === "shop") {
      return {
        confirm: { label: "ok", run: fire("confirm") },
        back: { label: "back", run: fire("cancel") },
      };
    }
    return { confirm: { label: m ? "next" : "talk", run: fire("confirm") } };
  });

  // The world camera and actor slots stay stable across transfers, so their
  // coordinates can share one precompiled position batch.
  let worldNode: NodeMirror | undefined;
  // The upper-plane root the actor pool mounts under; growth inserts there.
  let actorHost: NodeMirror | undefined;
  let prevButtons = 0;
  let blocked: {
    buttons: number;
    input?: SessionInput;
    ready: boolean;
    error?: unknown;
  } | null = null;

  const syncPresentedState = (
    prev: SessionState,
    status: AttractStatus | null,
    nextWorldAnimationTick: number,
  ): void => {
    globalThis.__rpgSessionState = state;

    camera = cameraFor(state);
    globalThis.__rpgGameCamera = camera;

    const op = fadeOpacity(state.fade);
    frameProfileMark("signals:start");
    const nextLayers = layerFingerprint(state);
    const nextScreen = screenFingerprint(state);
    batch(() => {
      if (state.mapId !== prev.mapId || mapId() !== state.mapId) setMapId(state.mapId);
      // The walker pose is a pure function of the saved mover phase, so a
      // restore at any host frame offset renders identical pixels (R1202-2).
      const nextPose = walkPose(state.move.phase);
      if (nextPose !== pose()) setPose(nextPose);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (op !== fade()) setFade(op);
      if (nextWorldAnimationTick !== worldAnimationTick()) {
        setWorldAnimationTick(nextWorldAnimationTick);
      }
      if (nextLayers !== paintedLayers) {
        paintedLayers = nextLayers;
        setLayerRevision((revision) => revision + 1);
      }
      if (nextScreen !== paintedScreen) {
        paintedScreen = nextScreen;
        setScreenRevision((revision) => revision + 1);
      }
      const shownModal = attract ? attract.presentedModal() : state.interp.modal;
      setModal((m) => (modalChanged(m, shownModal) ? deepClone(shownModal) : m));
      const nextScene = state.scene ? cloneScene(state.scene) : null;
      if (nextScene) {
        setBattleViewState(nextScene.state);
        setBattleMounted(true);
      }
      setSceneActive(nextScene !== null);
      setFatalError(state.interp.error?.message ?? null);
      if (status) {
        const st = status;
        setDemo((d) =>
          d === null ||
          d.phase !== st.phase ||
          d.demoFrame !== st.demoFrame ||
          d.controlNotice !== st.controlNotice ||
          d.rewindNotice !== st.rewindNotice ||
          d.idle !== st.idle
            ? { ...st }
            : d,
        );
      }
    });
    frameProfileMark("signals:end");
  };

  onFrame((buttons) => {
    frameProfileMark("frame:start");
    const pressed = buttons & ~prevButtons;
    const upEdge = !!(pressed & BTN.UP);
    const downEdge = !!(pressed & BTN.DOWN);

    // Pick up a desktop window resize before this frame's layout reads the
    // centering offset (hostViewport stays the one runtime fact).
    const nextViewport = hostViewport(getOps());
    if (
      nextViewport &&
      (nextViewport.w !== viewport().w || nextViewport.h !== viewport().h)
    ) {
      setViewport({ w: nextViewport.w, h: nextViewport.h });
    }

    // Under attract the controller owns the fold: a tape mask or the live
    // mask, takeover, rewind and the idle attract entry all resolve inside it.
    const prev = state;
    let status: AttractStatus | null = null;
    if (blocked) {
      if (blocked.error) throw blocked.error;
      if (!blocked.ready) return;
    }
    if (!blocked && demoRuntime) {
      const demoStep = demoRuntime.step(buttons, pressed);
      if (demoStep.consumed || demoStep.stateChanged) {
        // Menu/transport input owns this host frame. Keep both edge domains
        // aligned while folding no reducer input; a restored chapter is
        // presented directly, without an accidental extra world tick.
        attract!.syncLiveButtons(buttons);
        prevButtons = buttons;
        edge.confirm = false;
        edge.cancel = false;
        if (demoStep.stateChanged) state = attract!.state;
        syncPresentedState(prev, attract!.status(), attract!.worldAnimationTick());
        frameProfileMark("frame:end");
        return;
      }
    }
    const frameButtons = blocked?.buttons ?? buttons;
    const input: SessionInput = blocked?.input ?? {
      buttons: frameButtons,
      confirmEdge: edge.confirm,
      cancelEdge: edge.cancel,
      upEdge,
      downEdge,
    };
    try {
      frameProfileMark("reducer:start");
      if (attract) {
        const result = attract.step(frameButtons);
        state = result.state;
        status = result.status;
      } else {
        state = stepSession(session, state, input);
      }
      frameProfileMark("reducer:end");
      prevButtons = frameButtons;
      if (blocked) props.onMapLoading?.(null);
      blocked = null;
    } catch (error) {
      if (!(error instanceof MapNotReadyError) || !session.repository?.prepare) throw error;
      const pending: NonNullable<typeof blocked> = {
        buttons: frameButtons,
        ...(attract ? {} : { input }),
        ready: false,
      };
      blocked = pending;
      props.onMapLoading?.(error.mapId);
      void prepareSessionMap(session, error.mapId).then(
        () => { pending.ready = true; },
        (reason) => { pending.error = reason; },
      );
      return;
    }
    edge.confirm = false;
    edge.cancel = false;

    const nextWorldAnimationTick = !hasAnimatedTiles
      ? 0
      : attract
        ? attract.worldAnimationTick()
        : prev.scene === null && state.scene === null
          ? (worldAnimationTick() + session.ticksPerFrame) >>> 0
          : worldAnimationTick();
    syncPresentedState(prev, status, nextWorldAnimationTick);
    frameProfileMark("frame:end");
  });

  const view = (
    <View class="w-full h-full overflow-hidden bg-black">
      {Effects ? <Effects state={readState} /> : null}
      {/* The world subtree stays mounted across full-screen scenes. Hiding
          it with display:none (core skips layout, paint and hit-testing) and
          pausing its frame hooks is far cheaper than unmounting and
          remounting the chunk, animation, occlusion and actor pools on
          every battle entry/exit. The reducer freezes world simulation
          while a scene is open, so the paused subtree resumes from
          identical state when the scene closes. */}
      <ProfileMount stage="world">
        {/* The frame clips each axis to min(map, viewport). Undersized axes
            are centered over the black root; oversized axes start at zero
            and the inner world translates by the clamped follow camera. */}
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: worldFrame().x,
            insetT: worldFrame().y,
            width: worldFrame().w,
            height: worldFrame().h,
            ...(hasAnimatedTiles ? { spriteClock: worldAnimationTick() } : {}),
            // display: 0 shows, 1 hides (spec Display::None).
            display: sceneActive() ? 1 : 0,
          }}
          debugName="rpgkit-world-frame"
        >
            <View
              class="absolute"
              nodeRef={(n) => {
                worldNode = n;
              }}
              debugName="rpgkit-world"
            >
          {stream ? (
            <StreamedChunkLayer
              mapId={mapId()}
              refs={groundStreamVariant()?.refs ?? stream.ground}
              columns={groundStreamVariant()?.columns ?? stream.columns}
              chunkPx={stream.chunkPx}
              camera={() => camera}
              viewport={() => viewport()}
              margin={groundStreamVariant()?.margin ?? stream.margin}
              loadBudget={groundStreamVariant()?.loadBudget ?? stream.loadBudget}
              sourceKey={`ground:${groundSelection().name ?? ""}`}
              visible={groundSelection().visible}
              active={() => !sceneActive()}
              debugName="rpgkit-ground"
              onStats={(stats) => props.onStreamStats?.("ground", stats)}
            />
          ) : (
            <ChunkLayer
              names={groundEagerVariant()?.chunks[mapId()]
                ?? assets.ground[mapId()]
                ?? assets.ground[firstMapId]!}
              columns={groundEagerVariant()?.columns[mapId()]
                ?? assets.chunkColumns[mapId()]
                ?? assets.chunkColumns[firstMapId]
                ?? 1}
              slots={Math.max(assets.maxChunks, groundLayer ? maxLayerChunks(groundLayer) : 1)}
              visible={groundSelection().visible}
              debugName="rpgkit-ground"
            />
          )}

          {assets.animated ? (
            <AnimatedTiles
              mapId={mapId()}
              tiles={assets.animated}
              above={false}
              camera={() => camera}
              viewport={() => viewport()}
              active={() => !sceneActive()}
              mapTiles={() => {
                const m = mapsById.get(mapId())!;
                return { w: m.width, h: m.height };
              }}
              debugName="rpgkit-anim-below"
              visible={groundSelection().visible}
              onStats={(stats) => props.onAnimatedStats?.("below", stats)}
            />
          ) : null}

          {extraBelow.map(([id, layer]) => (
            <ExtraMapLayer
              id={id}
              layer={layer}
              mapId={mapId}
              revision={layerRevision}
              state={() => state}
              camera={() => camera}
              viewport={() => viewport()}
              active={() => !sceneActive()}
            />
          ))}
          {assets.anims ? (
            <MapAnimLayer
              above={false}
              state={() => state}
              anims={worldAnims}
              assets={assets}
              active={() => !sceneActive()}
              onSync={() => props.onLayerSync?.("mapAnimBelow")}
              debugName="rpgkit-map-anim-below"
              onStats={(stats) => props.onMapAnimStats?.("below", stats)}
            />
          ) : null}

          <OccludingUpperLayer
            mapId={mapId()}
            maps={mapsById}
            assets={assets}
            firstMapId={firstMapId}
            worldWidth={worldWidth}
            camera={() => camera}
            viewport={() => viewport()}
            active={() => !sceneActive()}
            source={() => ({
              key: `upper:${upperSelection().name ?? ""}`,
              variant: upperSelection().variant,
            })}
            visible={() => upperSelection().visible}
            debugName="rpgkit-actors"
            nodeRef={(node) => { actorHost = node; }}
            onStreamStats={(stats) => props.onStreamStats?.("upper", stats)}
            onAnimatedStats={(stats) => props.onAnimatedStats?.("above", stats)}
          >
            <CurrentMapActors
              slots={currentSlots}
              slotCount={slotCache.get(state.mapId)!.length}
              cap={actorSlotCap}
              host={() => actorHost}
              worldWidth={worldWidth}
              sprites={sprites}
              npcSrc={assets.npcSrc}
              extensions={session.extensions}
              player={assets.player}
              playerHeight={assets.playerHeight ?? 16}
              pose={pose}
              facing={facing}
              state={() => state}
              worldNode={() => worldNode}
              camera={() => camera}
              onStats={props.onActorStats}
              active={() => !sceneActive()}
              onSync={() => props.onLayerSync?.("actors")}
            />
          </OccludingUpperLayer>

          {extraAbove.map(([id, layer]) => (
            <ExtraMapLayer
              id={id}
              layer={layer}
              mapId={mapId}
              revision={layerRevision}
              state={() => state}
              camera={() => camera}
              viewport={() => viewport()}
              active={() => !sceneActive()}
            />
          ))}
          {assets.anims ? (
            <MapAnimLayer
              above
              state={() => state}
              anims={worldAnims}
              assets={assets}
              active={() => !sceneActive()}
              onSync={() => props.onLayerSync?.("mapAnimAbove")}
              debugName="rpgkit-map-anim-above"
              onStats={(stats) => props.onMapAnimStats?.("above", stats)}
            />
          ) : null}
          {assets.anims ? (
            <BalloonLayer
              state={() => state}
              anims={worldAnims}
              assets={assets}
              active={() => !sceneActive()}
              onSync={() => props.onLayerSync?.("balloons")}
              anchor={(balloon: Readonly<BalloonEffectState>): BalloonAnchor => {
                if (balloon.target === "player") {
                  const art = playerFrame(
                    state,
                    sprites,
                    assets.npcSrc,
                    assets.player,
                    assets.playerHeight ?? 16,
                  );
                  return { x: state.move.px, y: state.move.py, height: art.height };
                }
                const eventId = balloon.target.event;
                const ch = state.chars.chars[eventId];
                const event = currentSlots().find((candidate) => candidate.id === eventId);
                if (!ch || !event) {
                  return { x: balloon.x * TILE, y: balloon.y * TILE, height: TILE };
                }
                const frame = npcFrame(state, event, sprites, assets.npcSrc, session.extensions);
                return { x: frame[0], y: frame[1], height: frame[3] };
              }}
            />
          ) : null}
            </View>

          {screenLayers.map(([id, layer]) => (
            <ScreenVisualLayer
              id={id}
              layer={layer}
              revision={layerRevision}
              state={() => state}
            />
          ))}
        </View>
      </ProfileMount>

      {/* Screen effects (tints, flash, shake, backdrops) and the fade sit
          outside the kept-alive world so they keep their place above the
          map and around the dialog; the battle scene below draws over them
          while it is active. */}
      <ScreenEffectsLayer screen={presentedScreen} layers={screenLayerAssets} />

      {/* The dialog box is persistent by design (b778aa0): it stays mounted
          for the whole session and hides its own boxes while unused, so it
          no longer remounts with the world on battle exit. */}
      <ProfileMount stage="dialog">
        <DialogBox
          modal={() => sceneActive() ? null : modal()}
          legend={actions.legend}
          theme={props.theme}
          faces={props.faces}
          faceWidth={props.faceWidth}
          items={itemNames}
        />
      </ProfileMount>
      <ScreenFadeLayer screen={presentedScreen} />

      <Show when={battleMounted()}>
        <View
          style={{
            posType: 1,
            insetL: 0,
            insetT: 0,
            width: viewport().w,
            height: viewport().h,
            display: sceneActive() ? 0 : 1,
          }}
          debugName="rpgkit-battle-scene"
        >
          {BattleSceneView ? (
            <ProfileMount stage="battle">
              <BattleSceneView
                state={battleViewState()!}
                width={viewport().w}
                height={viewport().h}
                active={sceneActive()}
              />
            </ProfileMount>
          ) : null}
        </View>
      </Show>

      {/* D1/D2 demo overlay. In attract a small DEMO plate with the tape
          frame number sits in the top-right corner, away from the action.
          Takeover flashes "YOU HAVE CONTROL" for two seconds; L rewinds
          and flashes "REWIND". The overlay is presentation only — it
          emits no ops while hidden, and never mounts without a tape. */}
      <Show when={demo()?.phase === "attract"}>
        <View
          class="absolute flex-col items-end"
          style={{ posType: 1, insetT: 6, insetR: 8, bgColor: "#0b1626", opacity: 0.78 }}
          debugName="rpgkit-demo-badge"
        >
          <Text
            class="text-xs"
            style={{ textColor: "#ffe97a", lineHeight: 13, height: 13, insetL: 6, insetT: 2, insetR: 6 }}
          >
            {`DEMO ${String(demo()?.demoFrame ?? 0).padStart(3, "0")}/${demo()?.tapeFrames ?? 0}`}
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.controlNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center"
          style={{ posType: 1, insetT: 18, insetL: 0, insetR: 0 }}
          debugName="rpgkit-control-notice"
        >
          <Text class="text-sm" style={{ textColor: "#ffe97a", lineHeight: 18, height: 18 }}>
            YOU HAVE CONTROL
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.rewindNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center"
          style={{ posType: 1, insetT: 40, insetL: 0, insetR: 0 }}
          debugName="rpgkit-rewind-notice"
        >
          <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>
            REWIND 3 SEC
          </Text>
        </View>
      </Show>

      <View
        class="absolute left-0 right-0 top-0 bottom-0"
        style={{ posType: 1, bgColor: "#000000", opacity: fade() }}
        debugName="rpgkit-fade"
      />
      {/* Opt-in demo chrome stays above the world/fade but below fatal
          errors. Its implementation is supplied by the isolated demo entry. */}
      {demoRuntime ? demoRuntime.render(props.theme) : null}
      <Show when={fatalError() !== null}>
        <View
          class="absolute inset-0 flex-col justify-center items-center"
          style={{ posType: 1, bgColor: "#120b12" }}
          debugName="rpgkit-fatal-error"
        >
          <Text
            class="text-sm"
            style={{ textColor: "#ff8a8a", lineHeight: 18, height: 18 }}
            debugName="rpgkit-fatal-error-title"
          >
            EVENT ERROR
          </Text>
          <View style={{ height: 8 }} />
          <Text
            class="text-xs"
            style={{ textColor: "#f3dfe8", lineHeight: 14, height: 28 }}
            debugName="rpgkit-fatal-error-message"
          >
            {fatalError() ?? ""}
          </Text>
        </View>
      </Show>
      <StartupProfileTail />
    </View>
  );
  startupProfileMark("game-view:tree");
  return view;
}
