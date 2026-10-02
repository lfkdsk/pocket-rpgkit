// Pure working-set derivation for seamless worlds.
//
// Given the immutable WorldLayout and the current camera/player situation,
// these functions decide which maps the layered caches (see plan 3.6) should
// retain:
//   active   — the one map the simulation runs on;
//   visible  — maps whose placed pixels intersect the camera rectangle;
//   imminent — one-hop prefetch targets: opening targets adjacent to the
//              active map, ranked by player facing and tile distance.
//
// Everything here is a pure function of its inputs and allocates only the
// returned arrays. Callers recompute when the camera crosses a tile boundary
// or the active map changes, never per simulation tick. A map that is not
// placed in the layout (an indoor map, or a project without worldLayout)
// degenerates to an active-only working set, which is exactly the legacy
// single-map behaviour.

import type {
  Facing,
  WorldComponent,
  WorldLayout,
  WorldOpening,
  WorldPlacement,
  WorldSide,
  WorldTilePoint,
} from "./types.ts";

/** A world-space pixel rectangle (inclusive origin, exclusive end). */
export interface WorldPixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImminentMap {
  mapId: string;
  portalId: string;
  /** The opening's source side on the active map. */
  side: WorldSide;
  /** Tile distance from the player to the opening span (0 = adjacent). */
  distance: number;
  compatibility: WorldOpening["compatibility"];
}

export interface WorldWorkingSet {
  active: string;
  visible: readonly string[];
  imminent: readonly ImminentMap[];
  /** Source/parsed keep-set: active + visible + imminent targets. */
  parsedKeep: readonly string[];
  /** Compiled keep-set: active + imminent targets. */
  compiledKeep: readonly string[];
}

export interface ImminentOptions {
  /** Exclude openings whose span is more than this many tiles from the
   *  player. Omit for no distance cap. */
  maxDistance?: number;
  /** Cap the returned targets after ranking. Omit for no cap. */
  limit?: number;
}

// Engine-facing order (types.ts Facing): 0 down, 1 left, 2 up, 3 right.
const FACING_SIDE: Readonly<Record<Facing, WorldSide>> = {
  0: "south",
  1: "west",
  2: "north",
  3: "east",
};

/** The component that places `mapId`, or undefined for an unplaced map. */
export function componentOfMap(
  layout: Readonly<WorldLayout>,
  mapId: string,
): WorldComponent | undefined {
  for (const component of layout.components) {
    for (const placement of component.placements) {
      if (placement.mapId === mapId) return component;
    }
  }
  return undefined;
}

function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** Map ids whose placed pixel rectangle intersects the camera rectangle,
 *  in the layout's sorted map-id order. */
export function visibleMaps(
  component: Readonly<WorldComponent>,
  camera: Readonly<WorldPixelRect>,
  tileSize: number,
): string[] {
  const visible: string[] = [];
  for (const placement of component.placements) {
    if (rectsIntersect(
      placement.originTileX * tileSize,
      placement.originTileY * tileSize,
      placement.width * tileSize,
      placement.height * tileSize,
      camera.x, camera.y, camera.w, camera.h,
    )) {
      visible.push(placement.mapId);
    }
  }
  return visible;
}

/** Map-local tile distance from the player to an opening's source span. */
function openingDistance(
  placement: Readonly<WorldPlacement>,
  playerLocal: Readonly<WorldTilePoint>,
  opening: Readonly<WorldOpening>,
): number {
  const span = opening.source.span;
  let tangent: number;
  let normal: number;
  switch (opening.source.side) {
    case "north":
      tangent = playerLocal.x; normal = playerLocal.y; break;
    case "south":
      tangent = playerLocal.x; normal = placement.height - 1 - playerLocal.y; break;
    case "west":
      tangent = playerLocal.y; normal = playerLocal.x; break;
    case "east":
      tangent = playerLocal.y; normal = placement.width - 1 - playerLocal.x; break;
  }
  const tangentDistance = tangent < span.start ? span.start - tangent
    : tangent >= span.end ? tangent - (span.end - 1)
    : 0;
  return tangentDistance + Math.max(0, normal);
}

/** One-hop prefetch targets across the active map's openings, ranked by
 *  facing match, then tile distance, then portal id. The player position is
 *  given in component-world tiles. */
export function imminentMaps(
  component: Readonly<WorldComponent>,
  activeMapId: string,
  playerWorldTile: Readonly<WorldTilePoint>,
  facing: Facing,
  options: ImminentOptions = {},
): ImminentMap[] {
  const placement = component.placements.find((p) => p.mapId === activeMapId);
  if (!placement) return [];
  const playerLocal = {
    x: playerWorldTile.x - placement.originTileX,
    y: playerWorldTile.y - placement.originTileY,
  };
  const facedSide = FACING_SIDE[facing];
  const ranked: ImminentMap[] = [];
  for (const opening of component.openings) {
    if (opening.source.mapId !== activeMapId) continue;
    const distance = openingDistance(placement, playerLocal, opening);
    if (options.maxDistance !== undefined && distance > options.maxDistance) continue;
    ranked.push({
      mapId: opening.target.mapId,
      portalId: opening.portalId,
      side: opening.source.side,
      distance,
      compatibility: opening.compatibility,
    });
  }
  ranked.sort((a, b) =>
    (a.side === facedSide ? 0 : 1) - (b.side === facedSide ? 0 : 1) ||
    a.distance - b.distance ||
    (a.portalId < b.portalId ? -1 : a.portalId > b.portalId ? 1 : 0),
  );
  return options.limit !== undefined ? ranked.slice(0, options.limit) : ranked;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Derive the layered cache keep-sets for the active map. An unplaced active
 *  map yields an active-only set, which is the legacy single-map policy. */
export function workingSet(
  layout: Readonly<WorldLayout>,
  activeMapId: string,
  camera: Readonly<WorldPixelRect>,
  tileSize: number,
  playerWorldTile: Readonly<WorldTilePoint>,
  facing: Facing,
  options: ImminentOptions = {},
): WorldWorkingSet {
  const component = componentOfMap(layout, activeMapId);
  if (!component) {
    return {
      active: activeMapId,
      visible: [],
      imminent: [],
      parsedKeep: [activeMapId],
      compiledKeep: [activeMapId],
    };
  }
  const visible = visibleMaps(component, camera, tileSize);
  const imminent = imminentMaps(component, activeMapId, playerWorldTile, facing, options);
  const parsedKeep = sortedUnique([
    activeMapId,
    ...visible,
    ...imminent.map((entry) => entry.mapId),
  ]);
  const compiledKeep = sortedUnique([
    activeMapId,
    ...imminent.map((entry) => entry.mapId),
  ]);
  return { active: activeMapId, visible, imminent, parsedKeep, compiledKeep };
}
