// Type-only seam between the base GameView and the optional connected-world
// renderer. The concrete renderer lives behind `pocket-rpgkit/ui/world`, so a
// game that does not import and pass it cannot pull that implementation into
// its bundle.
//
// Coordinate spaces — the one contract every world consumer shares:
//
//   map-local      origin at the active map's top-left tile. `state.move`
//                  (tx/ty/px/py), the legacy single-map camera and every
//                  per-map layer coordinate live here.
//
//   component-world  origin at the connected component's signed world origin.
//                  `WorldPlacement.originTileX/Y`, `WorldComponent.bounds`,
//                  `visibleMaps`/`workingSet` rects and the camera returned by
//                  `GameViewWorldRuntime.cameraFor` live here.
//
//   world = local + placement.origin   (pixels: origin * tileSize)
//   local = world - placement.origin
//
// GameView is the single place that converts between the two: it presents a
// component-world camera to the world renderer and to the cache driver
// (`WorldCacheDriver.sync`). The active map's own extra layers receive a
// map-local camera (via `localCameraFor`); actors receive the component-
// world camera and are translated by the shared `worldNode`. Both sit inside
// the renderer's `ActiveMapPlane`, which adds the active placement's origin,
// so neither band adds the origin itself. A consumer that receives a
// component-world camera must never add the placement origin again.

import type { Accessor, Component, JSX } from "solid-js";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { SessionState } from "../engine/session.ts";
import type { CameraState, WorldLayout } from "../engine/types.ts";
import type { WorldHandoffResolver } from "../engine/world-handoff-contract.ts";
import type { AnimatedTilesStats } from "./AnimatedTiles.tsx";
import type { StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import type { AnimatedTile, StreamedGameAssets } from "./game-assets.ts";

export type GameViewWorldBand = "ground" | "upper";

export interface GameViewWorldViewport {
  w: number;
  h: number;
}

export interface GameViewWorldBandSource {
  refs: Accessor<Readonly<Record<string, readonly (string | null)[]>>>;
  columns: Accessor<Readonly<Record<string, number>>>;
  sourceKey: Accessor<string>;
  visible: Accessor<boolean>;
  margin: Accessor<number | undefined>;
  loadBudget: Accessor<number | undefined>;
}

/** Read-only values and map-local slots supplied by GameView to an opted-in
 * connected-world renderer. The renderer owns only presentation state. */
export interface GameViewWorldRenderProps {
  activeMapId: Accessor<string>;
  camera: Accessor<CameraState>;
  viewport: Accessor<GameViewWorldViewport>;
  active: Accessor<boolean>;
  stream: StreamedGameAssets;
  animated?: Readonly<Record<string, readonly AnimatedTile[]>>;
  ground: GameViewWorldBandSource;
  upper: GameViewWorldBandSource;
  below?: JSX.Element;
  actors?: JSX.Element;
  above?: JSX.Element;
  actorHost?: (node: NodeMirror) => void;
  onStreamStats?: (layer: GameViewWorldBand, stats: StreamedChunkLayerStats) => void;
  onAnimatedStats?: (layer: "below" | "above", stats: AnimatedTilesStats) => void;
}

export interface GameViewWorldFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One GameView-local renderer instance created by an opt-in factory. */
export interface GameViewWorldRuntime {
  readonly View: Component<GameViewWorldRenderProps>;
  /** Pure opening resolver paired with this renderer's immutable layout. */
  readonly handoff: WorldHandoffResolver;
  hasMap(mapId: string): boolean;
  frameFor(mapId: string, viewport: Readonly<GameViewWorldViewport>): GameViewWorldFrame | undefined;
  cameraFor(
    state: Readonly<SessionState>,
    viewport: Readonly<GameViewWorldViewport>,
  ): CameraState | undefined;
  localCameraFor(mapId: string, camera: Readonly<CameraState>): CameraState | undefined;
}

export interface GameViewWorldFactoryHost {
  readonly layout: Readonly<WorldLayout>;
  readonly tileSize: number;
  readonly debugCamera?: () => { x: number; y: number } | undefined;
}

/** Passed explicitly to GameView by games that want connected-world
 * rendering. Keeping this factory type-only makes the default renderer path
 * unable to reach the concrete world modules. */
export interface GameViewWorldConfig {
  create(host: GameViewWorldFactoryHost): GameViewWorldRuntime;
}
