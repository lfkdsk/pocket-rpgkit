// Built-bundle and framebuffer proof for KM1 runtime movement controls.

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { bootWorld, fnv1a, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import type { SessionState } from "../src/engine/session.ts";
import type { Km1MoveControlFixtureApi } from "./fixtures/km1-move-control/km1-move-control.tsx";
import { appBundle, appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("km1-move-control");
if (!preflight.ok) console.warn(`KM1 sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
const RATES = [60, 30, 20, 4] as const;
const W = 480;
const H = 272;

declare global {
  // eslint-disable-next-line no-var
  var __km1MoveControlFixture: Km1MoveControlFixtureApi | undefined;
}

setDefaultTimeout(15_000);
beforeEach(() => {
  delete globalThis.__km1MoveControlFixture;
});

function api(): Km1MoveControlFixtureApi {
  if (!globalThis.__km1MoveControlFixture) throw new Error("KM1 move-control fixture did not mount");
  return globalThis.__km1MoveControlFixture;
}

function frame(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function pump(world: SimWorld, frames: number, buttons = 0): void {
  for (let i = 0; i < frames; i++) frame(world, buttons);
}

function rgbAt(framebuffer: Uint8Array, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * 4;
  return [framebuffer[i]!, framebuffer[i + 1]!, framebuffer[i + 2]!];
}

function projection(state: SessionState): unknown {
  const runner = state.chars.chars.runner!;
  const wanderer = state.chars.chars.wanderer!;
  return {
    player: { tx: state.move.tx, ty: state.move.ty, px: state.move.px, py: state.move.py, facing: state.move.facing },
    runner: { tx: runner.tx, ty: runner.ty, px: runner.px, py: runner.py, facing: runner.facing },
    wanderer: { tx: wanderer.tx, ty: wanderer.ty, px: wanderer.px, py: wanderer.py, facing: wanderer.facing },
    rng: state.sw.rng,
    controls: state.interp.moveControls,
  };
}

async function boot(hz: number): Promise<SimWorld> {
  return bootWorld(appBundle("km1-move-control"), hz);
}

async function golden(framebuffer: Uint8Array): Promise<void> {
  const url = new URL("./goldens/km1-move-control.png", import.meta.url);
  if (process.env.KM1_UPDATE_GOLDEN) await Bun.write(url, encodePNG(framebuffer, W, H));
  const png = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(framebuffer).toEqual(decodePng(png).rgba);
}

simDescribe("KM1 built movement-control fixture", () => {
  test("through, route controls, speed, and fixed facing are visible in one golden frame", async () => {
    const world = await boot(60);
    // Tick 1 installs the autorun controls before player input. Ticks 2..5
    // cross the red cell; the route's three control steps plus four movement
    // ticks finish on tick 8.
    frame(world);
    pump(world, 4, BTN.RIGHT);
    pump(world, 3);
    const state = api().state();
    expect(state.move).toMatchObject({ tx: 3, ty: 2, px: 48, py: 32, facing: 0, phase: 0 });
    expect(state.chars.chars.runner).toMatchObject({ tx: 3, ty: 6, px: 48, py: 96, facing: 0, phase: 0 });
    expect(state.interp.moveControls?.player).toMatchObject({ speed: 6, through: true, directionFix: true });
    expect(state.interp.moveControls?.events.runner).toMatchObject({ speed: 6, through: true, facingMode: "locked" });

    const framebuffer = world.render().slice();
    // Red obstacle rim, cyan/green actor bodies, and yellow down-facing marks
    // prove the blockers were crossed while both actors kept their facing.
    expect(rgbAt(framebuffer, 3 * 16 + 1, 2 * 16 + 8)).toEqual([239, 68, 68]);
    expect(rgbAt(framebuffer, 3 * 16 + 8, 2 * 16 + 8)).toEqual([56, 189, 248]);
    expect(rgbAt(framebuffer, 3 * 16 + 7, 2 * 16 + 14)).toEqual([253, 224, 71]);
    expect(rgbAt(framebuffer, 3 * 16 + 8, 6 * 16 + 8)).toEqual([34, 197, 94]);
    expect(rgbAt(framebuffer, 3 * 16 + 7, 6 * 16 + 14)).toEqual([253, 224, 71]);
    await golden(framebuffer);
  });

  test("60/30/20/4 Hz produce the same reducer state and pixels after equal reference time", async () => {
    const runs: Array<{ state: unknown; hash: string }> = [];
    for (const hz of RATES) {
      const world = await boot(hz);
      // Include the autorun tick in the same one-second input window. A
      // separate bootstrap host frame would be 1/60 s at 60 Hz but 1/4 s at
      // 4 Hz even though both hosts fold the same 60 Hz reference reducer.
      pump(world, hz, BTN.RIGHT);
      runs.push({ state: projection(api().state()), hash: fnv1a(world.render()) });
    }
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
  });
});
