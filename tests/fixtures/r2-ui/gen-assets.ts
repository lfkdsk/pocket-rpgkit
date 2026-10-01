// Build the animated-tile and 16x32 walker integration fixture. All art is
// procedural so the source sheet, twelve sliced poses, map chunks, sprite
// atlas metadata and GameAssets manifest are reproducible byte for byte.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import {
  bakeMapChunks,
  groundChunkAsset,
  upperChunkAsset,
} from "../../../tools/lib/chunks.ts";
import { loadWalkerSheet } from "../../../tools/lib/bake.ts";
import {
  animatedManifestSource,
  cookAnimationAtlases,
} from "../../../tools/lib/animated.ts";
import { CHUNK_PX, TILE } from "../../../src/engine/tiles.ts";
import {
  ABOVE_ANIMATION,
  R2_MAP,
  R2_MAP_ID,
  R2_MAP_SIZE,
  R2_SECOND_MAP,
  R2_SECOND_MAP_ID,
} from "./fixture-data.ts";

const HERE = import.meta.dir;
const ASSETS = join(HERE, "assets");
mkdirSync(join(ASSETS, "anim"), { recursive: true });

type Rgba = readonly [number, number, number, number];

function solidTile(colour: Rgba): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) out.set(colour, i * 4);
  return out;
}

const ground = new Uint8Array(TILE * TILE * 4);
for (let y = 0; y < TILE; y++) {
  for (let x = 0; x < TILE; x++) {
    const colour: Rgba = ((x >> 2) + (y >> 2)) % 2 === 0
      ? [20, 28, 42, 255]
      : [26, 38, 54, 255];
    ground.set(colour, (y * TILE + x) * 4);
  }
}
const canopy = solidTile([174, 48, 142, 255]);
const baked = bakeMapChunks(
  R2_MAP,
  (id) => id === "fixture.1" ? canopy : ground,
  ground,
);
const bakedSecond = bakeMapChunks(
  R2_SECOND_MAP,
  (id) => id === "fixture.1" ? canopy : ground,
  ground,
);

const imageMeta: Record<string, { psm: number }> = {};
const chunkCount = baked.columns * baked.rows;
for (let i = 0; i < chunkCount; i++) {
  const groundName = groundChunkAsset(R2_MAP_ID, i, chunkCount);
  const upperName = upperChunkAsset(R2_MAP_ID, i, chunkCount);
  writeFileSync(join(HERE, groundName), encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
  writeFileSync(join(HERE, upperName), encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
  imageMeta[groundName] = { psm: 3 };
  imageMeta[upperName] = { psm: 3 };
  const secondUpperName = upperChunkAsset(R2_SECOND_MAP_ID, i, chunkCount);
  writeFileSync(join(HERE, secondUpperName), encodePNG(bakedSecond.upper[i]!, CHUNK_PX, CHUNK_PX));
  imageMeta[secondUpperName] = { psm: 3 };
}

// Tuxemon source layout rows: down, left, right, up. Columns: walk-L,
// idle, walk-R. Every facing has a distinct body colour and every pose a
// distinct foot marker so sim pixels can prove both axes of the selection.
const sourceW = 3 * TILE;
const sourceH = 4 * 32;
const source = new Uint8Array(sourceW * sourceH * 4);
const facingColours: readonly Rgba[] = [
  [246, 92, 92, 255],
  [86, 216, 116, 255],
  [74, 132, 246, 255],
  [246, 206, 74, 255],
];
const poseColours: readonly Rgba[] = [
  [252, 72, 214, 255],
  [238, 238, 244, 255],
  [68, 232, 248, 255],
];

function sourcePixel(col: number, row: number, x: number, y: number, colour: Rgba): void {
  const px = col * TILE + x;
  const py = row * 32 + y;
  source.set(colour, (py * sourceW + px) * 4);
}

for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 3; col++) {
    for (let y = 3; y <= 26; y++) {
      for (let x = 4; x <= 11; x++) {
        const outline = x === 4 || x === 11 || y === 3 || y === 26;
        sourcePixel(col, row, x, y, outline ? [12, 14, 20, 255] : facingColours[row]!);
      }
    }
    // Direction marks in the head keep the four frames visually distinct.
    if (row === 0) {
      sourcePixel(col, row, 6, 9, [12, 14, 20, 255]);
      sourcePixel(col, row, 9, 9, [12, 14, 20, 255]);
    } else if (row === 1) {
      sourcePixel(col, row, 5, 9, [12, 14, 20, 255]);
    } else if (row === 2) {
      sourcePixel(col, row, 10, 9, [12, 14, 20, 255]);
    } else {
      for (let x = 6; x <= 9; x++) sourcePixel(col, row, x, 7, [12, 14, 20, 255]);
    }
    const foot = poseColours[col]!;
    const ranges = col === 0 ? [[2, 6], [9, 11]] : col === 1 ? [[5, 7], [9, 11]] : [[5, 7], [10, 14]];
    for (const [x0, x1] of ranges) {
      for (let y = 27; y <= 30; y++) for (let x = x0!; x <= x1!; x++) {
        sourcePixel(col, row, x, y, foot);
      }
    }
  }
}

const sourceName = "assets/walker-source.png";
writeFileSync(join(HERE, sourceName), encodePNG(source, sourceW, sourceH));
const walker = await loadWalkerSheet(join(HERE, sourceName));
const poseFrames: Record<"idle" | "walkL" | "walkR", string[]> = {
  idle: [],
  walkL: [],
  walkR: [],
};
for (const pose of ["idle", "walkL", "walkR"] as const) {
  for (let facing = 0; facing < 4; facing++) {
    const name = `assets/walker-${pose}-${facing}.png`;
    writeFileSync(join(HERE, name), walker[pose][facing]!);
    imageMeta[name] = { psm: 3 };
    poseFrames[pose].push(name);
  }
}

function animationFrame(colour: Rgba): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) out.set(colour, (y * TILE + x) * 4);
  }
  return out;
}

const animation = cookAnimationAtlases([{
  id: "pulse",
  frames: [
    { rgba: animationFrame([22, 190, 214, 255]), durationMs: 100 },
    { rgba: animationFrame([246, 188, 58, 255]), durationMs: 100 },
    { rgba: animationFrame([124, 96, 238, 255]), durationMs: 100 },
    { rgba: animationFrame([236, 72, 104, 255]), durationMs: 100 },
  ],
}]);
for (const atlas of animation.atlases) writeFileSync(join(HERE, atlas.file), atlas.png);
writeFileSync(join(HERE, "sprites.json"), JSON.stringify(animation.spritesJson, null, 2) + "\n");
writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

const sprite = animation.atlasFor.get("pulse")!;
const animated = animatedManifestSource([{
  id: R2_MAP_ID,
  tiles: [
    ...Array.from({ length: R2_MAP_SIZE.width * R2_MAP_SIZE.height }, (_, index) => ({
      x: index % R2_MAP_SIZE.width,
      y: Math.floor(index / R2_MAP_SIZE.width),
      above: false,
      sprite,
    })),
    { ...ABOVE_ANIMATION, above: true, sprite },
  ],
}]);
const q = JSON.stringify;
const names = (values: readonly string[]): string => `[${values.map((value) => q(value)).join(", ")}]`;
const groundNames = Array.from({ length: chunkCount }, (_, i) => groundChunkAsset(R2_MAP_ID, i, chunkCount));
const upperNames = Array.from({ length: chunkCount }, (_, i) => upperChunkAsset(R2_MAP_ID, i, chunkCount));
const secondUpperNames = Array.from(
  { length: chunkCount },
  (_, i) => upperChunkAsset(R2_SECOND_MAP_ID, i, chunkCount),
);
writeFileSync(
  join(HERE, "assets-game.ts"),
  `// AUTO-GENERATED by tests/fixtures/r2-ui/gen-assets.ts — do not edit.\n` +
    `import type { GameAssets } from "../../../src/ui/game-assets.ts";\n\n` +
    `const WALKER = {\n` +
    `  idle: ${names(poseFrames.idle)} as const,\n` +
    `  walkL: ${names(poseFrames.walkL)} as const,\n` +
    `  walkR: ${names(poseFrames.walkR)} as const,\n` +
    `  h: 32 as const,\n` +
    `};\n\n` +
    `export const GAME_ASSETS: GameAssets = {\n` +
    `  ground: { ${q(R2_MAP_ID)}: ${names(groundNames)}, ${q(R2_SECOND_MAP_ID)}: ${names(groundNames)} },\n` +
    `  upper: { ${q(R2_MAP_ID)}: ${names(upperNames)}, ${q(R2_SECOND_MAP_ID)}: ${names(secondUpperNames)} },\n` +
    `  chunkColumns: { ${q(R2_MAP_ID)}: ${baked.columns}, ${q(R2_SECOND_MAP_ID)}: ${baked.columns} },\n` +
    `  maxChunks: ${chunkCount},\n` +
    `  world: { ${q(R2_MAP_ID)}: { w: ${R2_MAP_SIZE.width * TILE}, h: ${R2_MAP_SIZE.height * TILE} }, ${q(R2_SECOND_MAP_ID)}: { w: ${R2_MAP_SIZE.width * TILE}, h: ${R2_MAP_SIZE.height * TILE} } },\n` +
    `  order: [${q(R2_MAP_ID)}, ${q(R2_SECOND_MAP_ID)}],\n` +
    `  npcSrc: { walker: WALKER, alt: "assets/walker-idle-3.png" },\n` +
    `  player: WALKER,\n` +
    `  playerHeight: 32,\n` +
    `  animated: ${animated},\n` +
    // One minimal art entry so GameView mounts the map-animation and balloon
    // layers; the fixture project spawns no instances, so the layers idle.
    `  anims: { "probe-anim": { frames: ["assets/anim/anim-0.png"], w: 16, h: 16 } },\n` +
    `  layers: {\n` +
    `    ground: { placement: "ground", mode: "eager", variants: { void: { chunks: { ${q(R2_MAP_ID)}: ${names(secondUpperNames)} }, columns: { ${q(R2_MAP_ID)}: ${baked.columns} } } } },\n` +
    `    upper: { placement: "upper", mode: "eager", variants: {} },\n` +
    `    "extra-canopy": { placement: "above", mode: "eager", variants: { on: { chunks: { ${q(R2_MAP_ID)}: ${names(upperNames)} }, columns: { ${q(R2_MAP_ID)}: ${baked.columns} } } } },\n` +
    `    "screen-tint": { placement: "screen", variants: { blue: { color: "#2040c080" } } },\n` +
    `  },\n` +
    `};\n`,
);

console.log(
  `r2-ui fixture: ${R2_MAP_SIZE.width}x${R2_MAP_SIZE.height}, ${chunkCount} map chunks/layer, ` +
  `${R2_MAP_SIZE.width * R2_MAP_SIZE.height + 1} animated placements, 12 walker frames`,
);
