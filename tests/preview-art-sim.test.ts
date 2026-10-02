// tests/preview-art-sim.test.ts — the rpgkit-preview/v1 host page
// (tools/preview/preview.tsx) on the deterministic wasm sim, driven through
// its __rpgkitPreview hook (the same validated paths as postMessage):
//
//   1. ART       a load with `art` draws the supplied tile sheet, image
//                sprite and walker frames instead of the stand-ins;
//   2. DETERMINISM the same document and inputs give identical `state`
//                readings with and without art (art changes pixels, never
//                the session);
//   3. FREES     the art's textures are freed by the next load and by stop,
//                and staged images do not survive a load without art.
//
// The page bundle is built into dist/preview-art/ before the tests (about a
// second). Needs the wasm core (`bun run build:wasm`); without it the cases
// register as skips.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { encodePreviewBase64, type PreviewArtResult, type PreviewLoadResult, type PreviewStateResult } from "../tools/preview/protocol.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const WASM = join(ROOT, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");
const OUT = join(ROOT, "dist", "preview-art");
const BUNDLE = join(OUT, "preview");

const preflight = existsSync(WASM) ? { ok: true as const } : { ok: false as const, reason: `missing ${WASM} — run \`bun run build:wasm\`` };
if (!preflight.ok) console.warn(`preview art sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface PreviewHook {
  load(document: unknown, chapters?: unknown, art?: boolean): PreviewLoadResult;
  art(fields: Record<string, unknown>): PreviewArtResult;
  start(target: unknown): unknown;
  state(): PreviewStateResult;
  input(buttons: number, frames?: number): void;
  stop(): void;
}

const hook = (): PreviewHook => (globalThis as { __rpgkitPreview?: PreviewHook }).__rpgkitPreview!;

/** Sunstone with the village boy drawn by a walker sheet the stand-ins lack. */
function documentText(): string {
  const doc = JSON.parse(readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project;
  doc.sprites = { ...doc.sprites, boy: { kind: "walker", sheet: "boy-sheet" } };
  return JSON.stringify(doc);
}

type Rgb = readonly [number, number, number];
const SHEET: Rgb = [250, 10, 20];
const WIZ: Rgb = [240, 0, 240];
const WALKER: Rgb = [10, 250, 20];

function solid(width: number, height: number, [r, g, b]: Rgb): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([r, g, b, 255], i);
  return rgba;
}

/** Stage one image through the hook in `slice`-byte slices. */
function stage(kind: "sheet" | "sprite", id: string, width: number, height: number, rgba: Uint8Array, slice = 16_384): void {
  for (let offset = 0; offset < rgba.length; offset += slice) {
    hook().art({ kind, id, width, height, offset, rgba: encodePreviewBase64(rgba, offset, Math.min(rgba.length, offset + slice)) });
  }
}

function stageAll(): void {
  // The town sheet is 22x12 cells; every cell is one colour.
  stage("sheet", "town", 352, 192, solid(352, 192, SHEET));
  stage("sprite", "wiz", 16, 16, solid(16, 16, WIZ));
  stage("sprite", "boy", 48, 128, solid(48, 128, WALKER));
}

function count(frame: Uint8Array, [r, g, b]: Rgb): number {
  let n = 0;
  for (let i = 0; i < frame.length; i += 4) if (frame[i] === r && frame[i + 1] === g && frame[i + 2] === b) n++;
  return n;
}

/** Wander the village, then walk up to the elder and talk. */
const SCRIPT: readonly [number, number][] = [
  [BTN.DOWN, 18],
  [BTN.LEFT, 40],
  [BTN.UP, 50],
  [BTN.RIGHT, 40],
  [BTN.UP, 4],
  [BTN.CIRCLE, 1],
];

function step(world: SimWorld, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    world.frame(0);
    world.tick();
  }
}

/** Load (with or without the staged art), start at the project start and
 *  play SCRIPT, reading the state after every input. */
function play(world: SimWorld, art: boolean): { loaded: PreviewLoadResult; states: PreviewStateResult[]; frame: Uint8Array } {
  const loaded = hook().load(documentText(), undefined, art);
  step(world, 3);
  hook().start({ kind: "tile", map: "village", x: 9, y: 9, dir: "up" });
  step(world, 2);
  const frame = world.render().slice();
  const states: PreviewStateResult[] = [hook().state()];
  for (const [buttons, frames] of SCRIPT) {
    hook().input(buttons, frames);
    step(world, frames + 12);
    states.push(hook().state());
  }
  return { loaded, states, frame };
}

simDescribe("preview page with project art", () => {
  let live: Set<number>;
  let world: SimWorld;

  beforeAll(async () => {
    const built = Bun.spawnSync({
      cmd: [process.execPath, join(ROOT, "vendor", "pocketjs", "tools", "build.ts"), join(ROOT, "tools", "preview", "preview.tsx"), `--project-root=${ROOT}`, `--outdir=${OUT}`],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (built.exitCode !== 0) throw new Error(`building the preview page failed:\n${built.stderr.toString()}`);
    live = new Set<number>();
    world = await bootWorld(BUNDLE, 60, undefined, (ops) => {
      // Track the RGBA8 textures (the art's; the page's own art is CLUT8).
      const upload = ops.uploadTexture as (buf: Uint8Array, w: number, h: number, psm: number) => number;
      const free = ops.freeTexture as ((handle: number) => void) | undefined;
      ops.uploadTexture = (buf: Uint8Array, w: number, h: number, psm: number) => {
        const handle = upload(buf, w, h, psm);
        if (psm === 3 && handle >= 0) live.add(handle);
        return handle;
      };
      ops.freeTexture = (handle: number) => {
        live.delete(handle);
        free?.(handle);
      };
    });
    step(world, 2);
  }, 60_000);

  test("art changes the pixels, never the state; its textures are freed by the next load and by stop", () => {
    const plain = play(world, false);
    expect(plain.loaded.art).toBeUndefined();
    expect(count(plain.frame, SHEET)).toBe(0);
    expect(live.size).toBe(0);

    stageAll();
    const art = play(world, true);
    expect(art.loaded.art).toEqual({ used: 3, skipped: [] });
    // The village is 20x13 cells of the supplied sheet, under the actors.
    expect(count(art.frame, SHEET)).toBeGreaterThan(20 * 13 * 256 * 0.9);
    expect(count(art.frame, WIZ)).toBe(256);
    // The boy faces down: one 16x32 idle frame.
    expect(count(art.frame, WALKER)).toBe(512);
    // Twelve walker frames and the wiz image stay registered while it runs;
    // streamed tiles come and go with the camera window.
    expect(live.size).toBeGreaterThanOrEqual(13);

    // The same document and inputs, the same session, frame by frame.
    expect(art.states).toEqual(plain.states);
    expect(art.states.some((state) => state.message !== null)).toBe(true);
    expect(new Set(art.states.map((state) => `${state.x},${state.y}`)).size).toBeGreaterThan(3);

    // A load without art frees the art and draws the stand-ins again.
    const again = play(world, false);
    expect(again.states).toEqual(plain.states);
    expect(count(again.frame, SHEET)).toBe(0);
    expect(again.frame).toEqual(plain.frame);
    expect(live.size).toBe(0);

    // Stop frees the art too.
    stageAll();
    play(world, true);
    expect(live.size).toBeGreaterThan(0);
    hook().stop();
    step(world, 2);
    expect(live.size).toBe(0);
  });

  test("staged art is dropped by a load without art and by stop; incomplete images are ignored", () => {
    stageAll();
    expect(play(world, false).loaded.art).toBeUndefined();
    // Nothing staged survived: a load with art now uses nothing.
    expect(play(world, true).loaded.art).toEqual({ used: 0, skipped: [] });

    stageAll();
    hook().stop();
    const afterStop = play(world, true);
    expect(afterStop.loaded.art).toEqual({ used: 0, skipped: [] });
    expect(count(afterStop.frame, SHEET)).toBe(0);

    // Half a sheet plus one complete sprite: only the sprite is used.
    const sheet = solid(352, 192, SHEET);
    hook().art({ kind: "sheet", id: "town", width: 352, height: 192, offset: 0, rgba: encodePreviewBase64(sheet, 0, sheet.length / 2) });
    stage("sprite", "wiz", 16, 16, solid(16, 16, WIZ));
    const partial = play(world, true);
    expect(partial.loaded.art).toEqual({ used: 1, skipped: [] });
    expect(count(partial.frame, SHEET)).toBe(0);
    expect(count(partial.frame, WIZ)).toBe(256);
    hook().stop();
    step(world, 2);
    expect(live.size).toBe(0);
  });
});
