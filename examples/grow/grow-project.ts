// examples/grow/grow-project.ts — turn a grown settlement
// (engine/grow.ts) into a real rpgkit-project/v1 document.
//
// The generated village uses the SAME format, schema and loader as a
// hand-authored game: engine/schema-validate.ts validates it and
// engine/session.ts plays it. Nothing in the runtime treats a grown map
// differently from an authored one — the growth rules are the editor's
// "generate" leg; a generated project can be saved as JSON, edited by
// hand, and reloaded.
//
//   ground  -1 biome base      -> "ninja.<cell>" (walkable)
//   ground grown cell          -> "ninja.<cell>" (road, plaza, tilled)
//   upper trees / huts / fences -> sparse star layer, each a blocking
//                                  passage override (walls and fences keep
//                                  the mover out)
//   villagers                   -> events with a repeat moveRoute that
//                                  stays on road cells (guaranteed by the
//                                  grow reducer)
//
// The player starts on a road cell of the central plaza that no villager
// occupies.

import type { GameEvent, MapDef, MoveStep, Project, TileId } from "../../src/engine/types.ts";
import { biomeAt, DX, DY, growHash, growToDone, GROW_TILE, plazaCenter, wildernessTileAt, type Dir4, type GrowHouse, type GrowState } from "./grow.ts";
import { blocksWalking, describeEvent, eventsOf, MAJOR_EVENTS, SEASON_NAMES, seasonAt } from "./grow-causal.ts";
import { STAMP_END, STAMP_LIST } from "./grow-stamps.ts";

const SHEET = { id: "ninja", cols: 256, rows: Math.max(1, Math.ceil(STAMP_END / 256)), pak: "chunks" } as const;

/** Rule-grown Ninja foliage paints on the upper layer over walkable ground.
 *  It carries no "block" passage override; houses and fences stay solid.
 *  Passability keys off the reducer's decor indices, not the art id alone. */
const CANOPY_CELLS = new Set([
  GROW_TILE.TREE, GROW_TILE.BUSH, GROW_TILE.PALM, GROW_TILE.CACTUS,
  GROW_TILE.FIR, GROW_TILE.SNOW_SHRUB, GROW_TILE.FLOWER_PROP,
  GROW_TILE.GRASS_TUFT, GROW_TILE.LOGS, GROW_TILE.ROCK,
  ...Array.from({ length: 24 }, (_, i) => 46 + i),
  // Wilderness stamps (trees, bushes, rocks, flowers); houses and market stalls stay solid.
  ...STAMP_LIST.filter((st) => st.sheet !== "house" && !st.key.startsWith("market") && !st.key.startsWith("house") && !st.key.startsWith("dome"))
    .flatMap((st) => Array.from({ length: st.w * st.h }, (_, i) => st.base + i)),
]);

function tile(cell: number): TileId {
  return `ninja.${cell}`;
}

const BIOME_BASE = [90, 91, 92, 93] as const;

/** Greeting a grown villager gives when talked to. */
function villagerLine(h: GrowHouse, seed: number): string[] {
  return [
    `VILLAGER: My house grew off the road`,
    `under seed 0x${seed.toString(16).toUpperCase().padStart(8, "0")}.`,
    `Same seed always grows this door.`,
  ];
}

const STEP: readonly MoveStep[] = ["moveDown", "moveLeft", "moveUp", "moveRight"];

/** A causal villager's beat: out along worn road and back, chosen by hash. */
function causalRoute(done: GrowState, x0: number, y0: number, salt: number): MoveStep[] {
  const p = done.params;
  const out: Dir4[] = [];
  let x = x0, y = y0, dir: Dir4 = 0;
  for (let n = 0; n < Math.floor(p.villagerRouteLen / 2); n++) {
    const options: Dir4[] = [];
    for (let d = 0 as Dir4; d < 4; d = (d + 1) as Dir4) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx >= 1 && ny >= 1 && nx < p.width - 1 && ny < p.height - 1 && done.road[ny * p.width + nx] === 1 && (d ^ 2) !== dir) options.push(d);
    }
    if (!options.length) break;
    const h = growHash(p.seed, x, y, salt + n);
    const next: Dir4 = options.includes(dir) && h % 10 < 6 ? dir : options[(h >>> 4) % options.length]!;
    out.push(next); x += DX[next]; y += DY[next]; dir = next;
  }
  const steps = out.map((d) => STEP[d]!);
  if (steps.length) { steps.push("wait"); for (let i = out.length - 1; i >= 0; i--) steps.push(STEP[(out[i]! ^ 2) as Dir4]!); }
  return steps;
}

/** The road cell nearest (x, y) within `radius`, or undefined. */
function nearestRoad(done: GrowState, x: number, y: number, radius: number, taken: Set<number>): { x: number; y: number } | undefined {
  const p = done.params;
  for (let r = 0; r <= radius; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const nx = x + dx, ny = y + dy;
    if (nx < 1 || ny < 1 || nx >= p.width - 1 || ny >= p.height - 1) continue;
    const i = ny * p.width + nx;
    if (done.road[i] === 1 && !taken.has(i)) return { x: nx, y: ny };
  }
  return undefined;
}

/** History plaques: each village's notice board tells what happened there. */
function causalPlaques(done: GrowState): GameEvent[] {
  const p = done.params;
  return done.sim!.settlements.map((town) => {
    const year = (tick: number) => `YEAR ${Math.floor((tick - 1) / (p.causal!.seasonTicks * 4)) + 1} ${SEASON_NAMES[seasonAt(p, tick)]}`;
    const history = eventsOf(done, town.id).filter((e) => MAJOR_EVENTS.has(e.kind) && e.kind !== "founded").slice(-4);
    const pages: string[][] = [[
      `<${town.name}>`,
      `Founded ${year(town.founded)} by the water.`,
      town.status === "abandoned" ? `Abandoned. At most ${town.peak} lived here.` : `${town.pop} live here now; at most ${town.peak}.`,
    ]];
    for (let i = 0; i < history.length; i += 2) {
      pages.push(history.slice(i, i + 2).flatMap((e) => [year(e.tick), describeEvent(done, e)]));
    }
    return {
      id: `plaque-${town.id + 1}`,
      name: `${town.name} Notice`,
      x: town.cx + 1,
      y: town.cy - 1,
      pages: [{ trigger: "action", sprite: null, commands: pages.map((lines) => ({ op: "text" as const, lines })) }],
    };
  });
}

/** Build the playable project for a settled (done) grow state. */
export function growProject(done: GrowState): Project {
  const p = done.params;
  // The live generator has a 4,096-column backing strip, while v1 maps cap
  // width at 256. Export the authored prefix plus a four-cell edit margin;
  // the result is a normal bounded project with no empty 65K-pixel tail.
  const exportWidth = Math.min(256, Math.max(16, done.frontierX + 5));
  const ground: TileId[] = [];
  for (let y = 0; y < p.height; y++) for (let x = 0; x < exportWidth; x++) {
    const cell = done.ground[y * p.width + x]!;
    ground.push(cell < 0 ? tile(BIOME_BASE[biomeAt(p, x, y)]!) : tile(cell));
  }
  const upper: [number, TileId][] = [];
  const passage: [number, "block"][] = [];
  // Decor canopy indices are walkable (bodies pass UNDER the art); every
  // other upper cell is solid: hut roof/walls and the fence ring.
  const decorSet = new Set(done.decor);
  for (let i = 0; i < done.upper.length; i++) {
    if (done.upper[i]! >= 0) {
      const x = i % p.width;
      const y = Math.floor(i / p.width);
      if (x >= exportWidth) continue;
      const outIndex = y * exportWidth + x;
      upper.push([outIndex, tile(done.upper[i]!)]);
      // Walkable only when BOTH true: it is decor the grower planted AND
      // its art is foliage. A non-decor use of the same art stays solid.
      // A causal world blocks exactly what its own walkers cannot cross,
      // so stumps and saplings stay walkable as they were in the history.
      const solid = done.sim ? blocksWalking(done.upper[i]!) : !(decorSet.has(i) && CANOPY_CELLS.has(done.upper[i]!));
      if (solid) passage.push([outIndex, "block"]);
    }
  }
  // Undeveloped wilderness is a deterministic presentation layer in the
  // grow demo. Materialize it into the exported project so the generated
  // rpgkit-project/v1 document starts from the same inhabited landscape.
  for (let y = 0; y < p.height; y++) for (let x = 0; x < exportWidth; x++) {
    const source = y * p.width + x;
    if (done.upper[source]! >= 0 || done.ground[source]! >= 0 || done.road[source] === 1) continue;
    const cell = wildernessTileAt(done, x, y);
    if (cell) upper.push([y * exportWidth + x, tile(cell)]);
  }

  // Villager events, stable id order (birth order). A causal villager
  // whose home fell stands nowhere; the rest wait on the road nearest home.
  const taken = new Set<number>();
  const events: GameEvent[] = [];
  done.villagers.forEach((v, i) => {
    const h = done.houses[v.house]!;
    let x = v.x, y = v.y, route = v.route;
    if (done.sim) {
      if (v.left !== undefined || h.ruined !== undefined || h.vacant !== undefined) return;
      const at = nearestRoad(done, v.x, v.y, 3, taken);
      if (!at || at.x >= exportWidth) return;
      x = at.x; y = at.y; route = causalRoute(done, x, y, i * 64);
      taken.add(y * p.width + x);
    }
    events.push({
      id: `villager-${i + 1}`,
      name: `Villager ${i + 1}`,
      x,
      y,
      pages: [
        {
          trigger: "action",
          sprite: "villager",
          blocks: true,
          moveRoute: { steps: [...route], repeat: true, skippable: false },
          commands: [{ op: "text", lines: villagerLine(h, p.seed) }],
        },
      ],
    });
  });

  // A plaque on the plaza records the seed — the generated game states its
  // own provenance and how to regrow it identically.
  const home = done.sim?.settlements.find((t) => t.status !== "abandoned") ?? done.sim?.settlements[0];
  const { x: cx, y: cy } = home ? { x: home.cx, y: home.cy } : plazaCenter(p);
  if (done.sim) events.push(...causalPlaques(done));
  events.push({
    id: "seed-plaque",
    name: "Seed Plaque",
    x: cx,
    y: cy - 1,
    pages: [
      {
        trigger: "action",
        sprite: null,
        commands: [
          {
            op: "text",
            lines: [
              "<Settlement Plaque>",
              `Grown by rule from seed 0x${p.seed.toString(16).toUpperCase().padStart(8, "0")}.`,
              "Roads, huts, fields and walkers all from one number.",
            ],
          },
        ],
      },
    ],
  });

  const map: MapDef = {
    id: "settlement",
    name: "Grown Settlement",
    width: exportWidth,
    height: p.height,
    sheets: [SHEET.id],
    ground,
    upper,
    passage,
    events,
  };

  // Start the player on a plaza road cell no villager owns.
  const claimed = new Set(events.filter((e) => e.id.startsWith("villager-")).map((e) => e.y * p.width + e.x));
  let sx = cx;
  let sy = cy + 1;
  outer: for (let radius = 0; radius <= (done.sim ? 4 : 2); radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x >= p.width - 1 || y >= p.height - 1) continue;
        const i = y * p.width + x;
        if (done.road[i] === 1 && !claimed.has(i)) {
          sx = x;
          sy = y;
          break outer;
        }
      }
    }
  }

  return {
    format: "rpgkit-project/v1",
    title: `Grown Settlement 0x${p.seed.toString(16).toUpperCase().padStart(8, "0")}`,
    tileSize: 16,
    start: { map: "settlement", x: sx, y: sy, dir: "down" },
    sheets: [{ ...SHEET }],
    items: [],
    sprites: {
      villager: { kind: "image", src: "assets/grow-villager.png" },
    },
    maps: [map],
  };
}

/** Grow a seed to completion and emit its playable project. */
export function generateProject(params: GrowState["params"]): Project {
  return growProject(growToDone(params));
}
