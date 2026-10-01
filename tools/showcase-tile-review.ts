#!/usr/bin/env bun
// Zoomed review sheets for the Feature Gallery's tile art.  For the lobby and
// every hall this writes the 480x272 capture, a 3x nearest-neighbour
// enlargement, and a side-by-side sheet: each prop as the real renderer drew
// it (left) next to its source rectangle composited on the same ground
// (right), both at 3x.  It also reports how many pixels of each prop differ
// between the live render and the source, ignoring cells where an actor or
// sign sprite stands.
//
// Prereqs: bun tools/build-example.ts showcase && bun run build:wasm
//          && bun tools/showcase-screenshots.ts
// Usage:   bun tools/showcase-tile-review.ts [output directory]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { buildShowcaseProject } from "../examples/showcase/showcase-data.ts";
import {
  crop,
  over,
  placementRect,
  prepareShowcaseArt,
  showcaseMapPlan,
  showcaseObjectPixels,
  showcaseTerrainLayer,
  type Bitmap,
} from "../examples/showcase/showcase-art.ts";
import { SHOWCASE_SCREENSHOTS } from "./showcase-screenshots.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = join(ROOT, "docs", "screenshots");
const OUT = resolve(process.argv[2] ?? join(ROOT, "findings", "SHOW3-tiles"));
const SCALE = 3;
const GAP = 8;
const BACKGROUND = [28, 30, 38, 255] as const;

function scale(bitmap: Bitmap, factor: number): Bitmap {
  const width = bitmap.width * factor;
  const height = bitmap.height * factor;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y / factor) * bitmap.width + Math.floor(x / factor)) * 4;
      rgba.set(bitmap.rgba.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function paste(target: Bitmap, source: Bitmap, x: number, y: number): void {
  for (let row = 0; row < source.height; row++) {
    const from = row * source.width * 4;
    target.rgba.set(source.rgba.subarray(from, from + source.width * 4), ((y + row) * target.width + x) * 4);
  }
}

function save(path: string, bitmap: Bitmap): void {
  writeFileSync(path, encodePNG(bitmap.rgba, bitmap.width, bitmap.height));
}

await prepareShowcaseArt();
mkdirSync(OUT, { recursive: true });
const project = buildShowcaseProject();
const report: string[] = [];

for (const shot of SHOWCASE_SCREENSHOTS) {
  const map = project.maps.find((candidate) => candidate.id === (shot.chapter ?? "showcase-lobby"))!;
  const frame = decodePng(new Uint8Array(readFileSync(join(SHOTS, shot.file))));
  const stem = shot.file.replace(/\.png$/, "");
  save(join(OUT, `${stem}.png`), frame);
  save(join(OUT, `${stem}-3x.png`), scale(frame, SCALE));

  const plan = showcaseMapPlan(map);
  const terrain = showcaseTerrainLayer(plan);
  const occupied = new Set((map.events ?? []).flatMap((event) => [`${event.x},${event.y}`, `${event.x},${event.y - 1}`]));
  occupied.add("2,14").add("2,13"); // the player's entry cell and head row
  const seen = new Set<string>();
  const pairs: { live: Bitmap; source: Bitmap }[] = [];
  const lines: string[] = [];
  for (const placement of plan.objects) {
    const rect = placementRect(placement);
    const live = crop(frame, rect.x, rect.y, rect.width, rect.height);
    const source = crop(terrain, rect.x, rect.y, rect.width, rect.height);
    const pixels = showcaseObjectPixels(placement.object);
    for (let i = 0; i < source.rgba.length; i += 4) over(source.rgba, i, pixels.rgba, i);
    let differing = 0;
    let compared = 0;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const cell = `${Math.floor((rect.x + x) / 16)},${Math.floor((rect.y + y) / 16)}`;
        if (occupied.has(cell)) continue;
        compared++;
        const i = (y * rect.width + x) * 4;
        if (live.rgba[i] !== source.rgba[i] || live.rgba[i + 1] !== source.rgba[i + 1] || live.rgba[i + 2] !== source.rgba[i + 2]) {
          differing++;
        }
      }
    }
    lines.push(`${placement.object}@${placement.x},${placement.y}: ${differing}/${compared} px differ`);
    if (!seen.has(placement.object)) {
      seen.add(placement.object);
      pairs.push({ live: scale(live, SCALE), source: scale(source, SCALE) });
    }
  }
  const width = Math.max(...pairs.map((pair) => pair.live.width * 2 + GAP * 3));
  const height = pairs.reduce((sum, pair) => sum + pair.live.height + GAP, GAP);
  const sheet: Bitmap = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let i = 0; i < sheet.rgba.length; i += 4) sheet.rgba.set(BACKGROUND, i);
  let y = GAP;
  for (const pair of pairs) {
    paste(sheet, pair.live, GAP, y);
    paste(sheet, pair.source, GAP * 2 + pair.live.width, y);
    y += pair.live.height + GAP;
  }
  save(join(OUT, `${stem}-objects-3x.png`), sheet);
  report.push(`${stem}: ${[...seen].join(", ")}`, ...lines.map((line) => `  ${line}`));
}

writeFileSync(join(OUT, "pixel-report.txt"), report.join("\n") + "\n");
console.log(`showcase tile review: ${SHOWCASE_SCREENSHOTS.length} scenes -> ${OUT}`);
