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

import { batch, createSignal, onMount, Show, type Accessor, type Component } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { createElement, setProp } from "@pocketjs/framework/renderer";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { useActions } from "@pocketjs/framework/actions";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { followCamera } from "../engine/camera.ts";
import { deepClone } from "../engine/clone.ts";
import type { ExtensionOptions, ExtensionRuntime } from "../engine/extensions.ts";
import { cloneScene, type BattleRules, type SceneSlot } from "../engine/battle.ts";
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
import { ChunkLayer } from "./ChunkLayer.tsx";
import { StreamedChunkLayer, type StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import { actorDepth, OccludingUpperLayer } from "./OccludingUpperLayer.tsx";
import { startupProfileMark } from "../startup-profile.ts";

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

/** The only mounted actor subtree. It owns enough stable image slots for any
 *  transfer destination and rebinds them without replacing native nodes. */
function CurrentMapActors(props: {
  slots: () => readonly GameEvent[];
  slotCount: number;
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
}) {
  startupProfileMark("ui-actors:start");
  const initial = props.state();
  let slots = props.slots();
  const stride = props.worldWidth;
  const npcs: NpcRenderSlot[] = Array.from({ length: props.slotCount }, (_, index) => {
    const source = slots[index];
    const frame = source
      ? npcFrame(initial, source, props.sprites, props.npcSrc, props.extensions)
      : [0, 0, "", 16, 1, false] as const;
    const node = createElement("image");
    setProp(node, "style", npcStyle(
      frame[3], actorDepth(frame[0], frame[1], stride), frame[4], frame[5],
    ));
    setProp(node, "src", frame[2]);
    if (source) setProp(node, "debugName", `rpgkit-npc-${source.id}`);
    return { node, px: frame[0], py: frame[1] };
  });
  startupProfileMark("ui-actors:pooled");

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

  onMount(compilePositions);

  onFrame(() => {
    const state = props.state();
    const next = props.slots();
    const transfer = next !== slots;
    if (transfer) slots = next;
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
      if (transfer) setProp(npc.node, "debugName", slots[index] ? `rpgkit-npc-${slots[index]!.id}` : undefined);
    }
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
}

export type BattleSceneComponent = Component<BattleSceneViewProps>;

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
  assets: GameAssets;
  /** One u16 button mask per 60 Hz source frame (engine/attract-tape.ts).
   *  Present: attract/takeover/rewind drive the fold. Absent: live play. */
  attractTape?: readonly number[];
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
  /** Browser repositories can report their frame barrier without putting
   * network timing into SessionState. null means ticking has resumed. */
  onMapLoading?: (mapId: string | null) => void;
}

export function GameView(props: GameViewProps) {
  startupProfileMark("game-view:start");
  const { project, assets } = props;
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
  // The host rate selects how many fixed 60 Hz reference ticks each frame
  // folds. Time-bearing commands compile against that fixed reference.
  const hz = simulationHz();
  // The controller folds the published 60 Hz tape on its source timeline
  // and maps each host frame onto that timeline.
  const attract = props.attractTape
    ? new AttractController(project, [...props.attractTape], {
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
  startupProfileMark("game-view:state");
  globalThis.__rpgSessionState = state;

  const mapsById = session.maps;
  const sprites = (project.sprites ?? {}) as Sprites;
  const initialMap = mapsById.get(state.mapId)!;
  const slotCache = new Map<string, GameEvent[]>([[state.mapId, collectMapSlots(initialMap)]]);
  const inlineMaxActors = isProjectShell(project)
    ? 0
    : Math.max(0, ...project.maps.map((map) => collectMapSlots(map).length));
  const actorSlotCount = Math.max(slotCache.get(state.mapId)!.length, assets.maxActors ?? 0, inlineMaxActors);
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
      if (slots.length > actorSlotCount) {
        throw new Error(
          `GameView: map ${JSON.stringify(state.mapId)} needs ${slots.length} actor slots; ` +
          `GameAssets.maxActors is ${actorSlotCount}`,
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
  const [demo, setDemo] = createSignal<AttractStatus | null>(null);
  const [scene, setScene] = createSignal<SceneSlot | null>(cloneScene(state.scene));
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
    return followCamera(st.move.px, st.move.py, project.tileSize, st.move.facing, {
      worldW: size.w,
      worldH: size.h,
      viewportW: vp.w,
      viewportH: vp.h,
    });
  };
  let camera = cameraFor(state);
  globalThis.__rpgGameCamera = camera;
  const [fade, setFade] = createSignal(0);
  const layerFingerprint = (value: SessionState): string =>
    value.interp.layers ? JSON.stringify(value.interp.layers) : "";
  let paintedLayers = layerFingerprint(state);
  const [layerRevision, setLayerRevision] = createSignal(0);
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
    // A game-owned scene (ui/GameView.tsx's BattleSceneView) reads no map
    // modal, so without this branch a scene's cancel/escape command (a
    // battle's "Run", a shop-in-battle back) has no way to reach the
    // reducer's cancelEdge and a scene author is forced to read raw button
    // bits itself (contracts/spec/spec.ts BTN.CROSS) instead of the
    // portable confirm/cancel edges every other input path uses.
    if (scene() !== null) {
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
  let prevButtons = 0;
  let blocked: {
    buttons: number;
    input?: SessionInput;
    ready: boolean;
    error?: unknown;
  } | null = null;

  onFrame((buttons) => {
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
    const frameButtons = blocked?.buttons ?? buttons;
    const input: SessionInput = blocked?.input ?? {
      buttons: frameButtons,
      confirmEdge: edge.confirm,
      cancelEdge: edge.cancel,
      upEdge,
      downEdge,
    };
    try {
      if (attract) {
        const result = attract.step(frameButtons);
        state = result.state;
        status = result.status;
      } else {
        state = stepSession(session, state, input);
      }
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
    globalThis.__rpgSessionState = state;
    edge.confirm = false;
    edge.cancel = false;

    const nextCamera = cameraFor(state);
    camera = nextCamera;
    globalThis.__rpgGameCamera = camera;

    const op = fadeOpacity(state.fade);
    const nextLayers = layerFingerprint(state);
    batch(() => {
      if (state.mapId !== prev.mapId || mapId() !== state.mapId) setMapId(state.mapId);
      // The walker pose is a pure function of the saved mover phase, so a
      // restore at any host frame offset renders identical pixels (R1202-2).
      const nextPose = walkPose(state.move.phase);
      if (nextPose !== pose()) setPose(nextPose);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (op !== fade()) setFade(op);
      if (nextLayers !== paintedLayers) {
        paintedLayers = nextLayers;
        setLayerRevision((revision) => revision + 1);
      }
      const shownModal = attract ? attract.presentedModal() : state.interp.modal;
      setModal((m) => (modalChanged(m, shownModal) ? deepClone(shownModal) : m));
      setScene(state.scene ? cloneScene(state.scene) : null);
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
  });

  const view = (
    <View class="w-full h-full overflow-hidden bg-black">
      <Show when={scene() === null}>
        <>
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
            />
          ))}
          {assets.anims ? (
            <MapAnimLayer
              above={false}
              state={() => state}
              anims={worldAnims}
              assets={assets}
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
            source={() => ({
              key: `upper:${upperSelection().name ?? ""}`,
              variant: upperSelection().variant,
            })}
            visible={() => upperSelection().visible}
            debugName="rpgkit-actors"
            onStreamStats={(stats) => props.onStreamStats?.("upper", stats)}
            onAnimatedStats={(stats) => props.onAnimatedStats?.("above", stats)}
          >
            <CurrentMapActors
              slots={currentSlots}
              slotCount={actorSlotCount}
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
            />
          ))}
          {assets.anims ? (
            <MapAnimLayer
              above
              state={() => state}
              anims={worldAnims}
              assets={assets}
              debugName="rpgkit-map-anim-above"
              onStats={(stats) => props.onMapAnimStats?.("above", stats)}
            />
          ) : null}
            </View>
          </View>

          {screenLayers.map(([id, layer]) => (
            <ScreenVisualLayer
              id={id}
              layer={layer}
              revision={layerRevision}
              state={() => state}
            />
          ))}

          <DialogBox
            modal={modal}
            legend={actions.legend}
            theme={props.theme}
            faces={props.faces}
            faceWidth={props.faceWidth}
            items={itemNames}
          />
        </>
      </Show>

      <Show when={scene() !== null}>
        {BattleSceneView ? (
          <BattleSceneView
            state={scene()!.state}
            width={viewport().w}
            height={viewport().h}
          />
        ) : null}
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
