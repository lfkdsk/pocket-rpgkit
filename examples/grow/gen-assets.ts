// examples/grow/gen-assets.ts — bake the rule-grown world's art.
//
//   bun examples/grow/gen-assets.ts   (or `bun run gen-assets` for all)
//
// Inputs (assets/src, see ATTRIBUTION.md): the Ninja Adventure CC0 sheets
// under ninja-adventure/ and the Sharm "Tiny 16" walker frames the player
// shares with the Sunstone example (assets/player-*.png, CC-BY 3.0).
// Outputs (committed; every byte is regenerated from the inputs and the
// recipes in grow-art.ts):
//   assets/grow-*.png        terrain fills/blocks/transitions, ground and
//                            upper cells, stamps, the villager
//   assets-grow.ts           the manifest GrowView reads (full literals)
//   images.json              PSM_4444 marks
//   data/grow-settlement.json  the default seed's village exported as an
//                            rpgkit-project/v1 document

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import { TILE } from "../../src/engine/tiles.ts";
import { blitTile } from "../../tools/lib/chunks.ts";
import { DEFAULT_PARAMS, GROW_TILE } from "./grow.ts";
import { STAMP_LIST } from "./grow-stamps.ts";
import { terrainArt, transitionArt, smallArt, climateTree, causalArt, caravanArt } from "./grow-art.ts";
import { generateProject } from "./grow-project.ts";

const HERE = new URL(".", import.meta.url).pathname; // examples/grow/
const ASSETS = join(HERE, "assets");
const SRC = join(ASSETS, "src");

// The player is the Sharm walker, the same 12 static frames as the
// Sunstone example; they are committed here next to the grow art.
const idle = [0, 1, 2, 3].map((f) => `assets/player-dir${f}.png`);
const walkL = [0, 1, 2, 3].map((f) => `assets/player-pose${f}-l.png`);
const walkR = [0, 1, 2, 3].map((f) => `assets/player-pose${f}-r.png`);
for (const name of [...idle, ...walkL, ...walkR]) {
  if (!existsSync(join(HERE, name))) throw new Error(`grow gen-assets: missing walker frame ${name}`);
}

// ===========================================================================
// D6 rightward settlement: viewport-windowed Ninja Adventure tiles.
//
// Four reusable 256px fill blocks cover the 65,536px backing strip. The
// renderer repeats them by biome band and mounts 16px cells only along the
// seed-dependent jagged seams and for sparse rule overlays. These crops come
// from the committed Ninja Adventure CC0 source.
// ===========================================================================

const NINJA = join(SRC, "ninja-adventure");
// D3 emitted Kenney-named crops and a 512px base. They are no longer
// consumers of the D6 manifest; remove them when regenerating so the asset
// directory and images.json cannot retain stale validation inputs.
for (const file of [
  "grow-base.png", "grow-ground-0.png", "grow-ground-36.png", "grow-ground-37.png",
  "grow-ground-38.png", "grow-ground-40.png", "grow-ground-41.png", "grow-ground-43.png",
  "grow-upper-3.png", "grow-upper-4.png", "grow-upper-17.png", "grow-upper-30.png",
  "grow-upper-48.png", "grow-upper-49.png", "grow-upper-50.png", "grow-upper-52.png",
  "grow-upper-53.png", "grow-upper-54.png", "grow-upper-60.png", "grow-upper-61.png",
  "grow-upper-62.png", "grow-upper-65.png", "grow-upper-66.png", "grow-upper-67.png",
  "grow-upper-68.png", "grow-upper-69.png", "grow-upper-70.png", "grow-upper-71.png",
]) rmSync(join(ASSETS, file), { force: true });
const ninjaFloor = decodePng(new Uint8Array(await Bun.file(join(NINJA, "tileset-floor.png")).arrayBuffer()));
const ninjaVillage = decodePng(new Uint8Array(await Bun.file(join(NINJA, "tileset-village.png")).arrayBuffer()));
const ninjaSamurai = decodePng(new Uint8Array(await Bun.file(join(NINJA, "samurai-green.png")).arrayBuffer()));
const cropCell = (atlas: { width: number; height: number; rgba: Uint8Array }, x: number, y: number): Uint8Array => {
  if ((x + 1) * TILE > atlas.width || (y + 1) * TILE > atlas.height) throw new Error(`Ninja cell ${x},${y} outside ${atlas.width}x${atlas.height}`);
  const out = new Uint8Array(TILE * TILE * 4);
  for (let py = 0; py < TILE; py++) {
    const src = ((y * TILE + py) * atlas.width + x * TILE) * 4;
    out.set(atlas.rgba.subarray(src, src + TILE * 4), py * TILE * 4);
  }
  return out;
};

// D6h terrain uses one restrained palette and a three-cell broken edge.
// These build-time recipes keep runtime texture uploads at zero.
const TERRAIN_FAMILY = ["grass", "mud", "sand", "snow"] as const;
const terrainFiles: string[] = [];
const terrainManifest: Record<string, Record<"fill" | "transition" | "blend" | "fringe", string>> = {};
const terrainBlockManifest: Record<string, string> = {};
const terrainFill = TERRAIN_FAMILY.map((_, biome) => terrainArt(biome));
for (let biome = 0; biome < TERRAIN_FAMILY.length; biome++) {
  const fill = terrainFill[biome]!;
  const transition = transitionArt(biome, 0);
  const fillPath = `assets/grow-terrain-${biome}-fill.png`;
  const transitionPath = `assets/grow-terrain-${biome}-transition.png`;
  const blendPath = `assets/grow-terrain-${biome}-blend.png`;
  const fringePath = `assets/grow-terrain-${biome}-fringe.png`;
  terrainManifest[biome] = { fill: fillPath, transition: transitionPath, blend: blendPath, fringe: fringePath };
  writeFileSync(join(ASSETS, `grow-terrain-${biome}-blend.png`), encodePNG(transitionArt(biome, 1), TILE, TILE));
  writeFileSync(join(ASSETS, `grow-terrain-${biome}-fringe.png`), encodePNG(transitionArt(biome, 2), TILE, TILE));
  terrainFiles.push(blendPath, fringePath);
  writeFileSync(join(ASSETS, `grow-terrain-${biome}-fill.png`), encodePNG(fill, TILE, TILE));
  writeFileSync(join(ASSETS, `grow-terrain-${biome}-transition.png`), encodePNG(transition, TILE, TILE));
  const blockPx = TILE * 16;
  const block = new Uint8Array(blockPx * blockPx * 4);
  for (let ty = 0; ty < 16; ty++) for (let tx = 0; tx < 16; tx++) {
    blitTile(block, blockPx, tx * TILE, ty * TILE, fill);
  }
  const blockPath = `assets/grow-terrain-${biome}-block.png`;
  terrainBlockManifest[biome] = blockPath;
  writeFileSync(join(ASSETS, `grow-terrain-${biome}-block.png`), encodePNG(block, blockPx, blockPx));
  terrainFiles.push(fillPath, transitionPath, blockPath);
  rmSync(join(ASSETS, `grow-terrain-${biome}-left.png`), { force: true });
  rmSync(join(ASSETS, `grow-terrain-${biome}-right.png`), { force: true });
}

// Small props and ground use grow-art recipes. Whole houses and broadleaf
// silhouettes are resampled from the CC0 abandoned-village atlas.
const GROW_GROUND_SOURCE: Record<number, readonly [number, number]> = {
  [GROW_TILE.ROAD_H]: [1, 8], [GROW_TILE.ROAD_V]: [3, 8],
  [GROW_TILE.ROAD_CROSS]: [8, 8], [GROW_TILE.PLAZA]: [1, 8],
  [GROW_TILE.FARM_A]: [1, 12], [GROW_TILE.FARM_B]: [2, 12],
  [GROW_TILE.BRIDGE_H]: [6, 5], [GROW_TILE.WATER]: [1, 22],
  [GROW_TILE.FLOWERS]: [3, 12], [GROW_TILE.ORCHARD]: [4, 12],
  [GROW_TILE.WORK_YARD]: [13, 19], [GROW_TILE.OASIS]: [1, 22],
  [GROW_TILE.BANK_L]: [1, 22], [GROW_TILE.BANK_R]: [1, 22],
  [GROW_TILE.WINTER_PLOT]: [1, 19], [GROW_TILE.MARKET_RUG]: [5, 5],
};
const GROW_UPPER_SOURCE: Record<number, readonly [number, number]> = {
  [GROW_TILE.ROOF_L]: [12, 7], [GROW_TILE.ROOF_M]: [13, 7], [GROW_TILE.ROOF_R]: [14, 7],
  [GROW_TILE.WALL_L]: [12, 9], [GROW_TILE.DOOR]: [13, 9], [GROW_TILE.WALL_R]: [14, 9],
  [GROW_TILE.FENCE_H]: [7, 3], [GROW_TILE.FENCE_V]: [6, 5],
  [GROW_TILE.TREE]: [1, 6], [GROW_TILE.BUSH]: [4, 5],
  [GROW_TILE.WELL]: [5, 2], [GROW_TILE.NOTICE]: [9, 11],
  [GROW_TILE.LOGS]: [6, 7], [GROW_TILE.ROCK]: [8, 2],
  [GROW_TILE.PALM]: [11, 6], [GROW_TILE.CACTUS]: [11, 7],
  [GROW_TILE.FIR]: [11, 8], [GROW_TILE.FIREWOOD]: [5, 7],
  [GROW_TILE.TENT_L]: [17, 10], [GROW_TILE.TENT_M]: [18, 10], [GROW_TILE.TENT_R]: [19, 10],
  [GROW_TILE.STALL]: [18, 11], [GROW_TILE.FLOWER_PROP]: [4, 4],
  [GROW_TILE.GRASS_TUFT]: [4, 5], [GROW_TILE.SNOW_SHRUB]: [8, 3],
  [GROW_TILE.BRIDGE_RAIL]: [15, 11],
  [GROW_TILE.TENT_WALL_L]: [17, 11], [GROW_TILE.TENT_DOOR]: [18, 11], [GROW_TILE.TENT_WALL_R]: [19, 11],
  [GROW_TILE.SNOW_ROOF_L]: [12, 7], [GROW_TILE.SNOW_ROOF_M]: [13, 7], [GROW_TILE.SNOW_ROOF_R]: [14, 7],
  [GROW_TILE.SNOW_WALL_L]: [12, 9], [GROW_TILE.SNOW_DOOR]: [13, 9], [GROW_TILE.SNOW_WALL_R]: [14, 9],
};
const TREE_SOURCE: readonly (readonly [number, number])[] = [
  [4, 6], [5, 6], [4, 7], [5, 7], [4, 8], [5, 8],
] as const;
for (let biome = 0; biome < 4; biome++) for (let part = 0; part < TREE_SOURCE.length; part++) {
  GROW_UPPER_SOURCE[46 + biome * TREE_SOURCE.length + part] = TREE_SOURCE[part]!;
}
const GROW_GROUND_CELLS = Object.keys(GROW_GROUND_SOURCE).map(Number);
const GROW_UPPER_CELLS = Object.keys(GROW_UPPER_SOURCE).map(Number);
const growGroundFiles: string[] = [];
const growUpperFiles: string[] = [];
for (const cell of GROW_GROUND_CELLS) {
  const file = `grow-ground-${cell}.png`;
  const [x, y] = GROW_GROUND_SOURCE[cell]!;
  writeFileSync(join(ASSETS, file), encodePNG(smallArt(cell, true) ?? cropCell(ninjaFloor, x, y), TILE, TILE));
  growGroundFiles.push(`assets/${file}`);
}
for (const cell of GROW_UPPER_CELLS) {
  const file = `grow-upper-${cell}.png`;
  const [x, y] = GROW_UPPER_SOURCE[cell]!;
  let art = climateTree(cell) ?? smallArt(cell, false) ?? cropCell(ninjaVillage, x, y);
  // Resample complete atlas objects before splitting them into semantic cells.
  // The former crops skipped the middle house row and made broken facades.
  const housePart = cell >= 20 && cell <= 25 ? cell - 20 : cell >= 73 && cell <= 78 ? cell - 73
    : cell >= 38 && cell <= 40 ? cell - 38 : cell >= 70 && cell <= 72 ? cell - 67 : -1;
  if (housePart >= 0 || (cell >= 52 && cell < 58)) {
    const tree = cell >= 52 && cell < 58, tent = cell >= 38 && cell <= 40 || cell >= 70 && cell <= 72;
    const part = tree ? cell - 52 : housePart;
    const cols = tree ? 2 : 3, rows = tree ? 3 : 2;
    const sx = tree ? 0 : tent ? 17 : 12, sy = tree ? 6 : tent ? 0 : 6;
    const sw = tree ? 4 : tent ? 3 : 4, sh = tree ? 3 : tent ? 3 : 5;
    art = new Uint8Array(1024);
    for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
      const ax = sx * 16 + Math.floor(((part % cols) * 16 + px) * sw / cols);
      const ay = sy * 16 + Math.floor((Math.floor(part / cols) * 16 + py) * sh / rows);
      const at = (ay * ninjaVillage.width + ax) * 4;
      art.set(ninjaVillage.rgba.subarray(at, at + 4), (py * 16 + px) * 4);
    }
  }
  if (cell >= 52 && cell < 58) {
    const biome = Math.floor((cell - 46) / 6);
    for (let p = 0; p < art.length; p += 4) {
      if (art[p + 3] === 0) continue;
      const r = art[p]!, g = art[p + 1]!, b = art[p + 2]!;
      if (biome === 1) { art[p] = Math.round(r * 0.74); art[p + 1] = Math.round(g * 0.69); art[p + 2] = Math.round(b * 0.62); }
      if (biome === 2) { art[p] = Math.min(255, Math.round(r * 1.12 + 18)); art[p + 1] = Math.round(g * 0.78); art[p + 2] = Math.round(b * 0.48); }
      if (biome === 3) { const l = Math.round((r + g + b) / 3); art[p] = Math.min(255, l + 72); art[p + 1] = Math.min(255, l + 80); art[p + 2] = Math.min(255, l + 92); }
    }
  } else if (cell >= 73 && cell <= 78) {
    for (let p = 0; p < art.length; p += 4) {
      if (art[p + 3] === 0) continue;
      const r = art[p]!, g = art[p + 1]!, b = art[p + 2]!;
      if (g > r * 0.9 && g > b * 1.1) {
        const l = Math.round((r + g + b) / 3);
        art[p] = Math.min(255, l + 68); art[p + 1] = Math.min(255, l + 76); art[p + 2] = Math.min(255, l + 88);
      }
    }
  }
  writeFileSync(join(ASSETS, file), encodePNG(art, TILE, TILE));
  growUpperFiles.push(`assets/${file}`);
}
// Stamps cut from the full CC0 Ninja Adventure pack (TilesetNature,
// TilesetHouse, TilesetDesert): one 16px PNG per stamp cell, ids from
// engine/grow-stamps.ts. The sheets are copied into assets/src once.
const STAMP_SHEET_FILES = { nature: "TilesetNature.png", house: "TilesetHouse.png", desert: "TilesetDesert.png" } as const;
const stampSheets = Object.fromEntries(
  await Promise.all(Object.entries(STAMP_SHEET_FILES).map(async ([k, f]) =>
    [k, decodePng(new Uint8Array(await Bun.file(join(NINJA, f)).arrayBuffer()))] as const)),
) as Record<keyof typeof STAMP_SHEET_FILES, ReturnType<typeof decodePng>>;
const STAMP_CELLS: number[] = [];
for (const st of STAMP_LIST) {
  for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) {
    const cell = st.base + dy * st.w + dx;
    const file = `grow-upper-${cell}.png`;
    const art = cropCell(stampSheets[st.sheet], st.sx + dx, st.sy + dy);
    // Igloos ship with a lavender shade that reads pink on the cool snow floor;
    // pull those tones toward ice blue.
    if (st.key.startsWith("igloo")) for (let p = 0; p < art.length; p += 4) {
      const r = art[p]!, g = art[p + 1]!, b = art[p + 2]!;
      if (art[p + 3] && r > g && b > g) { art[p] = Math.round(g + (r - g) * 0.2); art[p + 2] = Math.min(255, b + 6); }
    }
    writeFileSync(join(ASSETS, file), encodePNG(art, TILE, TILE));
    growUpperFiles.push(`assets/${file}`);
    STAMP_CELLS.push(cell);
  }
}
// Causal world cells (worn trails, paved road, quarry floor, ruins) and the
// trade caravan: pure grow-art recipes, kept out of GROW_GROUND/GROW_UPPER so
// the records other examples copy stay unchanged.
const GROW_SIM_GROUND_CELLS = [
  GROW_TILE.WORN_GRASS, GROW_TILE.WORN_MUD, GROW_TILE.WORN_SAND, GROW_TILE.WORN_SNOW,
  GROW_TILE.PATH_STONE, GROW_TILE.GRAVEL,
];
const GROW_SIM_UPPER_CELLS = [GROW_TILE.RUIN_L, GROW_TILE.RUIN_M, GROW_TILE.RUIN_R, GROW_TILE.RUBBLE];
const growSimFiles: string[] = [];
for (const [kind, cells] of [["ground", GROW_SIM_GROUND_CELLS], ["upper", GROW_SIM_UPPER_CELLS]] as const) {
  for (const cell of cells) {
    const art = causalArt(cell);
    if (!art) throw new Error(`grow gen-assets: no causal recipe for cell ${cell}`);
    writeFileSync(join(ASSETS, `grow-${kind}-${cell}.png`), encodePNG(art, TILE, TILE));
    growSimFiles.push(`assets/grow-${kind}-${cell}.png`);
  }
}
const growCaravanFile = "assets/grow-caravan.png";
writeFileSync(join(ASSETS, "grow-caravan.png"), encodePNG(caravanArt(), TILE, TILE));
const growVillagerFile = "assets/grow-villager.png";
writeFileSync(join(ASSETS, "grow-villager.png"), encodePNG(cropCell(ninjaSamurai, 0, 0), TILE, TILE));

const GROW = DEFAULT_PARAMS;
const growProj = generateProject(DEFAULT_PARAMS);
writeFileSync(join(HERE, "data", "grow-settlement.json"), JSON.stringify(growProj, null, 2) + "\n");

const imageMeta: Record<string, { psm: number }> = {};
for (const name of [...terrainFiles, ...growGroundFiles, ...growUpperFiles, growVillagerFile, ...growSimFiles, growCaravanFile]) {
  imageMeta[name] = { psm: 2 };
}
writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

const growManifest =
  `// AUTO-GENERATED by examples/grow/gen-assets.ts — D6 Ninja Adventure\n` +
  `// repeated terrain blocks, seam cells, and sparse overlays. Full literals\n` +
  `// let tools/build.ts bake them. The renderer mounts one live window.\n\n` +
  `export const GROW_WORLD_W = ${GROW.width * TILE};\n` +
  `export const GROW_WORLD_H = ${GROW.height * TILE};\n` +
  `export const GROW_TILE_W = ${GROW.width};\n` +
  `export const GROW_TILE_H = ${GROW.height};\n\n` +
  `export const GROW_TERRAIN: Record<number, Record<"fill" | "transition" | "blend" | "fringe", string>> = {\n` +
  Object.entries(terrainManifest).map(([biome, files]) => `  ${biome}: { fill: ${JSON.stringify(files.fill)}, transition: ${JSON.stringify(files.transition)}, blend: ${JSON.stringify(files.blend)}, fringe: ${JSON.stringify(files.fringe)} },`).join("\n") +
  `\n};\n\n` +
  `export const GROW_TERRAIN_BLOCK: Record<number, string> = {\n` +
  Object.entries(terrainBlockManifest).map(([biome, file]) => `  ${biome}: ${JSON.stringify(file)},`).join("\n") +
  `\n};\n\n` +
  `export const GROW_GROUND: Record<number, string> = {\n` +
  GROW_GROUND_CELLS.map((c) => `  ${c}: ${JSON.stringify(`assets/grow-ground-${c}.png`)},`).join("\n") +
  `\n};\n\n` +
  `export const GROW_UPPER: Record<number, string> = {\n` +
  [...GROW_UPPER_CELLS, ...STAMP_CELLS].map((c) => `  ${c}: ${JSON.stringify(`assets/grow-upper-${c}.png`)},`).join("\n") +
  `\n};\n\n` +
  `export const GROW_SIM_GROUND: Record<number, string> = {\n` +
  GROW_SIM_GROUND_CELLS.map((c) => `  ${c}: ${JSON.stringify(`assets/grow-ground-${c}.png`)},`).join("\n") +
  `\n};\n\n` +
  `export const GROW_SIM_UPPER: Record<number, string> = {\n` +
  GROW_SIM_UPPER_CELLS.map((c) => `  ${c}: ${JSON.stringify(`assets/grow-upper-${c}.png`)},`).join("\n") +
  `\n};\n\n` +
  `export const GROW_CARAVAN = ${JSON.stringify(growCaravanFile)};\n\n` +
  `export const GROW_NPC: Record<string, string> = {\n` +
  `  villager: ${JSON.stringify(growVillagerFile)},\n` +
  `};\n\n` +
  `// Player walker frames (Sharm "Tiny 16"), facing order 0 down, 1 left,\n` +
  `// 2 up, 3 right.\n` +
  `export const GROW_PLAYER = {\n` +
  `  idle: ${JSON.stringify(idle)},\n` +
  `  walkL: ${JSON.stringify(walkL)},\n` +
  `  walkR: ${JSON.stringify(walkR)},\n` +
  `} as const;\n`;
writeFileSync(join(HERE, "assets-grow.ts"), growManifest);

console.log(
  `rpgkit gen-assets grow: Ninja Adventure CC0, world ${GROW.width}x${GROW.height} tiles, ` +
    `${terrainFiles.length} terrain tiles/blocks + ${GROW_GROUND_CELLS.length} ground + ${GROW_UPPER_CELLS.length} upper + 1 villager tile, ` +
    `settlement -> data/grow-settlement.json`,
);
