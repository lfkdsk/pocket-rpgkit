#!/usr/bin/env bun
// Capture the Feature Gallery's lobby and every room on the real PocketJS
// wasm host, then assemble a deterministic half-scale contact sheet. Feature
// close-ups (SHOWCASE_FEATURE_SHOTS) walk to one authored event and open its
// box; they are written beside the room shots but stay out of the sheet.
//
// Prereqs: bun tools/build-example.ts showcase && bun run build:wasm
// One shot: bun tools/showcase-screenshots.ts --shot <id> [--out <dir>]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import type { SessionState } from "../src/engine/session.ts";
import { buildShowcaseProject, SHOWCASE_HALLS } from "../examples/showcase/showcase-data.ts";
import { appBundle } from "../tests/helpers/boot.ts";

const WIDTH = 480;
const HEIGHT = 272;
const COLUMNS = 4;
const SCALE = 2;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FLAG = process.argv.indexOf("--out");
const OUT = OUT_FLAG >= 0 ? resolve(process.argv[OUT_FLAG + 1]!) : join(ROOT, "docs", "screenshots");

export interface ShowcaseScreenshot {
  id: string;
  chapter?: string;
  file: string;
}

export const SHOWCASE_SCREENSHOTS: readonly ShowcaseScreenshot[] = [
  { id: "lobby", file: "showcase-lobby.png" },
  ...SHOWCASE_HALLS.map((hall) => ({
    id: hall.id,
    chapter: hall.id,
    file: `showcase-${String(hall.number).padStart(2, "0")}-${hall.id.replace(/^(showcase|hall)-/, "")}.png`,
  })),
];

/** A close-up of one authored event: boot `chapter`, walk to the cell below
 * `event`, face it, press A, and capture once its `modal` box is open. */
export interface ShowcaseFeatureShot {
  id: string;
  chapter: string;
  event: string;
  modal: "text" | "choices";
  file: string;
}

export const SHOWCASE_FEATURE_SHOTS: readonly ShowcaseFeatureShot[] = [
  {
    id: "choice-icons",
    chapter: "hall-theme",
    event: "partner-picker",
    modal: "choices",
    file: "showcase-09-choice-icons.png",
  },
];

export function makeShowcaseContactSheet(frames: readonly Uint8Array[]): {
  rgba: Uint8Array;
  width: number;
  height: number;
} {
  if (frames.length !== SHOWCASE_SCREENSHOTS.length) {
    throw new Error(`showcase screenshots: expected ${SHOWCASE_SCREENSHOTS.length} frames, got ${frames.length}`);
  }
  const thumbW = WIDTH / SCALE;
  const thumbH = HEIGHT / SCALE;
  const rows = Math.ceil(frames.length / COLUMNS);
  const width = thumbW * COLUMNS;
  const height = thumbH * rows;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba.set([9, 26, 45, 255], i);
  }
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    if (frame.length !== WIDTH * HEIGHT * 4) {
      throw new Error(`showcase screenshots: frame ${index} has ${frame.length} bytes`);
    }
    const ox = index % COLUMNS * thumbW;
    const oy = Math.floor(index / COLUMNS) * thumbH;
    for (let y = 0; y < thumbH; y++) {
      for (let x = 0; x < thumbW; x++) {
        const from = ((y * SCALE) * WIDTH + x * SCALE) * 4;
        const to = ((oy + y) * width + ox + x) * 4;
        rgba.set(frame.subarray(from, from + 4), to);
      }
    }
  }
  return { rgba, width, height };
}

const sessionState = (): SessionState => {
  const state = (globalThis as { __rpgSessionState?: SessionState }).__rpgSessionState;
  if (!state) throw new Error("showcase screenshots: the bundle published no session state");
  return state;
};

/** Drive the booted world on foot to the feature's event and open its box. */
function openFeature(world: Awaited<ReturnType<typeof bootWorld>>, shot: ShowcaseFeatureShot): void {
  const map = buildShowcaseProject().maps.find((candidate) => candidate.id === shot.chapter);
  const event = map?.events?.find((candidate) => candidate.id === shot.event);
  if (!map || !event) throw new Error(`showcase screenshot ${shot.id}: no event ${shot.event} on ${shot.chapter}`);
  const step = (buttons = 0): SessionState => {
    world.frame(buttons, 0x8080);
    world.tick();
    const state = sessionState();
    if (state.interp.error) throw new Error(`showcase screenshot ${shot.id}: ${state.interp.error.message}`);
    return state;
  };
  const moveAxis = (axis: "x" | "y", target: number): void => {
    for (let frame = 0; frame < 1_200; frame++) {
      const state = sessionState();
      const value = axis === "x" ? state.move.tx : state.move.ty;
      if (value === target && !state.move.moving) return;
      step(axis === "x" ? target > value ? BTN.RIGHT : BTN.LEFT : target > value ? BTN.DOWN : BTN.UP);
    }
    throw new Error(`showcase screenshot ${shot.id}: never reached ${axis}=${target}`);
  };
  // Up the entry column first, then across to stand below the event.
  moveAxis("y", event.y + 1);
  moveAxis("x", event.x);
  step(BTN.UP);
  for (let frame = 0; frame < 60 && sessionState().move.moving; frame++) step();
  step(BTN.CIRCLE);
  for (let frame = 0; frame < 120; frame++) {
    if (step().interp.modal?.kind === shot.modal) return;
  }
  throw new Error(`showcase screenshot ${shot.id}: no ${shot.modal} box opened`);
}

async function capture(shot: ShowcaseScreenshot | ShowcaseFeatureShot): Promise<void> {
  const world = await bootWorld(
    appBundle("showcase"),
    60,
    shot.chapter ? { __rpgkitBoot: { chapter: shot.chapter } } : undefined,
    undefined,
    { width: WIDTH, height: HEIGHT },
  );
  for (let frame = 0; frame < 16; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
  if ("event" in shot) {
    openFeature(world, shot);
    // Let the box settle before the capture.
    for (let frame = 0; frame < 16; frame++) {
      world.frame(0, 0x8080);
      world.tick();
    }
  }
  const target = join(OUT, shot.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodePNG(world.render(), WIDTH, HEIGHT));
  console.log(`showcase screenshot: ${shot.id} -> ${shot.file}`);
}

async function run(): Promise<void> {
  const shotFlag = process.argv.indexOf("--shot");
  if (shotFlag >= 0) {
    const id = process.argv[shotFlag + 1];
    const shot = [...SHOWCASE_SCREENSHOTS, ...SHOWCASE_FEATURE_SHOTS].find((candidate) => candidate.id === id);
    if (!shot) throw new Error(`showcase screenshots: unknown shot ${JSON.stringify(id)}`);
    await capture(shot);
    return;
  }

  for (const shot of [...SHOWCASE_SCREENSHOTS, ...SHOWCASE_FEATURE_SHOTS]) {
    const child = Bun.spawnSync({
      cmd: ["bun", fileURLToPath(import.meta.url), "--shot", shot.id, ...(OUT_FLAG >= 0 ? ["--out", OUT] : [])],
      cwd: ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, SHOWCASE_SCREENSHOT: shot.id },
    });
    if (child.exitCode !== 0) throw new Error(`showcase screenshot ${shot.id} exited ${child.exitCode}`);
  }

  const frames = SHOWCASE_SCREENSHOTS.map((shot) => {
    const image = decodePng(new Uint8Array(readFileSync(join(OUT, shot.file))));
    if (image.width !== WIDTH || image.height !== HEIGHT) {
      throw new Error(`showcase screenshot ${shot.file}: expected ${WIDTH}x${HEIGHT}, got ${image.width}x${image.height}`);
    }
    return image.rgba;
  });
  const overview = makeShowcaseContactSheet(frames);
  writeFileSync(join(OUT, "showcase-overview.png"), encodePNG(overview.rgba, overview.width, overview.height));
  console.log(`showcase screenshots: ${frames.length} scenes; overview ${overview.width}x${overview.height}`);
}

if (import.meta.main) await run();
