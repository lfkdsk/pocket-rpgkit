// Deterministically generate the feature gallery's complete visual payload:
// streamed CLUT8+RLE map chunks, a native animated-tile atlas, 16x32 walker
// frames, map-animation frames, portraits, battle sprites, and GameAssets.
// All pixels are original procedural shapes; the example has no external art.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { buildShowcaseProject, SHOWCASE_HALLS } from "./showcase-data.ts";
import { SHOWCASE_EXTENSIONS } from "./extensions.ts";
import { showcaseBattleRules } from "./showcase-battle-rules.ts";
import { recordShowcaseTour } from "./tour.ts";

const HERE = import.meta.dir;
const ASSETS = join(HERE, "assets");
const TILE = 16;
const CHUNK = 128;
type Rgba = readonly [number, number, number, number];

mkdirSync(join(ASSETS, "stream"), { recursive: true });
mkdirSync(join(ASSETS, "anim"), { recursive: true });
mkdirSync(join(ASSETS, "map-anim"), { recursive: true });
mkdirSync(join(HERE, "data"), { recursive: true });

function rgba(hex: string, alpha = 255): Rgba {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(value >>> 16) & 255, (value >>> 8) & 255, value & 255, alpha];
}

function mix(a: Rgba, b: Rgba, amount: number): Rgba {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
    Math.round(a[3] + (b[3] - a[3]) * amount),
  ];
}

function put(out: Uint8Array, width: number, x: number, y: number, colour: Rgba): void {
  if (x < 0 || y < 0 || x >= width || (y * width + x) * 4 >= out.length) return;
  out.set(colour, (y * width + x) * 4);
}

function rect(out: Uint8Array, width: number, x: number, y: number, w: number, h: number, colour: Rgba): void {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put(out, width, px, py, colour);
}

function mapPalette(id: string): readonly [Rgba, Rgba] {
  if (id === "showcase-lobby") return [rgba("#102a43"), rgba("#173f5f")];
  const hall = SHOWCASE_HALLS.find((entry) => entry.id === id);
  if (!hall) throw new Error(`showcase gen-assets: no palette for ${id}`);
  return [rgba(hall.palette[0]), rgba(hall.palette[1])];
}

function chunkPixels(map: MapDef, cx: number, cy: number, upper: boolean): Uint8Array {
  const out = new Uint8Array(CHUNK * CHUNK * 4);
  const [dark, light] = mapPalette(map.id);
  const wall = mix(dark, [5, 8, 16, 255], 0.58);
  const path = mix(light, [238, 220, 158, 255], 0.28);
  const trim = mix(light, [255, 255, 255, 255], 0.2);
  const worldW = map.width * TILE;
  const worldH = map.height * TILE;
  for (let y = 0; y < CHUNK; y++) {
    const gy = cy * CHUNK + y;
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x;
      if (gx >= worldW || gy >= worldH) continue;
      const tx = Math.floor(gx / TILE);
      const ty = Math.floor(gy / TILE);
      const lx = gx % TILE;
      const ly = gy % TILE;
      if (!upper) {
        let colour = (tx + ty) % 2 === 0 ? dark : light;
        if (tx === 10 || ty === 7) colour = path;
        if (lx === 0 || ly === 0) colour = mix(colour, wall, 0.22);
        put(out, CHUNK, x, y, colour);
      } else {
        const edge = tx === 0 || ty === 0 || tx === map.width - 1 || ty === map.height - 1;
        if (edge && (lx < 3 || ly < 3 || lx > 12 || ly > 12)) put(out, CHUNK, x, y, wall);
        // A luminous four-corner marker around the room's action curator.
        const marker = tx === 10 && ty === 7 && ((lx < 3 || lx > 12) && (ly < 3 || ly > 12));
        if (marker) put(out, CHUNK, x, y, trim);
      }
    }
  }
  return out;
}

function layerChunks(map: MapDef, upper: boolean): { chunks: Uint8Array[]; columns: number; rows: number } {
  const columns = Math.ceil((map.width * TILE) / CHUNK);
  const rows = Math.ceil((map.height * TILE) / CHUNK);
  return {
    columns,
    rows,
    chunks: Array.from({ length: columns * rows }, (_, index) =>
      chunkPixels(map, index % columns, Math.floor(index / columns), upper)),
  };
}

function gateChunks(map: MapDef): { chunks: Uint8Array[]; columns: number; rows: number } {
  const columns = Math.ceil((map.width * TILE) / CHUNK);
  const rows = Math.ceil((map.height * TILE) / CHUNK);
  const chunks = Array.from({ length: columns * rows }, () => new Uint8Array(CHUNK * CHUNK * 4));
  const gx = 12 * TILE;
  const gy = 7 * TILE;
  for (let py = 1; py < TILE; py++) {
    for (let px = 2; px < TILE - 2; px++) {
      const wx = gx + px;
      const wy = gy + py;
      const cx = Math.floor(wx / CHUNK);
      const cy = Math.floor(wy / CHUNK);
      put(chunks[cy * columns + cx]!, CHUNK, wx % CHUNK, wy % CHUNK,
        px % 4 < 2 ? [248, 196, 68, 255] : [104, 62, 34, 255]);
    }
  }
  return { chunks, columns, rows };
}

function sprite16(body: Rgba, accent: Rgba): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  rect(out, TILE, 4, 2, 8, 4, accent);
  rect(out, TILE, 3, 6, 10, 8, body);
  rect(out, TILE, 5, 14, 2, 2, accent);
  rect(out, TILE, 9, 14, 2, 2, accent);
  put(out, TILE, 6, 8, [8, 12, 20, 255]);
  put(out, TILE, 9, 8, [8, 12, 20, 255]);
  return out;
}

function sign16(): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  rect(out, TILE, 1, 1, 14, 10, [55, 31, 52, 255]);
  rect(out, TILE, 2, 2, 12, 8, [244, 199, 82, 255]);
  rect(out, TILE, 4, 4, 8, 1, [46, 64, 86, 255]);
  rect(out, TILE, 4, 7, 6, 1, [46, 64, 86, 255]);
  rect(out, TILE, 7, 11, 2, 5, [108, 68, 42, 255]);
  return out;
}

function walkerFrame(facing: number, pose: number, alternate = false): Uint8Array {
  const out = new Uint8Array(TILE * 32 * 4);
  const bodies: Rgba[] = alternate
    ? [[246, 114, 194, 255], [104, 216, 246, 255], [184, 116, 246, 255], [246, 176, 86, 255]]
    : [[86, 206, 246, 255], [92, 224, 148, 255], [244, 202, 80, 255], [240, 104, 118, 255]];
  const outline: Rgba = [10, 14, 26, 255];
  rect(out, TILE, 4, 4, 8, 8, outline);
  rect(out, TILE, 5, 5, 6, 6, bodies[facing]!);
  rect(out, TILE, 3, 12, 10, 14, outline);
  rect(out, TILE, 4, 13, 8, 12, bodies[facing]!);
  if (facing !== 2) {
    const eyeX = facing === 1 ? 5 : facing === 3 ? 10 : 7;
    put(out, TILE, eyeX, 8, [255, 255, 255, 255]);
  }
  const left = pose === 1 ? 2 : 4;
  const right = pose === 2 ? 12 : 10;
  rect(out, TILE, left, 26, 3, 5, outline);
  rect(out, TILE, right, 26, 3, 5, outline);
  return out;
}

function radial(size: number, inner: Rgba, outer: Rgba, radius: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c);
    if (Math.abs(d - radius) < 2.2) put(out, size, x, y, inner);
    else if (d < radius - 2 && ((x + y) & 3) === 0) put(out, size, x, y, outer);
  }
  return out;
}

const project = buildShowcaseProject();
writeFileSync(join(HERE, "data", "showcase.json"), JSON.stringify(project, null, 2) + "\n");

const entries: StreamEntry[] = [];
const streamed = new Map<string, { ground: StreamedLayer; upper: StreamedLayer }>();
for (const map of project.maps) {
  const ground = layerChunks(map, false);
  const upper = layerChunks(map, true);
  const g = encodeStreamedLayer(`showcase-${map.id}-ground`, ground.chunks, ground.columns, ground.rows, { chunkPx: CHUNK });
  const u = encodeStreamedLayer(`showcase-${map.id}-upper`, upper.chunks, upper.columns, upper.rows, { chunkPx: CHUNK });
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
writeFileSync(join(HERE, "pak.json"), JSON.stringify(pakManifest(entries), null, 2) + "\n");

const imageMeta: Record<string, { psm: number }> = {};
function writeImage(file: string, bytes: Uint8Array, width: number, height: number, psm = 3): string {
  const path = `assets/${file}`;
  mkdirSync(dirname(join(HERE, path)), { recursive: true });
  writeFileSync(join(HERE, path), encodePNG(bytes, width, height));
  imageMeta[path] = { psm };
  return path;
}

const staticSprites = {
  curator: writeImage("curator.png", sprite16([236, 94, 188, 255], [255, 221, 94, 255]), 16, 16),
  guide: writeImage("guide.png", sprite16([70, 182, 236, 255], [245, 245, 255, 255]), 16, 16),
  portal: writeImage("portal.png", radial(16, [255, 220, 82, 255], [96, 214, 250, 160], 5), 16, 16),
  sign: writeImage("sign.png", sign16(), 16, 16),
};

const player = { idle: [] as string[], walkL: [] as string[], walkR: [] as string[] };
const alternate = { idle: [] as string[], walkL: [] as string[], walkR: [] as string[] };
for (let facing = 0; facing < 4; facing++) {
  player.idle.push(writeImage(`player-idle-${facing}.png`, walkerFrame(facing, 0), 16, 32));
  player.walkL.push(writeImage(`player-left-${facing}.png`, walkerFrame(facing, 1), 16, 32));
  player.walkR.push(writeImage(`player-right-${facing}.png`, walkerFrame(facing, 2), 16, 32));
  alternate.idle.push(writeImage(`alternate-idle-${facing}.png`, walkerFrame(facing, 0, true), 16, 32));
  alternate.walkL.push(writeImage(`alternate-left-${facing}.png`, walkerFrame(facing, 1, true), 16, 32));
  alternate.walkR.push(writeImage(`alternate-right-${facing}.png`, walkerFrame(facing, 2, true), 16, 32));
}

const face = new Uint8Array(64 * 64 * 4);
rect(face, 64, 8, 6, 48, 52, [42, 20, 58, 255]);
rect(face, 64, 12, 10, 40, 44, [236, 94, 188, 255]);
rect(face, 64, 18, 18, 28, 24, [248, 205, 154, 255]);
rect(face, 64, 22, 26, 5, 5, [12, 18, 30, 255]);
rect(face, 64, 37, 26, 5, 5, [12, 18, 30, 255]);
writeImage("face-curator.png", face, 64, 64);

const battlePlayer = new Uint8Array(64 * 64 * 4);
const battleEnemy = new Uint8Array(64 * 64 * 4);
rect(battlePlayer, 64, 10, 8, 44, 48, [72, 190, 246, 255]);
rect(battlePlayer, 64, 18, 18, 28, 18, [248, 224, 96, 255]);
rect(battleEnemy, 64, 8, 14, 48, 40, [235, 88, 130, 255]);
rect(battleEnemy, 64, 16, 6, 12, 20, [175, 72, 235, 255]);
rect(battleEnemy, 64, 36, 6, 12, 20, [175, 72, 235, 255]);
writeImage("battle-player.png", battlePlayer, 64, 64);
writeImage("battle-enemy.png", battleEnemy, 64, 64);

const sparkFrames = [3, 5, 7, 5].map((radius, index) => ({
  rgba: radial(16, [90, 238, 255, 255], [255, 239, 92, 190], radius),
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
for (let i = 0; i < 4; i++) {
  mapAnimFrames.push(writeImage(
    `map-anim/pulse-${i}.png`,
    radial(32, [255, 245 - i * 22, 80 + i * 38, 255], [112, 228, 255, 150], 4 + i * 3),
    32,
    32,
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
    tiles: Array.from({ length: 12 }, (_, i) => ({
      x: 4 + (i % 6) * 2,
      y: i < 6 ? 3 : 11,
      above: i % 3 === 0,
      sprite: nativeAnim.atlasFor.get("water-spark")!,
    })),
  },
]);
const q = JSON.stringify;
const walkerSource = (frames: typeof player) => `{
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
  `const ALTERNATE = ${walkerSource(alternate)} as const;\n\n` +
  `export const GAME_ASSETS: GameAssets = {\n` +
  `  ground: {}, upper: {}, chunkColumns: {}, maxChunks: 0, maxActors: ${maxActors},\n` +
  `  world: ${q(world)},\n` +
  `  order: ${q(project.maps.map((map) => map.id))},\n` +
  `  npcSrc: { curator: ${q(staticSprites.curator)}, guide: ${q(staticSprites.guide)}, portal: ${q(staticSprites.portal)}, sign: ${q(staticSprites.sign)}, runner: PLAYER, alternate: ALTERNATE },\n` +
  `  player: PLAYER, playerHeight: 32,\n` +
  `  stream: ${streamSource},\n` +
  `  animated: ${animatedSource},\n` +
  `  anims: {\n` +
  `    "showcase-pulse": { frames: ${q(mapAnimFrames)}, w: 32, h: 32 },\n` +
  `    "showcase-ring": { frames: ${q([...mapAnimFrames].reverse())}, w: 32, h: 32 },\n` +
  `  },\n` +
  `  layers: {\n` +
  `    gate: { placement: "above", mode: "streamed", defaultVariant: "closed", defaultVisible: true, variants: { closed: { refs: { ${q(appearanceMap.id)}: ${q(gateLayer.layer.refs)} }, columns: { ${q(appearanceMap.id)}: ${gateLayer.layer.columns} }, chunkPx: ${CHUNK} } } },\n` +
  `    weather: { placement: "screen", defaultVisible: false, variants: { day: { color: "#ffe8a040", opacity: 0.32 }, dusk: { color: "#ef6a8058", opacity: 0.42 }, night: { color: "#163a9070", opacity: 0.52 } } },\n` +
  `    backdrop: { placement: "screen", defaultVisible: false, variants: { gallery: { color: "#251144", opacity: 1 }, stars: { color: "#07142e", opacity: 1 } } },\n` +
  `  },\n` +
  `};\n\n` +
  `export const SHOWCASE_ART = { face: "assets/face-curator.png", battlePlayer: "assets/battle-player.png", battleEnemy: "assets/battle-enemy.png" } as const;\n`,
);

const tour = recordShowcaseTour(project, {
  extensions: SHOWCASE_EXTENSIONS,
  battle: showcaseBattleRules,
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
  `${entries.reduce((sum, entry) => sum + entry.blob.length, 0)} bytes, 24 walker frames, ` +
  `${tour.masks.length}-frame attract tour`,
);
