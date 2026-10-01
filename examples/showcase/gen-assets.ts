// Deterministically generate the feature gallery's complete visual payload
// from its small, attributed set of Tuxemon source art: streamed CLUT8+RLE
// map chunks, native animated water, 16x32 walkers, map animations, portraits,
// battle sprites, and GameAssets.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import { cookAnimationAtlases, animatedManifestSource } from "../../tools/lib/animated.ts";
import {
  encodeStreamedLayer,
  pakManifest,
  streamEntryFile,
  streamManifestSource,
  type StreamEntry,
  type StreamedLayer,
} from "../../tools/lib/stream.ts";
import type { MapDef } from "../../src/engine/types.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../../src/engine/name-input.ts";
import { buildShowcaseProject, SHOWCASE_HALLS } from "./showcase-data.ts";
import { SHOWCASE_EXTENSIONS } from "./extensions.ts";
import { showcaseBattleRules } from "./showcase-battle-rules.ts";
import { prepareShowcaseArt, showcaseMapArt } from "./showcase-art.ts";
import { recordShowcaseTour } from "./tour.ts";

const HERE = import.meta.dir;
const ASSETS = join(HERE, "assets");
const TUXEMON = join(ASSETS, "tuxemon", "mods", "tuxemon");
const TILE = 16;
const CHUNK = 128;
type Rgba = readonly [number, number, number, number];

mkdirSync(join(ASSETS, "stream"), { recursive: true });
mkdirSync(join(ASSETS, "anim"), { recursive: true });
mkdirSync(join(ASSETS, "map-anim"), { recursive: true });
mkdirSync(join(HERE, "data"), { recursive: true });

function put(out: Uint8Array, width: number, x: number, y: number, colour: Rgba): void {
  if (x < 0 || y < 0 || x >= width || (y * width + x) * 4 >= out.length) return;
  out.set(colour, (y * width + x) * 4);
}

function rect(out: Uint8Array, width: number, x: number, y: number, w: number, h: number, colour: Rgba): void {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put(out, width, px, py, colour);
}

function layerChunks(map: MapDef, source: Uint8Array): { chunks: Uint8Array[]; columns: number; rows: number } {
  const columns = Math.ceil((map.width * TILE) / CHUNK);
  const rows = Math.ceil((map.height * TILE) / CHUNK);
  const worldW = map.width * TILE;
  const worldH = map.height * TILE;
  return {
    columns,
    rows,
    chunks: Array.from({ length: columns * rows }, (_, index) => {
      const out = new Uint8Array(CHUNK * CHUNK * 4);
      const cx = index % columns;
      const cy = Math.floor(index / columns);
      for (let y = 0; y < CHUNK; y++) {
        const worldY = cy * CHUNK + y;
        if (worldY >= worldH) break;
        const sourceX = cx * CHUNK;
        const copyWidth = Math.min(CHUNK, worldW - sourceX);
        if (copyWidth <= 0) continue;
        const from = (worldY * worldW + sourceX) * 4;
        out.set(source.subarray(from, from + copyWidth * 4), y * CHUNK * 4);
      }
      return out;
    }),
  };
}

// The workshop gate is Tuxemon's crate front, streamed as its own layer so
// the room can switch it on and off.
const GATE_TILE = { x: 496, y: 32 } as const;
function gateChunks(map: MapDef): { chunks: Uint8Array[]; columns: number; rows: number } {
  const columns = Math.ceil((map.width * TILE) / CHUNK);
  const rows = Math.ceil((map.height * TILE) / CHUNK);
  const chunks = Array.from({ length: columns * rows }, () => new Uint8Array(CHUNK * CHUNK * 4));
  const city = sourceImage("gfx/tilesets/core_city_and_country.png");
  const crate = cropPixels(city, GATE_TILE.x, GATE_TILE.y, TILE, TILE);
  const gx = 12 * TILE;
  const gy = 7 * TILE;
  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      const wx = gx + px;
      const wy = gy + py;
      const chunk = chunks[Math.floor(wy / CHUNK) * columns + Math.floor(wx / CHUNK)]!;
      chunk.set(crate.subarray((py * TILE + px) * 4, (py * TILE + px) * 4 + 4), ((wy % CHUNK) * CHUNK + wx % CHUNK) * 4);
    }
  }
  return { chunks, columns, rows };
}

await prepareShowcaseArt();
const project = buildShowcaseProject();
writeFileSync(join(HERE, "data", "showcase.json"), JSON.stringify(project, null, 2) + "\n");

const entries: StreamEntry[] = [];
const streamed = new Map<string, { ground: StreamedLayer; upper: StreamedLayer }>();
for (const map of project.maps) {
  const art = showcaseMapArt(map);
  const ground = layerChunks(map, art.ground);
  const upper = layerChunks(map, art.upper);
  const g = encodeStreamedLayer(`showcase-${map.id}-ground`, ground.chunks, ground.columns, ground.rows, { chunkPx: CHUNK });
  const u = encodeStreamedLayer(`showcase-${map.id}-upper`, upper.chunks, upper.columns, upper.rows, { chunkPx: CHUNK });
  // Palette quantization would change prop pixels; the art must stream losslessly.
  if (g.report.quantized || u.report.quantized) throw new Error(`showcase gen-assets: ${map.id} chunks were quantized`);
  entries.push(...g.entries, ...u.entries);
  streamed.set(map.id, { ground: g.layer, upper: u.layer });
}

const appearanceId = SHOWCASE_HALLS.find((hall) => hall.number === 3)?.id;
const appearanceMap = project.maps.find((map) => map.id === appearanceId);
if (!appearanceMap) throw new Error("showcase gen-assets: hall-appearance is missing");
const gate = gateChunks(appearanceMap);
const gateLayer = encodeStreamedLayer("showcase-gate", gate.chunks, gate.columns, gate.rows, { chunkPx: CHUNK });
entries.push(...gateLayer.entries);

for (const entry of entries) {
  const path = join(HERE, streamEntryFile(entry.key));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entry.blob);
}
const audioEntries = [
  { key: "audio:wav.showcase-town", file: "assets/tuxemon/mods/tuxemon/music/JRPG_town_loop.wav" },
  { key: "audio:wav.showcase-coinecho", file: "assets/tuxemon/mods/tuxemon/sounds/setting/coinecho.wav" },
  { key: "audio:wav.showcase-bark", file: "assets/tuxemon/mods/tuxemon/sounds/monster/Bark.wav" },
  { key: "audio:wav.showcase-ice", file: "assets/tuxemon/mods/tuxemon/sounds/monster/Ice.wav" },
] as const;
writeFileSync(
  join(HERE, "pak.json"),
  JSON.stringify([...pakManifest(entries), ...audioEntries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), null, 2) + "\n",
);

const imageMeta: Record<string, { psm: number }> = {};
function writeImage(file: string, bytes: Uint8Array, width: number, height: number, psm = 3): string {
  const path = `assets/${file}`;
  mkdirSync(dirname(join(HERE, path)), { recursive: true });
  writeFileSync(join(HERE, path), encodePNG(bytes, width, height));
  imageMeta[path] = { psm };
  return path;
}

interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function sourceImage(relative: string): Bitmap {
  return decodePng(new Uint8Array(readFileSync(join(TUXEMON, relative))));
}

function cropPixels(source: Bitmap, x: number, y: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const offset = ((y + row) * source.width + x) * 4;
    out.set(source.rgba.subarray(offset, offset + width * 4), row * width * 4);
  }
  return out;
}

function scaleNearest(source: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  const out = new Uint8Array(width * scale * height * scale * 4);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) {
      const from = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
      out.set(source.subarray(from, from + 4), (y * width * scale + x) * 4);
    }
  }
  return out;
}

function resizeNearest(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
      const sy = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
      const from = (sy * sourceWidth + sx) * 4;
      out.set(source.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return out;
}

function gradePixels(bytes: Uint8Array, tint: readonly [number, number, number]): void {
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = Math.round(bytes[i]! * tint[0] / 255);
    bytes[i + 1] = Math.round(bytes[i + 1]! * tint[1] / 255);
    bytes[i + 2] = Math.round(bytes[i + 2]! * tint[2] / 255);
  }
}

function portrait(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(64 * 64 * 4);
  rect(out, 64, 0, 0, 64, 64, [31, 44, 61, 255]);
  const enlarged = scaleNearest(frame, 16, 32, 2);
  for (let y = 0; y < 64; y++) {
    const from = y * 32 * 4;
    out.set(enlarged.subarray(from, from + 32 * 4), (y * 64 + 16) * 4);
  }
  return out;
}

type Walker = { idle: string[]; walkL: string[]; walkR: string[] };
function writeWalker(name: string, source: Bitmap): Walker {
  const frames: Walker = { idle: [], walkL: [], walkR: [] };
  // Tuxemon rows are down, left, right, up; RPG Kit order is down, left, up, right.
  const sourceRows = [0, 1, 3, 2];
  for (let facing = 0; facing < 4; facing++) {
    const row = sourceRows[facing]!;
    frames.idle.push(writeImage(`${name}-idle-${facing}.png`, cropPixels(source, 16, row * 32, 16, 32), 16, 32));
    frames.walkL.push(writeImage(`${name}-left-${facing}.png`, cropPixels(source, 0, row * 32, 16, 32), 16, 32));
    frames.walkR.push(writeImage(`${name}-right-${facing}.png`, cropPixels(source, 32, row * 32, 16, 32), 16, 32));
  }
  return frames;
}

// Information signs use Tuxemon's wooden signpost, bottom-aligned in its cell.
const SIGNPOST = { x: 560, y: 32, w: 16, h: 14 } as const;
function signpost(): Uint8Array {
  const city = sourceImage("gfx/tilesets/core_city_and_country.png");
  const out = new Uint8Array(TILE * TILE * 4);
  const pixels = cropPixels(city, SIGNPOST.x, SIGNPOST.y, SIGNPOST.w, SIGNPOST.h);
  out.set(pixels, (TILE - SIGNPOST.h) * TILE * 4);
  return out;
}

const staticSprites = {
  sign: writeImage("sign.png", signpost(), 16, 16),
};

const playerSheet = sourceImage("sprites/girl1.png");
const curatorSheet = sourceImage("sprites/boss.png");
const guideSheet = sourceImage("sprites/knight.png");
const visitorSheet: Bitmap = {
  width: guideSheet.width,
  height: guideSheet.height,
  rgba: guideSheet.rgba.slice(),
};
gradePixels(visitorSheet.rgba, [236, 172, 255]);
const player = writeWalker("player", playerSheet);
const curator = writeWalker("curator", curatorSheet);
const guide = writeWalker("guide", guideSheet);
const alternate = writeWalker("alternate", visitorSheet);

const curatorFace = portrait(cropPixels(curatorSheet, 16, 0, 16, 32));
writeImage("face-curator.png", curatorFace, 64, 64);
const guideFace = portrait(cropPixels(guideSheet, 16, 0, 16, 32));
writeImage("face-guide.png", guideFace, 64, 64);
const visitorFace = portrait(cropPixels(visitorSheet, 16, 0, 16, 32));
writeImage("face-visitor.png", visitorFace, 64, 64);

const bamboon = sourceImage("gfx/sprites/battle/bamboon-sheet.png");
const bigfin = sourceImage("gfx/sprites/battle/bigfin-sheet.png");
writeImage("battle-player.png", cropPixels(bigfin, 0, 0, 64, 64), 64, 64);
writeImage("battle-enemy.png", cropPixels(bamboon, 64, 0, 64, 64), 64, 64);
const battleScene = sourceImage("gfx/ui/combat/cavern_background.png");
const battleBackground = writeImage(
  "battle-background.png",
  resizeNearest(battleScene.rgba, battleScene.width, battleScene.height, 256, 128),
  256,
  128,
);

const city = sourceImage("gfx/tilesets/core_city_and_country.png");
const sparkFrames = [16, 17, 18, 19].map((column, index) => ({
  rgba: cropPixels(city, column * TILE, 0, TILE, TILE),
  durationMs: index === 0 ? 100 : undefined,
}));
const nativeAnim = cookAnimationAtlases([{ id: "water-spark", frames: sparkFrames }], {
  directory: "assets/anim",
  prefix: "spark",
});
for (const atlas of nativeAnim.atlases) {
  mkdirSync(dirname(join(HERE, atlas.file)), { recursive: true });
  writeFileSync(join(HERE, atlas.file), atlas.png);
}
writeFileSync(join(HERE, "sprites.json"), JSON.stringify(nativeAnim.spritesJson, null, 2) + "\n");

const mapAnimFrames: string[] = [];
const blueCircle = sourceImage("animations/technique/blue_circle.png");
for (let i = 0; i < 10; i++) {
  mapAnimFrames.push(writeImage(
    `map-anim/pulse-${i}.png`,
    cropPixels(blueCircle, i * 64, 0, 64, 64),
    64,
    64,
  ));
}
writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

const mapSpecs = project.maps.map((map) => ({
  id: map.id,
  width: map.width,
  height: map.height,
  ground: streamed.get(map.id)!.ground,
  upper: streamed.get(map.id)!.upper,
}));
const streamSource = streamManifestSource(mapSpecs, { chunkPx: CHUNK, margin: 16, loadBudget: 2 });
const animatedSource = animatedManifestSource([
  {
    id: "hall-streaming",
    tiles: Array.from({ length: 12 }, (_, i) => {
      const local = i % 6;
      return {
        x: 13 + local % 2,
        y: (i < 6 ? 2 : 10) + Math.floor(local / 2),
        above: i % 3 === 0,
        sprite: nativeAnim.atlasFor.get("water-spark")!,
      };
    }),
  },
]);
const q = JSON.stringify;
const walkerSource = (frames: Walker) => `{
    idle: ${q(frames.idle)},
    walkL: ${q(frames.walkL)},
    walkR: ${q(frames.walkR)},
    h: 32 as const,
  }`;
const world = Object.fromEntries(project.maps.map((map) => [map.id, { w: map.width * TILE, h: map.height * TILE }]));
const maxActors = Math.max(...project.maps.map((map) => map.events?.length ?? 0));

writeFileSync(
  join(HERE, "assets-game.ts"),
  `// AUTO-GENERATED by examples/showcase/gen-assets.ts — do not edit.\n` +
  `import type { GameAssets } from "../../src/ui/game-assets.ts";\n\n` +
  `const PLAYER = ${walkerSource(player)} as const;\n` +
  `const CURATOR = ${walkerSource(curator)} as const;\n` +
  `const GUIDE = ${walkerSource(guide)} as const;\n` +
  `const ALTERNATE = ${walkerSource(alternate)} as const;\n\n` +
  `const STATIC = ${q(staticSprites)} as const;\n\n` +
  `export const GAME_ASSETS: GameAssets = {\n` +
  `  ground: {}, upper: {}, chunkColumns: {}, maxChunks: 0, maxActors: ${maxActors},\n` +
  `  world: ${q(world)},\n` +
  `  order: ${q(project.maps.map((map) => map.id))},\n` +
  `  npcSrc: { ...STATIC, curator: CURATOR, guide: GUIDE, runner: GUIDE, alternate: ALTERNATE },\n` +
  `  player: PLAYER, playerHeight: 32,\n` +
  `  stream: ${streamSource},\n` +
  `  animated: ${animatedSource},\n` +
  `  anims: {\n` +
  `    "showcase-pulse": { frames: ${q(mapAnimFrames)}, w: 64, h: 64 },\n` +
  `    "showcase-ring": { frames: ${q([...mapAnimFrames].reverse())}, w: 64, h: 64 },\n` +
  `  },\n` +
  `  layers: {\n` +
  `    gate: { placement: "above", mode: "streamed", defaultVariant: "closed", defaultVisible: true, variants: { closed: { refs: { ${q(appearanceMap.id)}: ${q(gateLayer.layer.refs)} }, columns: { ${q(appearanceMap.id)}: ${gateLayer.layer.columns} }, chunkPx: ${CHUNK} } } },\n` +
  `    weather: { placement: "screen", defaultVisible: false, variants: { day: { color: "#ffe8a040", opacity: 0.32 }, dusk: { color: "#ef6a8058", opacity: 0.42 }, night: { color: "#163a9070", opacity: 0.52 } } },\n` +
  `    backdrop: { placement: "screen", defaultVisible: false, variants: { gallery: { color: "#251144", opacity: 1 }, stars: { color: "#07142e", opacity: 1 } } },\n` +
  `  },\n` +
  `};\n\n` +
  `export const SHOWCASE_ART = { face: "assets/face-curator.png", guideFace: "assets/face-guide.png", visitorFace: "assets/face-visitor.png", battlePlayer: "assets/battle-player.png", battleEnemy: "assets/battle-enemy.png", battleBackground: ${q(battleBackground)} } as const;\n`,
);

const tour = recordShowcaseTour(project, {
  extensions: SHOWCASE_EXTENSIONS,
  battle: showcaseBattleRules,
  scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
});
writeFileSync(
  join(HERE, "demo-tape.ts"),
  `// AUTO-GENERATED by examples/showcase/gen-assets.ts — do not edit.\n` +
  `export const SHOWCASE_TOUR_FRAMES = ${tour.masks.length};\n` +
  `export const SHOWCASE_TOUR_VISITS = ${q(tour.visits)} as const;\n` +
  `export const SHOWCASE_TOUR_RUNS: readonly (readonly [number, number])[] = ${q(tour.runs)};\n`,
);

console.log(
  `showcase gen-assets: ${project.maps.length} streamed maps, ${entries.length} TILESET entries, ` +
  `${entries.reduce((sum, entry) => sum + entry.blob.length, 0)} bytes, 48 walker frames, ` +
  `${tour.masks.length}-frame attract tour`,
);
