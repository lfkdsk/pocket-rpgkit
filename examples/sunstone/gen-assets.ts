// examples/sunstone/gen-assets.ts — bake "The Sunstone of Bramble Hollow".
//
//   bun examples/sunstone/gen-assets.ts   (or `bun run gen-assets` for all)
//
// Inputs (assets/src, see ATTRIBUTION.md):
//   town-tiles.png, dungeon-tiles.png  Kenney Tiny Town / Tiny Dungeon, CC0,
//                                      12x11 grids of 16px cells
//   npc/*.png                          13 Kenney Tiny Dungeon cells, CC0
//   hero-*.png                         Sharm "Tiny 16" walker, CC-BY 3.0
// Outputs (committed; every byte is regenerated from the inputs):
//   assets/map-{village,forest,cave}-{ground,upper}.png  512px PSM_4444
//   assets/npc/*.png                   the NPC cells, verbatim
//   assets/player-dir0..3.png, player-pose{0..3}-{l,r}.png  walker frames
//   assets-game.ts                     the GameAssets manifest (literals)
//   images.json                        PSM_4444 marks for the map canvases
//   data/sunstone.json                 the project as an rpgkit-project/v1
//                                      document
//   assets/sunstone-theme.qoa          four-second generated chiptune loop

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import { CHUNK_PX, TILE } from "../../src/engine/tiles.ts";
import {
  MAP_CANVAS,
  bakeMapChunks,
  cutCell,
  gameManifestSource,
  groundChunkAsset,
  upperChunkAsset,
} from "../../tools/lib/chunks.ts";
import { buildGame } from "./game-data.ts";
import { encodeQoa } from "../../tools/lib/qoa.ts";

const HERE = new URL(".", import.meta.url).pathname; // examples/sunstone/
const ASSETS = join(HERE, "assets");
const SRC = join(ASSETS, "src");
mkdirSync(join(ASSETS, "npc"), { recursive: true });
mkdirSync(join(HERE, "data"), { recursive: true });

// Four bars of integer-only triangle synthesis. Short fades at every half-
// second note boundary make the four-second QOA repeat click-free; no source
// recording or platform decoder participates in these bytes.
const MUSIC_RATE = 22_050;
const MUSIC_FRAMES = MUSIC_RATE * 4;
const NOTE_FRAMES = MUSIC_RATE / 2;
const melodyHz = [330, 392, 494, 392, 294, 370, 440, 370] as const;
const bassHz = [110, 110, 123, 123, 98, 98, 110, 110] as const;
const music = new Int16Array(MUSIC_FRAMES);
let melodyPhase = 0;
let bassPhase = 0;
const triangle = (phase: number): number =>
  phase < 32_768 ? phase - 16_384 : 49_151 - phase;
for (let frame = 0; frame < MUSIC_FRAMES; frame++) {
  const note = Math.floor(frame / NOTE_FRAMES);
  const within = frame % NOTE_FRAMES;
  if (within === 0) {
    melodyPhase = 16_384;
    bassPhase = 16_384;
  }
  melodyPhase = (melodyPhase + Math.round(melodyHz[note]! * 65_536 / MUSIC_RATE)) & 0xffff;
  bassPhase = (bassPhase + Math.round(bassHz[note]! * 65_536 / MUSIC_RATE)) & 0xffff;
  const edge = Math.min(within, NOTE_FRAMES - 1 - within, 256);
  const mixed = triangle(melodyPhase) * 3 + triangle(bassPhase) * 2;
  music[frame] = Math.round(mixed * edge / (5 * 256));
}
const musicBytes = encodeQoa(music, 1, MUSIC_RATE);
writeFileSync(join(ASSETS, "sunstone-theme.qoa"), musicBytes);
writeFileSync(
  join(HERE, "pak.json"),
  JSON.stringify([{ key: "audio:qoa.music/sunstone-theme", file: "assets/sunstone-theme.qoa" }], null, 2) + "\n",
);

const png = async (path: string) => decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));

// ---------------------------------------------------------------------------
// Walker: each Sharm atlas is a 4x1 strip of 16px cells; cell 1 is the idle
// stance, cells 0 and 2 the two walk extremes. Three static images per
// facing — the pose is a pure function of the saved mover phase, so a
// restored state renders the same pixels at any host frame offset.
// ---------------------------------------------------------------------------
const HERO = ["down", "left", "up", "right"]; // facing 0..3
const idle: string[] = [];
const walkL: string[] = [];
const walkR: string[] = [];
for (const [facing, dir] of HERO.entries()) {
  const atlas = await png(join(SRC, `hero-${dir}.png`));
  if (atlas.height !== TILE || atlas.width !== 4 * TILE) {
    throw new Error(`hero-${dir}.png: expected a 4x1 strip of 16px cells`);
  }
  const pose = (file: string, cell: number, list: string[]): void => {
    writeFileSync(join(ASSETS, file), encodePNG(cutCell(atlas, cell * TILE, 0), TILE, TILE));
    list.push(`assets/${file}`);
  };
  pose(`player-dir${facing}.png`, 1, idle);
  pose(`player-pose${facing}-l.png`, 0, walkL);
  pose(`player-pose${facing}-r.png`, 2, walkR);
}

// ---------------------------------------------------------------------------
// Maps: every map fits one 512px chunk per layer (row-major chunk format,
// legacy single-chunk file names).
// ---------------------------------------------------------------------------
const { project, maps } = buildGame();
writeFileSync(join(HERE, "data", "sunstone.json"), JSON.stringify(project, null, 2) + "\n");

const townPng = await png(join(SRC, "town-tiles.png"));
const dunPng = await png(join(SRC, "dungeon-tiles.png"));
// Both Kenney sheets are 12x11 grids of 16px cells.
const SHEET_COLS = 12;
const cellCache = new Map<string, Uint8Array>();
const tileArt = (tileId: string | null): Uint8Array | null => {
  if (!tileId) return null;
  let art = cellCache.get(tileId);
  if (!art) {
    const dot = tileId.lastIndexOf(".");
    const sheetId = tileId.slice(0, dot);
    const cell = Number(tileId.slice(dot + 1));
    const sheet = sheetId === "dun" ? dunPng : townPng;
    art = cutCell(sheet, (cell % SHEET_COLS) * TILE, Math.floor(cell / SHEET_COLS) * TILE);
    cellCache.set(tileId, art);
  }
  return art;
};

// Opaque padding fills the rest of each 512 ground canvas: town maps pad
// with their grass cell; the cave pads with black behind its blocking void.
// GameView clips the canvas to the map rect, so the pad never shows.
const solidTile = (rgba: [number, number, number, number]): Uint8Array => {
  const tile = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) tile.set(rgba, i * 4);
  return tile;
};
const padCell = (sheetId: string): Uint8Array =>
  sheetId === "dun" ? solidTile([0, 0, 0, 255]) : tileArt("town.0")!;

const imageMeta: Record<string, { psm: number }> = {};
for (const m of maps) {
  const baked = bakeMapChunks(m, tileArt, padCell(m.sheets![0]!));
  const count = baked.columns * baked.rows;
  for (let i = 0; i < count; i++) {
    const ground = groundChunkAsset(m.id, i, count);
    const upper = upperChunkAsset(m.id, i, count);
    writeFileSync(join(HERE, ground), encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
    writeFileSync(join(HERE, upper), encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
    // PSM_4444: ground is opaque and the Kenney cells use only 0/255
    // alpha, so 4-bit alpha is exact.
    imageMeta[ground] = { psm: 2 };
    imageMeta[upper] = { psm: 2 };
  }
}
writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

// NPC sprites: the 16x16 Kenney Tiny Dungeon cells ship verbatim (the
// chests are a/b/c in the Kenney set).
const NPC_FILE: Record<string, string> = {
  wiz: "wiz.png",
  boy: "boy.png",
  merchant: "merchant.png",
  villager: "villager.png",
  slime: "slime.png",
  bat: "bat.png",
  "chest-closed": "chest-a.png",
  "chest-open": "chest-b.png",
  "chest-relic": "chest-c.png",
  thorn: "thorn.png",
  irongate: "irongate.png",
  runestone: "runestone.png",
  "runestone-lit": "runestone-lit.png",
};
for (const f of Object.values(NPC_FILE)) copyFileSync(join(SRC, "npc", f), join(ASSETS, "npc", f));

writeFileSync(
  join(HERE, "assets-game.ts"),
  gameManifestSource({
    generator: "examples/sunstone/gen-assets.ts",
    typesImport: "../../src/ui/game-assets.ts",
    maps,
    npcSrc: Object.entries(NPC_FILE).map(([key, f]) => [key, `assets/npc/${f}`] as const),
    player: { idle, walkL, walkR },
  }),
);

console.log(
  `sunstone gen-assets: ${maps.length} maps (${maps.map((m) => `${m.id} ${m.width}x${m.height}`).join(", ")}), ` +
    `ground/upper ${MAP_CANVAS}px PSM_4444, ${Object.keys(NPC_FILE).length} NPC sprites, 12 walker frames, ` +
    `${MUSIC_FRAMES} PCM frames -> ${musicBytes.length} B QOA`,
);
