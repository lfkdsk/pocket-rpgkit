// The feature gallery's props and terrain must be cut from the vendored
// Tuxemon sheets exactly: each catalogue rectangle holds one whole object,
// every placed copy reproduces those source pixels over its ground, and every
// terrain boundary uses a Tuxemon transition tile.

import { beforeAll, describe, expect, test } from "bun:test";
import { buildShowcaseProject } from "../examples/showcase/showcase-data.ts";
import {
  crop,
  groundAt,
  over,
  PLAQUE_FONT_PX,
  placementRect,
  prepareShowcaseArt,
  rugTile,
  showcaseMapLayers,
  showcaseMapPlan,
  showcaseObjectPixels,
  showcasePlanProblems,
  showcasePlaque,
  showcaseSheet,
  showcaseTerrainLayer,
  showcaseTerrainTile,
  type Bitmap,
} from "../examples/showcase/showcase-art.ts";
import {
  GRASS_TILE,
  SHOWCASE_OBJECTS,
  TERRAIN_FAMILIES,
  type ShowcaseObjectId,
} from "../examples/showcase/showcase-objects.ts";

const TILE = 16;
const project = buildShowcaseProject();

beforeAll(async () => {
  await prepareShowcaseArt();
});

function ringCounts(id: ShowcaseObjectId): [number, number, number, number] {
  const object = SHOWCASE_OBJECTS[id];
  const sheet = showcaseSheet(object.sheet);
  const [x, y, w, h] = object.rect;
  const alpha = (px: number, py: number) =>
    px < 0 || py < 0 || px >= sheet.width || py >= sheet.height ? 0 : sheet.rgba[(py * sheet.width + px) * 4 + 3]!;
  let top = 0, right = 0, bottom = 0, left = 0;
  for (let i = x - 1; i <= x + w; i++) {
    if (alpha(i, y - 1)) top++;
    if (alpha(i, y + h)) bottom++;
  }
  for (let j = y; j < y + h; j++) {
    if (alpha(x - 1, j)) left++;
    if (alpha(x + w, j)) right++;
  }
  return [top, right, bottom, left];
}

/** Flatten upper over ground for one pixel rectangle. */
function flattened(ground: Bitmap, upper: Bitmap, x: number, y: number, width: number, height: number): Uint8Array {
  const out = crop(ground, x, y, width, height);
  const top = crop(upper, x, y, width, height);
  for (let i = 0; i < out.rgba.length; i += 4) over(out.rgba, i, top.rgba, i);
  return out.rgba;
}

describe("showcase prop catalogue", () => {
  test("every rectangle is the tight, whole object on its source sheet", () => {
    for (const [id, object] of Object.entries(SHOWCASE_OBJECTS) as [ShowcaseObjectId, (typeof SHOWCASE_OBJECTS)[ShowcaseObjectId]][]) {
      const pixels = showcaseObjectPixels(id);
      const opaque = (px: number, py: number) => pixels.rgba[(py * pixels.width + px) * 4 + 3]! > 0;
      const rowHas = (py: number) => Array.from({ length: pixels.width }, (_, px) => opaque(px, py)).some(Boolean);
      const colHas = (px: number) => Array.from({ length: pixels.height }, (_, py) => opaque(px, py)).some(Boolean);
      // Tight: no empty margin rows or columns inside the rectangle.
      expect([rowHas(0), rowHas(pixels.height - 1), colHas(0), colHas(pixels.width - 1)], id).toEqual([true, true, true, true]);
      // Whole: the ring outside is empty apart from documented neighbours.
      expect(ringCounts(id), id).toEqual([...(("contact" in object ? object.contact : undefined) ?? [0, 0, 0, 0])]);
      // The anchored rectangle fits its footprint.
      expect(object.anchor[0] + object.rect[2] <= object.cols * TILE, id).toBe(true);
      expect(object.anchor[1] + object.rect[3] <= object.rows * TILE, id).toBe(true);
      expect(object.upper >= 0 && object.upper <= object.rows, id).toBe(true);
    }
  });

  test("the fountain is three source-identical cells wide and its neighbours stay outside", () => {
    const fountain = SHOWCASE_OBJECTS.fountain;
    expect(fountain.rect).toEqual([352, 144, 48, 45]);
    // Shifting the crop one cell would cut the basin and pull in the next frame.
    const shifted = { ...fountain, rect: [fountain.rect[0] + 16, ...fountain.rect.slice(1)] };
    const sheet = showcaseSheet("city");
    let left = 0;
    for (let j = shifted.rect[1]!; j < shifted.rect[1]! + shifted.rect[3]!; j++) {
      if (sheet.rgba[(j * sheet.width + shifted.rect[0]! - 1) * 4 + 3]) left++;
    }
    expect(left).toBeGreaterThan(0);
  });
});

describe("showcase map composition", () => {
  for (const map of project.maps) {
    test(`${map.id}: props stand on valid ground, stay whole and leave actors clear`, () => {
      expect(showcasePlanProblems(map)).toEqual([]);
    });

    test(`${map.id}: every placed prop reproduces its source rectangle pixel for pixel`, () => {
      const plan = showcaseMapPlan(map);
      expect(plan.objects.length).toBeGreaterThan(0);
      const terrain = showcaseTerrainLayer(plan);
      const layers = showcaseMapLayers(map, plan);
      for (const placement of plan.objects) {
        const rect = placementRect(placement);
        const actual = flattened(layers.ground, layers.upper, rect.x, rect.y, rect.width, rect.height);
        // Expected: the agreed ground for this map with the source pixels on top.
        const expected = crop(terrain, rect.x, rect.y, rect.width, rect.height);
        const source = showcaseObjectPixels(placement.object);
        for (let i = 0; i < expected.rgba.length; i += 4) over(expected.rgba, i, source.rgba, i);
        expect(actual, `${placement.object}@${placement.x},${placement.y}`).toEqual(expected.rgba);
        // The cut between layers follows the footprint's row boundary.
        const object = SHOWCASE_OBJECTS[placement.object];
        const cutY = (placement.y + object.upper) * TILE;
        for (let py = rect.y; py < rect.y + rect.height; py++) {
          for (let px = rect.x; px < rect.x + rect.width; px++) {
            const upperAlpha = layers.upper.rgba[(py * layers.upper.width + px) * 4 + 3]!;
            if (py >= cutY) expect(upperAlpha, `${placement.object} upper below cut`).toBe(0);
          }
        }
      }
    });

    test(`${map.id}: every terrain boundary uses a Tuxemon transition tile`, () => {
      const plan = showcaseMapPlan(map);
      const terrain = showcaseTerrainLayer(plan);
      const grass = crop(showcaseSheet("city"), GRASS_TILE[0], GRASS_TILE[1], TILE, TILE);
      for (let cy = 0; cy < plan.height; cy++) {
        for (let cx = 0; cx < plan.width; cx++) {
          const actual = crop(terrain, cx * TILE, cy * TILE, TILE, TILE).rgba;
          if (!plan.outdoor) {
            const rug = plan.rugs.find((r) => cx >= r.x && cy >= r.y && cx < r.x + r.width && cy < r.y + r.height);
            if (rug) {
              const [x, y] = rugTile(rug, cx, cy);
              const piece = crop(showcaseSheet("interior"), x, y, TILE, TILE).rgba;
              for (let i = 0; i < piece.length; i += 4) {
                if (piece[i + 3] === 255) expect(actual.subarray(i, i + 4), `rug ${cx},${cy}`).toEqual(piece.subarray(i, i + 4));
              }
            }
            continue;
          }
          const tile = showcaseTerrainTile(plan, cx, cy);
          const expected = grass.rgba.slice();
          if (tile.kind !== "grass") {
            const family = TERRAIN_FAMILIES[tile.family];
            const piece = crop(showcaseSheet(family.sheet), tile.tile[0], tile.tile[1], TILE, TILE);
            for (let i = 0; i < expected.length; i += 4) over(expected, i, piece.rgba, i);
            // A solid cell's four neighbours are solid or carry this family's edge.
            if (tile.kind === "solid") {
              for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= plan.width || ny >= plan.height) continue;
                const next = showcaseTerrainTile(plan, nx, ny);
                expect(next.kind === "grass", `${map.id} ${tile.family} at ${cx},${cy} meets bare grass`).toBe(false);
                if (next.kind !== "grass") expect(next.family).toBe(tile.family);
              }
            }
          }
          expect(actual, `${map.id} terrain ${cx},${cy}`).toEqual(expected);
        }
      }
    });
  }

  test("plants stand only on plain grass, never on paths, paving or water", () => {
    const plants = new Set<ShowcaseObjectId>(["tree", "pine", "hedge", "hedgeRow", "redFlowers", "leafyBush", "stump", "rocks"]);
    let count = 0;
    for (const map of project.maps) {
      const plan = showcaseMapPlan(map);
      for (const placement of plan.objects) {
        if (!plants.has(placement.object)) continue;
        const object = SHOWCASE_OBJECTS[placement.object];
        for (let row = 0; row < object.rows; row++) {
          for (let col = 0; col < object.cols; col++) {
            expect(groundAt(plan, placement.x + col, placement.y + row), `${map.id} ${placement.object}`).toBe("grass");
          }
        }
        count++;
      }
    }
    expect(count).toBeGreaterThan(40);
  });

  test("lobby doors are stone archways with hall-number plaques in the game font", () => {
    const lobby = project.maps.find((map) => map.id === "showcase-lobby")!;
    const plan = showcaseMapPlan(lobby);
    const doors = (lobby.events ?? []).filter((event) => event.id.startsWith("door-"));
    expect(doors).toHaveLength(14);
    for (const door of doors) {
      const arch = plan.objects.find((placement) =>
        (placement.object === "tunnel" || placement.object === "archway") &&
        door.x === placement.x + 1 && door.y >= placement.y && door.y < placement.y + 3);
      expect(arch, door.id).toBeDefined();
      const number = door.name?.split(".")[0];
      expect(number, door.id).toMatch(/^\d+$/);
      expect(plan.plaques.some((plaque) => plaque.label === number && Math.abs(plaque.x - (door.x * TILE + 8)) <= 0)).toBe(true);
    }
    expect(PLAQUE_FONT_PX).toBeGreaterThanOrEqual(12);
    for (const label of ["1", "8", "14"]) {
      const board = showcasePlaque(label);
      // Ink rows: dark text pixels inside the board.
      let first = -1, last = -1;
      for (let y = 0; y < board.height; y++) {
        for (let x = 1; x < board.width - 1; x++) {
          const i = (y * board.width + x) * 4;
          if (board.rgba[i]! < 120 && board.rgba[i + 2]! < 90 && y > 0 && y < board.height - 1) {
            if (first < 0) first = y;
            last = y;
          }
        }
      }
      expect(last - first + 1, `plaque ${label} glyph height`).toBeGreaterThanOrEqual(8);
    }
  });
});
