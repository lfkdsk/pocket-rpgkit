// tools/grow-shots.ts — capture review frames of the causal grow world
// through the BUILT "grow" bundle on the deterministic sim host.
//
//   bun run build:wasm && bun tools/build-example.ts grow
//   bun tools/grow-shots.ts [OUT_DIR]
//
// For the default seed: one finished-village frame per biome (UP/DOWN picks
// the village's founding, a strip touch seeks to the end with the camera
// held there), the finished world with its timeline markers, a picked place
// with its history panel, the world mid-history, and a 960x544 overview.
// Every frame is a pure function of the bundle and the inputs;
// tests/grow-causal-sim.test.ts renders the same frames and compares them
// with the committed goldens.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch, __packTouchWide } from "../vendor/pocketjs/framework/src/touch.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { DEFAULT_PARAMS, growToDone } from "../examples/grow/grow.ts";
import { MAJOR_EVENTS } from "../examples/grow/grow-causal.ts";

interface SimWorld {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
}
export interface GrowShotPub {
  tick: number; total: number; caption?: string; focusX?: number; cameraX: number;
  here?: { x: number; y: number; lines: string[] }; markers?: number;
}
export interface GrowShot { name: string; width: number; height: number; rgba: Uint8Array; pub: GrowShotPub }

const root = resolve(import.meta.dir, "..");
const pub = (): GrowShotPub => structuredClone((globalThis as { __rpgGrowState?: GrowShotPub }).__rpgGrowState!);
export const GROW_SHOT_BIOMES = ["grass", "mud", "sand", "snow"] as const;

async function boot(width: number, height: number): Promise<SimWorld> {
  return (await bootWorld(join(root, "dist", "grow"), 60, undefined, undefined, { width, height })) as unknown as SimWorld;
}
function run(w: SimWorld, frames: number, buttons = 0, touches?: readonly number[]): void {
  for (let f = 0; f < frames; f++) { w.frame(buttons, 0x8080, touches); w.tick(); }
}
function press(w: SimWorld, button: number): void { run(w, 1, button); run(w, 1); }
function seekStrip(w: SimWorld, width: number, height: number, x: number): void {
  const pack = width > 511 || height > 511 ? __packTouchWide : __packTouch;
  run(w, 3, 0, [pack(0, x, height - 8)]);
  run(w, 2);
}
function seekEnd(w: SimWorld, width: number, height: number): void { seekStrip(w, width, height, width - 1); }
/** Record the whole history (one causal tick a frame), then park the playhead at tick 0. */
function settle(w: SimWorld, width: number, height: number): void {
  run(w, 260);
  seekStrip(w, width, height, 0);
}

/** Render every review frame of the default world. */
export async function captureGrowShots(): Promise<GrowShot[]> {
  const shots: GrowShot[] = [];
  const shot = (name: string, w: SimWorld, width: number, height: number) =>
    shots.push({ name, width, height, rgba: w.render().slice(), pub: pub() });
  const done = growToDone(DEFAULT_PARAMS);
  const major = done.sim!.events.filter((e) => MAJOR_EVENTS.has(e.kind));
  const pickFounding = (w: SimWorld, settlement: number) => {
    const index = major.findIndex((e) => e.kind === "founded" && e.settlement === settlement);
    for (let n = 0; n <= index; n++) press(w, BTN.DOWN);
  };

  // One finished village per biome, camera held on its founding place.
  for (const town of done.sim!.settlements) {
    const w = await boot(480, 272);
    settle(w, 480, 272);
    pickFounding(w, town.id);
    seekEnd(w, 480, 272);
    shot(`grow-causal-${GROW_SHOT_BIOMES[town.biome]}`, w, 480, 272);
  }

  // The finished world under the director camera, markers on the strip;
  // then the snow village's plaza picked by touch opens its history panel.
  {
    const w = await boot(480, 272);
    settle(w, 480, 272);
    seekEnd(w, 480, 272);
    shot("grow-causal-timeline", w, 480, 272);
    const snow = done.sim!.settlements[3]!;
    seekStrip(w, 480, 272, 0);
    pickFounding(w, snow.id);
    seekEnd(w, 480, 272);
    const focus = pub().focusX ?? snow.cx;
    const camX = Math.max(0, Math.min(DEFAULT_PARAMS.width * 16 - 480, focus * 16 + 8 - 240));
    // The 33-row world is centered in the 256 px field above the strip.
    const camY = Math.floor((DEFAULT_PARAMS.height * 16 - 256) / 2);
    run(w, 2, 0, [__packTouch(1, snow.cx * 16 + 8 - camX, snow.cy * 16 + 8 - camY)]);
    run(w, 2);
    shot("grow-causal-here", w, 480, 272);
  }

  // The same world mid-history (year 2, winter) under the director camera.
  {
    const w = await boot(480, 272);
    settle(w, 480, 272);
    seekStrip(w, 480, 272, Math.round((90 / 240) * 480));
    shot("grow-causal-mid", w, 480, 272);
  }

  // A wide desktop overview at the end.
  {
    const w = await boot(960, 544);
    settle(w, 960, 544);
    seekEnd(w, 960, 544);
    shot("grow-causal-960", w, 960, 544);
  }
  return shots;
}

if (import.meta.main) {
  const outDir = resolve(process.argv[2] ?? "grow-shots");
  mkdirSync(outDir, { recursive: true });
  for (const s of await captureGrowShots()) {
    const file = join(outDir, `${s.name}.png`);
    writeFileSync(file, encodePNG(s.rgba, s.width, s.height));
    console.log(`${file}  tick ${s.pub.tick}/${s.pub.total}  ${s.pub.caption ?? ""}${s.pub.here ? `  here: ${s.pub.here.lines.join(" / ")}` : ""}`);
  }
}
