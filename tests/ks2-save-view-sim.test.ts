// Saving and loading through GameView's overlay slot, end to end on the
// deterministic wasm sim host (tests/fixtures/ks2-save). The fixture runs
// Sunstone as plain live play: START saves a compressed code, SELECT loads
// it with loadIntoView. A load must continue exactly like the run that
// never left the save point, and must not turn on attract's L rewind.
// Booted beside an attract tape, a save taken while the demo plays records
// the tape's mask, so the first frames after a load see the same button
// edges the reducer would have seen without the save.
//
// Sim cases need `bun run build:wasm` and `bun run build:example ks2-save`;
// without them they register as skips.

import { describe, expect, test } from "bun:test";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { canonicalJson, decodeSaveCode } from "../src/engine/save.ts";
import { loadSession } from "../src/engine/save-restore.ts";
import { createSession, stepSession, type SessionState } from "../src/engine/session.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";
import type { Ks2SaveFixtureApi } from "./fixtures/ks2-save/ks2-save.tsx";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

installGameSimIsolation();

const preflight = appPreflight("ks2-save");
if (!preflight.ok) console.warn(`ks2-save sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  L: 0x0100,
  CIRCLE: 0x2000,
} as const;

function fixture(): Ks2SaveFixtureApi {
  return globalThis.__ks2SaveFixture!;
}

/** Reducer state that decides the next frame (SessionState.frame counts
 *  host frames for the audio driver and is derived again on load). */
function key(state: SessionState): string {
  return canonicalJson({
    map: state.mapId,
    move: state.move,
    chars: state.chars,
    interp: state.interp,
    fade: state.fade,
    playerRoute: state.playerRoute,
    ext: state.ext,
  });
}

/** Host frames for `seconds` of 60 Hz source time at this rate. */
const frames = (world: BoundGameWorld, sourceFrames: number): number => Math.round(sourceFrames * world.hz / 60);

function hold(world: BoundGameWorld, buttons: number, sourceFrames: number, out?: string[]): void {
  for (let i = 0; i < frames(world, sourceFrames); i++) {
    world.frame(buttons, 0x8080);
    world.tick();
    out?.push(key(world.probes().state));
  }
}

/** One frame with `button` pressed, then one released frame. */
function tap(world: BoundGameWorld, button: number): void {
  world.frame(button, 0x8080);
  world.tick();
  world.frame(0, 0x8080);
  world.tick();
}

/** A walk through the village and its NPCs; every frame's state is kept. */
function walk(world: BoundGameWorld, out?: string[]): void {
  hold(world, BTN.LEFT, 40, out);
  hold(world, 0, 20, out);
  hold(world, BTN.DOWN, 24, out);
  hold(world, BTN.RIGHT, 48, out);
  hold(world, 0, 60, out);
  hold(world, BTN.UP, 32, out);
  hold(world, 0, 30, out);
}

simDescribe("KS2 save and load through GameView", () => {
  for (const hz of [60, 30]) {
    test(`a load resumes frame-for-frame and L does not rewind (${hz} Hz)`, async () => {
      const world = await bootGameWorld(appBundle("ks2-save"), hz);
      world.frame(0, 0x8080);
      world.tick();
      // Walk away from the start and stop on a tile, then save.
      hold(world, BTN.RIGHT, 24);
      hold(world, 0, 16);
      tap(world, BTN.START);
      expect(fixture().error).toBeNull();
      expect(fixture().saves).toBe(1);
      expect(fixture().code!.startsWith("z1")).toBe(true);
      const saved = key(world.probes().state);
      const savedPixels = fnv1a(world.render());

      // The run that never leaves the save point.
      const reference: string[] = [];
      walk(world, reference);
      expect(new Set(reference).size).toBeGreaterThan(frames(world, 100));

      // Wander off somewhere else, then load.
      hold(world, BTN.LEFT, 30);
      hold(world, BTN.DOWN, 30);
      expect(key(world.probes().state)).not.toBe(saved);
      tap(world, BTN.SELECT);
      expect(fixture().error).toBeNull();
      expect(fixture().loads).toBe(1);
      expect(key(world.probes().state)).toBe(saved);
      // Characters stand where they stood at the save, so the loaded frame
      // repaints the save frame exactly (Sunstone has no animated tiles).
      expect(fnv1a(world.render())).toBe(savedPixels);

      // The same input after the load visits the same states.
      const resumed: string[] = [];
      walk(world, resumed);
      expect(resumed.length).toBe(reference.length);
      for (let i = 0; i < reference.length; i++) {
        if (resumed[i] !== reference[i]) throw new Error(`frame ${i} after the load differs`);
      }

      // L is an ordinary button here: the interpreter clock keeps running
      // forward and the player stays put, with no rewind notice.
      const before = world.probes().state;
      const tile = [before.move.tx, before.move.ty];
      const clock = before.interp.frame;
      hold(world, BTN.L, 90);
      const after = world.probes().state;
      expect([after.move.tx, after.move.ty]).toEqual(tile);
      expect(after.interp.frame).toBe(clock + 90);
      expect(JSON.stringify(world.getTree())).not.toContain("rpgkit-rewind-notice");
    });
  }

  test("a save off a safe point is refused with a code and changes nothing", async () => {
    const world = await bootGameWorld(appBundle("ks2-save"), 60);
    world.frame(0, 0x8080);
    world.tick();
    // Mid-step: the first frame of a walk.
    world.frame(BTN.RIGHT, 0x8080);
    world.tick();
    const moving = world.probes().state;
    expect(moving.move.moving || moving.move.phase !== 0).toBe(true);
    const before = key(moving);
    world.frame(BTN.START | BTN.RIGHT, 0x8080);
    world.tick();
    expect(fixture().error).toBe("not-safe-point");
    expect(fixture().code).toBeNull();
    // The consumed frame folded nothing.
    expect(key(world.probes().state)).toBe(before);
  });

  for (const hz of [60, 30]) {
    test(`a save during the attract demo keeps the tape's held buttons (${hz} Hz)`, async () => {
      // The demo walks up to the elder with CIRCLE held from the first step,
      // so no press ever reaches him, then keeps holding it in front of him.
      const tape = [
        ...Array<number>(10).fill(0),
        ...Array<number>(60).fill(BTN.UP | BTN.CIRCLE),
        ...Array<number>(600).fill(BTN.CIRCLE),
      ];
      const world = await bootGameWorld(appBundle("ks2-save"), hz, { __ks2SaveAttractTape: tape });
      // Idle into attract (ten seconds), then let the demo reach the elder.
      hold(world, 0, 600);
      hold(world, 0, 120);
      const demo = world.probes().state;
      expect([demo.move.tx, demo.move.ty, demo.move.facing]).toEqual([9, 6, 2]);
      expect(demo.interp.modal).toBeNull();
      // The save frame is the overlay's: it folds nothing.
      world.frame(BTN.START, 0x8080);
      world.tick();
      expect(fixture().error).toBeNull();
      expect(fixture().saves).toBe(1);
      expect(key(world.probes().state)).toBe(key(demo));
      // The host held nothing; the reducer folded the tape's CIRCLE.
      expect(decodeSaveCode(fixture().code!).held).toBe(BTN.CIRCLE);
      const saved = key(demo);

      // Load with CIRCLE already held and keep holding it: live play goes
      // on from the save with the button the demo was holding.
      hold(world, 0, 30);
      world.frame(BTN.SELECT | BTN.CIRCLE, 0x8080);
      world.tick();
      expect(fixture().error).toBeNull();
      expect(fixture().loads).toBe(1);
      expect(key(world.probes().state)).toBe(saved);

      // Without the save the reducer would fold CIRCLE after CIRCLE: no
      // confirm edge, so the elder does not start talking.
      const resumed: string[] = [];
      hold(world, BTN.CIRCLE, 20, resumed);
      expect(world.probes().state.interp.modal).toBeNull();
      // At 60 Hz each host frame folds one tape-rate tick: the view matches
      // a fresh session folding CIRCLE against the saved held mask.
      if (hz === 60) {
        const session = createSession(buildGame().project, 60);
        const loaded = loadSession(session, fixture().code!);
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        let state = loaded.state;
        let previous = loaded.held;
        for (let i = 0; i < resumed.length; i++) {
          const pressed = BTN.CIRCLE & ~previous;
          state = stepSession(session, state, {
            buttons: BTN.CIRCLE,
            confirmEdge: pressed !== 0,
            cancelEdge: false,
            upEdge: false,
            downEdge: false,
            leftEdge: false,
            rightEdge: false,
          });
          previous = BTN.CIRCLE;
          if (key(state) !== resumed[i]) throw new Error(`frame ${i} after the load differs`);
        }
      }
    });
  }
});
