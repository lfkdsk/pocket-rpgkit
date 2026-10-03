// editor/gen-assets.ts — build-time cooker for the tile-map editor.
//
//   bun editor/gen-assets.ts   (also run last by `bun run gen-assets`)
//
// Inputs (editor/sources.ts): the example documents and the examples' own
// source tile sheets under examples/*/assets/src (licenses in each
// example's ATTRIBUTION.md). Run it after the example cookers, which emit
// the documents.
//
// The pak pipeline binds whole baked IMG textures to Image nodes, and
// pak-baked images are what every host samples (the wasm sim and the wgpu
// desktop host alike; runtime texture uploads are not drawn by the Metal
// renderer), so the editor ships one 16x16 PNG per sheet cell. Outputs
// (committed; every byte is regenerated from the inputs):
//
//   assets/tile-<sheet>-<cell>.png   one PSM_8888 PNG per cell
//   images.json                      the PSM marks for those PNGs
//   engine/tile-keys.ts              tile id -> pak src literal
//   engine/sheets.ts                 sheet grid metadata + source files
//   assets/playtest/*.pkts           raw 16px TILESET entries for GameView
//   assets/playtest/player-*.png     preview player's static walk frames
//   assets/playtest/npc-*.png        bundled projects' static NPC art
//   assets/playtest/anim-*.png       bundled Show Animation frames
//   assets/playtest/parallax-*.png   bundled parallax images
//   pak.json                         raw TILESET entries for the pak builder
//   engine/playtest-assets.ts        preview texture manifest literals
//   engine/projects.ts               the bundled documents as TEXT (the
//                                    guest never reads repository files)
//                                    and a copy of src/data/schema.json
//                                    for the export gate
//
// Deterministic: outputs depend only on the committed inputs.

import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { loadTileCells } from "../tools/lib/bake.ts";
import { loadAnimationSheet } from "../tools/lib/anim-sheet.ts";
import { encodeStreamedLayer } from "../tools/lib/stream.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { Project } from "../src/engine/types.ts";
import { EDITOR_SOURCES } from "./sources.ts";

const HERE = new URL(".", import.meta.url).pathname; // editor/
const ROOT = resolve(HERE, "..");
const ASSETS = join(HERE, "assets");
const PLAYTEST_ASSETS = join(ASSETS, "playtest");
const ENGINE = join(HERE, "engine");
mkdirSync(ASSETS, { recursive: true });
rmSync(PLAYTEST_ASSETS, { recursive: true, force: true });
mkdirSync(PLAYTEST_ASSETS, { recursive: true });

const TILE = 16;
const schemaText = readFileSync(join(ROOT, "src", "data", "schema.json"), "utf8").replace(/\r\n/g, "\n");
const schema = JSON.parse(schemaText) as Record<string, unknown>;

// --- documents --------------------------------------------------------------

interface SheetPlan {
  id: string;
  cols: number;
  rows: number;
  source: string;
  bytes: Buffer;
}

const sheets = new Map<string, SheetPlan>();
const docs: Array<{ id: string; title: string; file: string; json: string }> = [];

for (const src of EDITOR_SOURCES) {
  // Normalize to LF so a CRLF checkout cannot change guest bytes.
  const text = readFileSync(join(ROOT, src.document), "utf8").replace(/\r\n/g, "\n");
  const project = JSON.parse(text) as Project;
  const errors = validateSchema(schema, project);
  if (errors.length > 0) {
    throw new Error(`editor gen-assets: ${src.document} fails the v1 schema: ${errors[0]!.path} ${errors[0]!.msg}`);
  }
  for (const sheet of project.sheets) {
    const file = src.sheets[sheet.id];
    if (!file) throw new Error(`editor gen-assets: ${src.id} sheet "${sheet.id}" has no source PNG in editor/sources.ts`);
    const bytes = readFileSync(join(ROOT, file));
    const seen = sheets.get(sheet.id);
    if (seen) {
      // Tile art is keyed by sheet id, so two examples may share an id only
      // when they ship the same sheet.
      if (!seen.bytes.equals(bytes) || seen.cols !== sheet.cols || seen.rows !== sheet.rows) {
        throw new Error(`editor gen-assets: sheet "${sheet.id}" differs between ${seen.source} and ${file}`);
      }
      continue;
    }
    sheets.set(sheet.id, { id: sheet.id, cols: sheet.cols, rows: sheet.rows, source: file, bytes });
  }
  docs.push({ id: src.id, title: project.title, file: src.document, json: text });
}

// --- per-cell tile art ------------------------------------------------------

const imageMeta: Record<string, { psm: number }> = {};
const tileKeyRows: string[] = [];
const written = new Set<string>();
const playtestRefs: Record<string, readonly (string | null)[]> = {};
const pakEntries: { key: string; file: string }[] = [];
const tileSrcByTile = new Map<string, string>();

for (const sheet of sheets.values()) {
  const cells = await loadTileCells(join(ROOT, sheet.source), sheet.cols, sheet.rows, TILE);
  const streamed = encodeStreamedLayer(
    `editor-sheet-${sheet.id}`,
    Array.from({ length: sheet.cols * sheet.rows }, (_, cell) => cells.cell(cell)),
    sheet.cols,
    sheet.rows,
    { chunkPx: TILE },
  );
  playtestRefs[sheet.id] = streamed.layer.refs;
  for (const [index, entry] of streamed.entries.entries()) {
    const file = `sheet-${sheet.id}${streamed.entries.length > 1 ? `-${index}` : ""}.pkts`;
    writeFileSync(join(PLAYTEST_ASSETS, file), entry.blob);
    pakEntries.push({ key: entry.key, file: `assets/playtest/${file}` });
  }
  for (let cell = 0; cell < sheet.cols * sheet.rows; cell++) {
    const name = `tile-${sheet.id}-${cell}.png`;
    writeFileSync(join(ASSETS, name), encodePNG(cells.cell(cell), TILE, TILE));
    written.add(name);
    imageMeta[`assets/${name}`] = { psm: 3 }; // PSM_8888: exact Kenney colors
    tileKeyRows.push(`  ${JSON.stringify(`${sheet.id}.${cell}`)}: ${JSON.stringify(`assets/${name}`)},`);
    tileSrcByTile.set(`${sheet.id}.${cell}`, `assets/${name}`);
  }
}
// A sheet dropped from the sources must not leave stale cells in the pak.
for (const name of readdirSync(ASSETS)) {
  if (/^tile-.+\.png$/.test(name) && !written.has(name)) rmSync(join(ASSETS, name));
}

writeFileSync(join(HERE, "pak.json"), JSON.stringify(pakEntries, null, 2) + "\n");

// The bundled examples share one player sheet. Copy the generated static
// frames into the editor app so its preview remains self-contained.
const playerFiles: string[] = [];
for (let facing = 0; facing < 4; facing++) {
  for (const name of [`player-dir${facing}.png`, `player-pose${facing}-l.png`, `player-pose${facing}-r.png`]) {
    const source = join(ROOT, dirname(dirname(EDITOR_SOURCES[0]!.document)), "assets", name);
    copyFileSync(source, join(PLAYTEST_ASSETS, name));
    imageMeta[`assets/playtest/${name}`] = { psm: 3 };
    playerFiles.push(name);
  }
}

// Static sprite ids are global in a project. A repeated id must carry the
// same bytes across bundled documents, just like shared tile-sheet ids.
const npcFiles = new Map<string, { bytes: Buffer; file: string }>();
for (const source of EDITOR_SOURCES) {
  const project = docs.find((candidate) => candidate.id === source.id);
  if (!project) continue;
  const parsed = JSON.parse(project.json) as Project;
  for (const [id, sprite] of Object.entries(parsed.sprites ?? {})) {
    if (sprite.kind !== "image") continue;
    const bytes = readFileSync(join(ROOT, dirname(dirname(source.document)), sprite.src));
    const seen = npcFiles.get(id);
    if (seen) {
      if (!seen.bytes.equals(bytes)) throw new Error(`editor gen-assets: sprite "${id}" differs between bundled projects`);
      continue;
    }
    const file = `npc-${id}.png`;
    writeFileSync(join(PLAYTEST_ASSETS, file), bytes);
    imageMeta[`assets/playtest/${file}`] = { psm: 3 };
    npcFiles.set(id, { bytes, file });
  }
}

/** Parallax image ids a document references: map defaults and
 *  changeParallax commands. */
function parallaxIds(project: Project): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.op === "changeParallax" && typeof record.image === "string" && record.image.length > 0) {
        ids.add(record.image);
      }
      for (const child of Object.values(record)) visit(child);
    }
  };
  for (const map of project.maps) {
    if (map.parallax?.image) ids.add(map.parallax.image);
    for (const event of map.events ?? []) for (const page of event.pages) visit(page.commands);
  }
  for (const common of project.commonEvents ?? []) visit(common.commands);
  return ids;
}

// Show Animation frames and parallax images for the editor playtest, cooked
// from the fixture sources named in editor/sources.ts. playtest-view.ts
// renders all three kinds (item icons, animations, parallaxes).
const animArt: Record<string, { frames: string[]; w: number; h: number }> = {};
const parallaxArt: Record<string, { image: string; w: number; h: number }> = {};
for (const doc of docs) {
  const source = EDITOR_SOURCES.find((candidate) => candidate.id === doc.id);
  const project = JSON.parse(doc.json) as Project;
  for (const anim of project.animations ?? []) {
    const sheetPath = source?.animationSheets?.[anim.sheet];
    if (!sheetPath) {
      throw new Error(`editor gen-assets: animation "${anim.id}" sheet "${anim.sheet}" has no source PNG in editor/sources.ts`);
    }
    const cooked = await loadAnimationSheet(join(ROOT, sheetPath), anim);
    const frames: string[] = [];
    for (let index = 0; index < cooked.frames.length; index++) {
      const file = `anim-${anim.id}-${index}.png`;
      writeFileSync(join(PLAYTEST_ASSETS, file), cooked.frames[index]!);
      imageMeta[`assets/playtest/${file}`] = { psm: 3 };
      frames.push(`assets/playtest/${file}`);
    }
    animArt[anim.id] = { frames, w: cooked.w, h: cooked.h };
  }
  for (const id of parallaxIds(project)) {
    const imagePath = source?.parallaxes?.[id];
    if (!imagePath) {
      throw new Error(`editor gen-assets: parallax "${id}" has no source PNG in editor/sources.ts`);
    }
    const png = decodePng(new Uint8Array(await Bun.file(join(ROOT, imagePath)).arrayBuffer()));
    const file = `parallax-${id}.png`;
    writeFileSync(join(PLAYTEST_ASSETS, file), encodePNG(png.rgba, png.width, png.height));
    imageMeta[`assets/playtest/${file}`] = { psm: 3 };
    parallaxArt[id] = { image: `assets/playtest/${file}`, w: png.width, h: png.height };
  }
}

// images.json must include the copied preview art too.
writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

// Static src literals so the build bakes every cell as a pak IMG entry: the
// bundler only collects complete string literals from the module graph, so
// a runtime "assets/tile-" + id expression would never bake.
writeFileSync(
  join(ENGINE, "tile-keys.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — static tile id -> pak IMG src\n` +
    `// keys (one baked 16x16 PNG per sheet cell). Do not edit.\n\n` +
    `export const TILE_SRC: Record<string, string> = {\n${tileKeyRows.join("\n")}\n};\n`,
);

const player = (kind: "idle" | "walkL" | "walkR", suffix: string): string => {
  const rows = Array.from({ length: 4 }, (_, facing) =>
    `assets/playtest/player-${kind === "idle" ? `dir${facing}` : `pose${facing}-${suffix}`}.png`
  );
  return `  ${kind}: ${JSON.stringify(rows)} as readonly [string, string, string, string],`;
};
const npcSource = Object.fromEntries([...npcFiles].map(([id, value]) => [id, `assets/playtest/${value.file}`]));
writeFileSync(
  join(ENGINE, "playtest-assets.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — editor-only GameView art.\n` +
    `// Do not import this module from a game entry. Do not edit by hand.\n\n` +
    `import type { PlayerFrames } from "../../src/ui/PlayerSprite.tsx";\n\n` +
    `export const PLAYTEST_SHEET_REFS: Record<string, readonly (string | null)[]> = ${JSON.stringify(playtestRefs, null, 2)};\n\n` +
    `export const PLAYTEST_PLAYER: PlayerFrames = {\n${player("idle", "") }\n${player("walkL", "l")}\n${player("walkR", "r")}\n};\n\n` +
    `export const PLAYTEST_NPC_SRC: Record<string, string> = ${JSON.stringify(npcSource, null, 2)};\n`,
);

// Item icons for the editor playtest: a bundled item whose sprite names a
// baked sheet cell gets that cell as its icon (the same PNG the tile palette
// draws). The playtest-art fixture also registers its Show Animation frames
// and its parallax image, so the in-editor playtest draws all three kinds.
const itemSrc: Record<string, string> = {};
for (const doc of docs) {
  const project = JSON.parse(doc.json) as Project;
  for (const item of project.items ?? []) {
    const src = item.sprite ? tileSrcByTile.get(item.sprite) : undefined;
    if (src) itemSrc[item.sprite] = src;
  }
}
const manifestEntries = [
  `  itemSrc: ${JSON.stringify(itemSrc, null, 2)},`,
  ...(Object.keys(animArt).length > 0 ? [`  animations: ${JSON.stringify(animArt, null, 2)},`] : []),
  ...(Object.keys(parallaxArt).length > 0 ? [`  parallaxes: ${JSON.stringify(parallaxArt, null, 2)},`] : []),
];
writeFileSync(
  join(ENGINE, "playtest-bundled-art.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — the baked art the editor\n` +
    `// playtest dresses its documents in: item icons, Show Animation frames\n` +
    `// and parallax images (cells and slices of the bundled example sheets).\n` +
    `// Editor-only, like playtest-assets.ts. Do not edit by hand.\n\n` +
    `import type { PlaytestArt } from "./playtest-view.ts";\n\n` +
    `export const PLAYTEST_BUNDLED_ART: PlaytestArt = {\n${manifestEntries.join("\n")}\n};\n`,
);

const sheetMeta = [...sheets.values()].map(({ id, cols, rows, source }) => ({ id, cols, rows, tile: TILE, source }));
writeFileSync(
  join(ENGINE, "sheets.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — tile sheet grids and the\n` +
    `// example source file each sheet's cells were cut from. Do not edit.\n\n` +
    `export interface SheetMeta {\n  id: string;\n  cols: number;\n  rows: number;\n  tile: number;\n` +
    `  /** Repository path of the source sheet PNG. */\n  source: string;\n}\n\n` +
    `export const SHEETS: SheetMeta[] = ${JSON.stringify(sheetMeta, null, 2)};\n`,
);

writeFileSync(
  join(ENGINE, "projects.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — the bundled project documents\n` +
    `// (the exact bytes of the example data files named in editor/sources.ts)\n` +
    `// and the v1 JSON Schema (src/data/schema.json) the export gate\n` +
    `// validates with. Do not edit by hand.\n\n` +
    `export interface BundledProject {\n  id: string;\n  title: string;\n` +
    `  /** Repository path of the document this text was read from. */\n  file: string;\n` +
    `  /** Canonical document text (JSON, 2-space indent, trailing LF). */\n  json: string;\n}\n\n` +
    `export const BUNDLED_PROJECTS: BundledProject[] = ${JSON.stringify(docs, null, 2)};\n\n` +
    `export const PROJECT_SCHEMA: Record<string, unknown> = ${schemaText.trimEnd()};\n`,
);

console.log(
  `editor gen-assets: ${written.size} tile image(s) from ${sheets.size} sheet(s), ` +
    `${pakEntries.length} playtest TILESET entry(s), ${playerFiles.length} player frame(s), ` +
    `${npcFiles.size} NPC image(s), ${docs.length} bundled document(s) ` +
    docs.map((d) => `${d.id}=${d.json.length}B`).join(", "),
);
