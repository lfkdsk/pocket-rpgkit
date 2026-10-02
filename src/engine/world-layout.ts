// Pure coordinate projection for the optional world-layout project contract.
// The active simulation position remains map id + local tile coordinates;
// these helpers never clamp, mutate, or create a second authoritative state.

import type {
  WorldAxis,
  WorldComponent,
  WorldLayout,
  WorldOpening,
  WorldOpeningEndpoint,
  WorldPlacement,
  WorldSeam,
  WorldSide,
  WorldTilePoint,
  WorldTileSpan,
} from "./types.ts";

export interface WorldCameraPoint {
  x: number;
  y: number;
}

export interface WorldViewportSize {
  w: number;
  h: number;
}

/** Allocation-stable visibility query for one connected component. The
 * component's validated placement order is already `(worldId,mapId)` order,
 * so consumers can append their layer/chunk keys without another sort. */
export interface VisibleWorldMapsReader {
  (
    camera: Readonly<WorldCameraPoint>,
    viewport: Readonly<WorldViewportSize>,
    marginPx?: number,
  ): readonly WorldPlacement[];
}

const EMPTY_PLACEMENTS: readonly WorldPlacement[] = Object.freeze([]);

/** Build a visible-map query whose hot path neither scans nor allocates until
 * a camera/viewport edge crosses a tile boundary. Results use half-open
 * rectangle intersection, matching placement and chunk-window bounds. */
export function createVisibleWorldMapsReader(
  component: Pick<WorldComponent, "placements">,
  tileSize: number,
): VisibleWorldMapsReader {
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new Error(`visible world maps: tileSize must be positive, got ${tileSize}`);
  }
  let previousX0 = Number.NaN;
  let previousY0 = Number.NaN;
  let previousX1 = Number.NaN;
  let previousY1 = Number.NaN;
  let previous: readonly WorldPlacement[] = EMPTY_PLACEMENTS;
  const scratch: WorldPlacement[] = [];

  return (camera, viewport, marginPx = 0) => {
    if (!Number.isFinite(marginPx) || marginPx < 0) {
      throw new Error(`visible world maps: margin must be non-negative, got ${marginPx}`);
    }
    if (
      !Number.isFinite(camera.x) || !Number.isFinite(camera.y) ||
      !Number.isFinite(viewport.w) || !Number.isFinite(viewport.h) ||
      viewport.w <= 0 || viewport.h <= 0
    ) {
      previousX0 = previousY0 = previousX1 = previousY1 = Number.NaN;
      return previous = EMPTY_PLACEMENTS;
    }

    const x0 = Math.floor((camera.x - marginPx) / tileSize);
    const y0 = Math.floor((camera.y - marginPx) / tileSize);
    const x1 = Math.ceil((camera.x + viewport.w + marginPx) / tileSize);
    const y1 = Math.ceil((camera.y + viewport.h + marginPx) / tileSize);
    if (x0 === previousX0 && y0 === previousY0 && x1 === previousX1 && y1 === previousY1) {
      return previous;
    }
    previousX0 = x0;
    previousY0 = y0;
    previousX1 = x1;
    previousY1 = y1;

    scratch.length = 0;
    for (const placement of component.placements) {
      if (
        placement.originTileX < x1 && placement.originTileX + placement.width > x0 &&
        placement.originTileY < y1 && placement.originTileY + placement.height > y0
      ) {
        scratch.push(placement);
      }
    }
    if (scratch.length === 0) return previous = EMPTY_PLACEMENTS;
    if (
      scratch.length === previous.length &&
      scratch.every((placement, index) => placement === previous[index])
    ) {
      return previous;
    }
    return previous = scratch.slice();
  };
}

/** Project a map-local tile coordinate into its component's world space. */
export function localToWorld(
  placement: Pick<WorldPlacement, "originTileX" | "originTileY">,
  local: Readonly<WorldTilePoint>,
): WorldTilePoint {
  return {
    x: placement.originTileX + local.x,
    y: placement.originTileY + local.y,
  };
}

/** Project a component-world tile coordinate into one map's local space. */
export function worldToLocal(
  placement: Pick<WorldPlacement, "originTileX" | "originTileY">,
  world: Readonly<WorldTilePoint>,
): WorldTilePoint {
  return {
    x: world.x - placement.originTileX,
    y: world.y - placement.originTileY,
  };
}

const OPPOSITE: Readonly<Record<WorldSide, WorldSide>> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

const fail = (message: string): never => {
  throw new Error(`world layout: ${message}`);
};

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const componentKey = (component: WorldComponent): string => `${component.worldId}\0${component.componentId}`;
const seamKey = (seam: WorldSeam): string =>
  `${seam.mapA}\0${seam.sideA}\0${seam.mapB}\0${seam.sideB}`;

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index++) {
    if (compareText(values[index - 1]!, values[index]!) >= 0) {
      fail(`${label} must be sorted and unique`);
    }
  }
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
}

function assertSpan(span: WorldTileSpan, limit: number, label: string): void {
  assertInteger(span.start, `${label}.start`);
  assertInteger(span.end, `${label}.end`);
  if (span.start < 0 || span.end <= span.start || span.end > limit) {
    fail(`${label} must be a non-empty half-open interval inside 0..${limit}`);
  }
}

function tangentAxis(side: WorldSide): WorldAxis {
  return side === "north" || side === "south" ? "x" : "y";
}

function tangentLimit(placement: WorldPlacement, axis: WorldAxis): number {
  return axis === "x" ? placement.width : placement.height;
}

function tangentOrigin(placement: WorldPlacement, axis: WorldAxis): number {
  return axis === "x" ? placement.originTileX : placement.originTileY;
}

function normalEdge(placement: WorldPlacement, side: WorldSide): number {
  switch (side) {
    case "north": return placement.originTileY;
    case "east": return placement.originTileX + placement.width;
    case "south": return placement.originTileY + placement.height;
    case "west": return placement.originTileX;
  }
}

function assertEndpoint(
  endpoint: WorldOpeningEndpoint,
  axis: WorldAxis,
  placements: ReadonlyMap<string, WorldPlacement>,
  label: string,
): WorldPlacement {
  const placement = placements.get(endpoint.mapId) ??
    fail(`${label}.mapId ${endpoint.mapId} is not in its component`);
  if (tangentAxis(endpoint.side) !== axis) fail(`${label}.side is inconsistent with axis ${axis}`);
  assertSpan(endpoint.span, tangentLimit(placement, axis), `${label}.span`);
  return placement;
}

function openingMatchesSeam(opening: WorldOpening, seam: WorldSeam): boolean {
  if (opening.axis !== seam.axis) return false;
  if (opening.source.mapId === seam.mapA && opening.source.side === seam.sideA &&
      opening.target.mapId === seam.mapB && opening.target.side === seam.sideB) {
    return opening.offset === seam.offsetAtoB &&
      opening.source.span.start >= seam.spanA.start && opening.source.span.end <= seam.spanA.end &&
      opening.target.span.start >= seam.spanB.start && opening.target.span.end <= seam.spanB.end;
  }
  return opening.source.mapId === seam.mapB && opening.source.side === seam.sideB &&
    opening.target.mapId === seam.mapA && opening.target.side === seam.sideA &&
    opening.offset === -seam.offsetAtoB &&
    opening.source.span.start >= seam.spanB.start && opening.source.span.end <= seam.spanB.end &&
    opening.target.span.start >= seam.spanA.start && opening.target.span.end <= seam.spanA.end;
}

function rectanglesOverlap(a: WorldPlacement, b: WorldPlacement): boolean {
  return Math.min(a.originTileX + a.width, b.originTileX + b.width) > Math.max(a.originTileX, b.originTileX) &&
    Math.min(a.originTileY + a.height, b.originTileY + b.height) > Math.max(a.originTileY, b.originTileY);
}

/** Validate the relational invariants JSON Schema cannot express. This is an
 * explicit load/build-time check, not work performed by the simulation loop. */
export function validateWorldLayout(layout: WorldLayout): WorldLayout {
  if (!/^[0-9a-f]{64}$/.test(layout.topologyHash)) fail("topologyHash must be lowercase SHA-256");
  if (layout.components.length === 0) fail("components must not be empty");

  const keys = layout.components.map(componentKey);
  assertSortedUnique(keys, "components");
  const allMapIds = new Set<string>();
  const allPortalIds = new Set<string>();
  const placementsByWorld = new Map<string, WorldPlacement[]>();

  for (const component of layout.components) {
    const label = `${component.worldId}/${component.componentId}`;
    if (!component.worldId || !component.componentId) fail(`${label}: ids must not be empty`);
    if (component.placements.length === 0) fail(`${label}: placements must not be empty`);
    assertSortedUnique(component.placements.map((placement) => placement.mapId), `${label}.placements`);
    assertSortedUnique(component.seams.map(seamKey), `${label}.seams`);
    assertSortedUnique(component.openings.map((opening) => opening.portalId), `${label}.openings`);

    const placements = new Map<string, WorldPlacement>();
    for (const placement of component.placements) {
      if (allMapIds.has(placement.mapId)) fail(`map ${placement.mapId} belongs to more than one component`);
      allMapIds.add(placement.mapId);
      placements.set(placement.mapId, placement);
      assertInteger(placement.originTileX, `${label}/${placement.mapId}.originTileX`);
      assertInteger(placement.originTileY, `${label}/${placement.mapId}.originTileY`);
      assertInteger(placement.width, `${label}/${placement.mapId}.width`);
      assertInteger(placement.height, `${label}/${placement.mapId}.height`);
      if (placement.width <= 0 || placement.height <= 0) fail(`${label}/${placement.mapId}: dimensions must be positive`);
      const siblings = placementsByWorld.get(component.worldId) ?? [];
      for (const other of siblings) {
        if (rectanglesOverlap(placement, other)) {
          fail(`${component.worldId}: placements ${other.mapId} and ${placement.mapId} overlap`);
        }
      }
      siblings.push(placement);
      placementsByWorld.set(component.worldId, siblings);
    }

    const expectedBounds = {
      minTileX: Math.min(...component.placements.map((placement) => placement.originTileX)),
      minTileY: Math.min(...component.placements.map((placement) => placement.originTileY)),
      maxTileX: Math.max(...component.placements.map((placement) => placement.originTileX + placement.width)),
      maxTileY: Math.max(...component.placements.map((placement) => placement.originTileY + placement.height)),
    };
    if (component.bounds.minTileX !== expectedBounds.minTileX ||
        component.bounds.minTileY !== expectedBounds.minTileY ||
        component.bounds.maxTileX !== expectedBounds.maxTileX ||
        component.bounds.maxTileY !== expectedBounds.maxTileY) {
      fail(`${label}: bounds do not equal the placement union`);
    }

    const openings = new Map<string, WorldOpening>();
    for (const opening of component.openings) {
      if (allPortalIds.has(opening.portalId)) fail(`opening ${opening.portalId} appears more than once`);
      allPortalIds.add(opening.portalId);
      openings.set(opening.portalId, opening);
      assertInteger(opening.offset, `${label}/${opening.portalId}.offset`);
      assertEndpoint(opening.source, opening.axis, placements, `${label}/${opening.portalId}.source`);
      assertEndpoint(opening.target, opening.axis, placements, `${label}/${opening.portalId}.target`);
      if (opening.source.mapId === opening.target.mapId) fail(`${label}/${opening.portalId}: endpoints use the same map`);
      if (OPPOSITE[opening.source.side] !== opening.target.side) fail(`${label}/${opening.portalId}: endpoint sides are not opposite`);
      if (opening.target.span.start !== opening.source.span.start + opening.offset ||
          opening.target.span.end !== opening.source.span.end + opening.offset) {
        fail(`${label}/${opening.portalId}: target span does not equal source span plus offset`);
      }
    }

    const referencedOpenings = new Set<string>();
    const neighbors = new Map(component.placements.map((placement) => [placement.mapId, new Set<string>()]));
    for (const seam of component.seams) {
      if (seam.mapA === seam.mapB) fail(`${label}/${seamKey(seam)}: seam endpoints use the same map`);
      const a = placements.get(seam.mapA) ??
        fail(`${label}/${seamKey(seam)}: seam map ${seam.mapA} is not in its component`);
      const b = placements.get(seam.mapB) ??
        fail(`${label}/${seamKey(seam)}: seam map ${seam.mapB} is not in its component`);
      if (OPPOSITE[seam.sideA] !== seam.sideB) fail(`${label}/${seamKey(seam)}: seam sides are not opposite`);
      if (tangentAxis(seam.sideA) !== seam.axis) fail(`${label}/${seamKey(seam)}: seam side is inconsistent with axis`);
      assertInteger(seam.offsetAtoB, `${label}/${seamKey(seam)}.offsetAtoB`);
      assertSpan(seam.spanA, tangentLimit(a, seam.axis), `${label}/${seamKey(seam)}.spanA`);
      assertSpan(seam.spanB, tangentLimit(b, seam.axis), `${label}/${seamKey(seam)}.spanB`);
      if (normalEdge(a, seam.sideA) !== normalEdge(b, seam.sideB)) {
        fail(`${label}/${seamKey(seam)}: seam edges do not touch`);
      }
      const globalStartA = tangentOrigin(a, seam.axis) + seam.spanA.start;
      const globalEndA = tangentOrigin(a, seam.axis) + seam.spanA.end;
      const globalStartB = tangentOrigin(b, seam.axis) + seam.spanB.start;
      const globalEndB = tangentOrigin(b, seam.axis) + seam.spanB.end;
      if (globalStartA !== globalStartB || globalEndA !== globalEndB) {
        fail(`${label}/${seamKey(seam)}: seam spans do not share world coordinates`);
      }
      if (seam.spanB.start !== seam.spanA.start + seam.offsetAtoB ||
          seam.spanB.end !== seam.spanA.end + seam.offsetAtoB) {
        fail(`${label}/${seamKey(seam)}: spanB does not equal spanA plus offsetAtoB`);
      }
      assertSortedUnique(seam.openingIds, `${label}/${seamKey(seam)}.openingIds`);
      for (const portalId of seam.openingIds) {
        const opening = openings.get(portalId) ??
          fail(`${label}/${seamKey(seam)}: unknown opening ${portalId}`);
        if (referencedOpenings.has(portalId)) fail(`${label}: opening ${portalId} is referenced by more than one seam`);
        if (!openingMatchesSeam(opening, seam)) fail(`${label}/${portalId}: opening does not match its seam`);
        referencedOpenings.add(portalId);
      }
      neighbors.get(seam.mapA)!.add(seam.mapB);
      neighbors.get(seam.mapB)!.add(seam.mapA);
    }
    if (referencedOpenings.size !== openings.size) {
      const missing = [...openings.keys()].find((id) => !referencedOpenings.has(id));
      fail(`${label}: opening ${missing} is not referenced by a seam`);
    }

    const reached = new Set<string>();
    const pending = [component.placements[0]!.mapId];
    while (pending.length) {
      const mapId = pending.pop()!;
      if (reached.has(mapId)) continue;
      reached.add(mapId);
      for (const neighbor of neighbors.get(mapId)!) pending.push(neighbor);
    }
    if (reached.size !== placements.size) fail(`${label}: placements are not connected by seams`);
  }
  return layout;
}
