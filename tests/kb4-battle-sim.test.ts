// tests/kb4-battle-sim.test.ts — KB4 (src/ui/battle) proven end to end
// through the real GameView -> Battle Processing pipeline, using the demo
// BattleRules/BattleSceneComponent in tests/fixtures/kb4-battle/ (rules.ts,
// scene.tsx). tests/kb4-battle-rules.test.ts already covers the state
// machine in isolation; this file is about the RENDERED contract: golden
// pixels at both spec resolutions, semantic pixel assertions tied to the
// exact same pure math the components use (src/ui/battle/effects.ts,
// StatBar.barFillWidth), determinism (the presentation holds no clock of
// its own), Hz-independence, and a steady-state node-count budget during
// an animated beat.
//
// The scripted fight is a guaranteed one-hit kill (enemyHp: 4 <= Tackle's
// minimum roll of 4) so the whole win path - intro, command grid, hit
// shake+HP tween, faint sink/fade, win message, scene close - is a short,
// fully deterministic sequence safe to replay at every Hz.

import { describe, expect, test } from "bun:test";
import { decodePng, unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
// Imported straight from effects.ts, NOT the src/ui/battle barrel: the
// barrel re-exports the JSX components too, and Bun's test runner (unlike
// tools/build.ts's own JSX pass) has no JSX transform configured, so a
// plain `bun test` import of anything that drags in a .tsx component
// fails to resolve react/jsx-dev-runtime. effects.ts is plain TypeScript.
import { barFillWidth, shakeOffsetX, faintPose, tweenAt } from "../src/ui/battle/effects.ts";
import { demoState, enemyEffect, enemyHpTween, messageRevealed, playerEffect, type DemoBattleState } from "./fixtures/kb4-battle/rules.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("kb4-battle");
if (!preflight.ok) console.warn(`kb4-battle sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const SETUP = { enemyHp: 4 } as const;
// A guaranteed one-hit LOSS, the mirror of SETUP's guaranteed one-hit win:
// playerHp: 1 with Guard selected halves resolveEnemyTurn's damage
// (max(1, floor(raw/2)), raw in [3,6]) but never below 1, so the very
// first enemy counter always zeroes the player out. enemyHp is left at
// its default (never touched on this path).
const LOSE_SETUP = { playerHp: 1 } as const;
const SPRITE_SIZE = 64;
const STRUCTURAL_OPS = ["createNode", "destroyNode", "insertBefore", "removeChild"] as const;
type StructuralCounts = Record<(typeof STRUCTURAL_OPS)[number], number>;
const zeroStructural = (): StructuralCounts =>
  Object.fromEntries(STRUCTURAL_OPS.map((op) => [op, 0])) as StructuralCounts;

/** Wraps a booted world's four structural native-tree ops so every call
 *  increments `counts` in place. The caller resets `counts[op] = 0` between
 *  frames (not the object's identity: bootGameWorld installs this mutator
 *  once, at boot, so a later frame's reset must mutate the same object the
 *  wrapped ops still close over). */
function installStructuralCounter(counts: StructuralCounts) {
  return (ops: Record<string, unknown>): void => {
    for (const op of STRUCTURAL_OPS) {
      const fn = ops[op] as ((...args: unknown[]) => unknown) | undefined;
      if (!fn) continue;
      ops[op] = (...args: unknown[]) => {
        counts[op]++;
        return fn.apply(ops, args);
      };
    }
  };
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let f = 0; f < frames; f++) {
    world.frame(buttons, 0x8080);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
}

/** Real seconds -> host frames at `hz`, rounded (the fixed 60 Hz reference
 *  ticks folded per frame vary, but the elapsed reference time does not). */
function seconds(hz: number, s: number): number {
  return Math.round(hz * s);
}

function sceneState(world: BoundGameWorld): DemoBattleState {
  const raw = world.probes().state.scene?.state;
  if (raw === undefined || raw === null) throw new Error("kb4-battle sim: no active battle scene");
  return demoState(raw) as DemoBattleState;
}

/** Drives the fixture from boot through the guaranteed win, at `hz`,
 *  recording a frame hash after every beat settles. Every wait is
 *  generous relative to that beat's `beatDuration` (all under 50 ticks
 *  here), so it is safe at every Hz down to 4. */
async function playToWin(
  hz: number,
  viewport: { width: number; height: number } = { width: 480, height: 272 },
): Promise<{ world: BoundGameWorld; hashes: Record<string, string>; finalState: unknown }> {
  const world = await bootGameWorld(appBundle("kb4-battle"), hz, { __kb4Setup: SETUP }, undefined, viewport);
  const hashes: Record<string, string> = {};
  const snap = (name: string): void => {
    hashes[name] = fnv1a(world.render());
  };

  // Every checkpoint below waits a fixed amount of ELAPSED REFERENCE TIME
  // (seconds(hz, ...) reference ticks, not host frames) after the button
  // edge that triggers it before sampling a frame. A bare single host
  // frame folds a different number of reference ticks at different Hz
  // (ticksPerFrame = 60/hz), so "1 frame after the edge" is a different
  // point on the beat's own tick-driven typewriter/tween/shake at 4 Hz
  // than at 60 Hz — expected, not a bug, but it means only a SETTLED wait
  // (long relative to any beat's `beatDuration`, itself under 50 ticks
  // here) is safe to compare across Hz.
  const settle = (): void => pump(world, seconds(hz, 0.5));

  settle();
  snap("intro");

  pump(world, seconds(hz, 2)); // clear the intro beat's gate
  pump(world, 1, BTN_CIRCLE);
  settle();
  snap("command");

  pump(world, 1, BTN_CIRCLE); // Fight (guaranteed kill)
  settle();
  pump(world, seconds(hz, 2)); // -> faint beat ready
  pump(world, 1, BTN_CIRCLE);
  settle();
  snap("faintSettled");

  pump(world, seconds(hz, 2));
  pump(world, 1, BTN_CIRCLE); // -> win message beat
  settle();
  snap("winSettled");

  pump(world, seconds(hz, 2));
  pump(world, 1, BTN_CIRCLE); // -> done
  settle();
  snap("done");
  // NOT the whole SessionState: it includes interpreter fiber bookkeeping
  // (parked-branch frame counters) that a script driven by discrete button
  // PRESSES — unlike a continuous hold — is not guaranteed to reach at an
  // identical count across Hz (each press frame folds a full
  // ticksPerFrame regardless of Hz, so five presses can cost a few
  // reference ticks more at 4 Hz than at 60 Hz). The battle's actual
  // OUTCOME (switches/variables KB2 wrote back, and the scene closing) is
  // the meaningful cross-Hz claim, together with the pixel hashes above.
  const probed = world.probes().state;
  const finalState = structuredClone({
    scene: probed.scene,
    switches: probed.sw.switches,
    variables: probed.sw.variables,
  });

  return { world, hashes, finalState };
}

/** Drives a fresh world from boot to the guaranteed loss's ("You lost...")
 *  message beat, settled, using LOSE_SETUP + Guard so the PLAYER (not the
 *  enemy) takes the lethal hit. Mirrors the win path's own boot -> command
 *  -> hit -> faint -> message sequence in playToWin/the win pixel test
 *  above, just aimed at the opposite side. */
async function bootToLoseMessage(
  hz: number,
  viewport: { width: number; height: number } = { width: 480, height: 272 },
): Promise<BoundGameWorld> {
  const world = await bootGameWorld(appBundle("kb4-battle"), hz, { __kb4Setup: LOSE_SETUP }, undefined, viewport);
  pump(world, 1);
  pump(world, seconds(hz, 2));
  pump(world, 1, BTN_CIRCLE); // dismiss intro -> command
  pump(world, 1);
  pump(world, 1, BTN_DOWN); // commandIndex 0 (Fight) -> 2 (Guard)
  pump(world, 1);
  pump(world, 1, BTN_CIRCLE); // Guard -> braces beat, afterBeat enemyTurn
  pump(world, 1);
  pump(world, seconds(hz, 2)); // -> braces beat ready
  pump(world, 1, BTN_CIRCLE); // resolveEnemyTurn: guaranteed lethal counter -> hit beat
  pump(world, 1);
  pump(world, seconds(hz, 2)); // -> hit beat ready
  pump(world, 1, BTN_CIRCLE); // -> faint beat
  pump(world, 1);
  pump(world, seconds(hz, 2)); // -> faint beat ready
  pump(world, 1, BTN_CIRCLE); // -> lose message beat
  pump(world, 1);
  pump(world, seconds(hz, 0.5)); // settle: same wait playToWin uses for "winSettled"
  return world;
}

simDescribe("KB4 battle UI kit: golden frames + semantic pixel proofs", () => {
  test("battle art is absent at boot, loaded once on entry, and freed on exit", async () => {
    let uploads = 0;
    const frees: number[] = [];
    const imageOps: { kind: "set" | "free"; node?: number; handle: number }[] = [];
    const world = await bootGameWorld(
      appBundle("kb4-battle"),
      60,
      { __kb4Setup: SETUP },
      (ops) => {
        const upload = ops.uploadImgEntry as (blob: Uint8Array) => number;
        const free = ops.freeTexture as (handle: number) => void;
        const setImage = (ops.setImage as (node: number, handle: number) => void).bind(ops);
        ops.uploadImgEntry = (blob: Uint8Array): number => {
          uploads++;
          return upload.call(ops, blob);
        };
        ops.freeTexture = (handle: number): void => {
          frees.push(handle);
          imageOps.push({ kind: "free", handle });
          free.call(ops, handle);
        };
        ops.setImage = (node: number, handle: number): void => {
          imageOps.push({ kind: "set", node, handle });
          setImage(node, handle);
        };
      },
      { width: 480, height: 272 },
    );

    const eagerUploads = uploads;
    expect(eagerUploads).toBe(3); // map ground/upper + the walker, never battle art
    pump(world, 1);
    expect(uploads).toBe(eagerUploads + 2);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 2);
    expect(world.probes().state.scene).toBeNull();
    expect(uploads).toBe(eagerUploads + 2);
    expect(frees).toHaveLength(2);
    expect(new Set(frees).size).toBe(2);
    for (const handle of frees) {
      const freeAt = imageOps.findIndex((op) => op.kind === "free" && op.handle === handle);
      let attachAt = -1;
      for (let index = 0; index < freeAt; index++) {
        if (imageOps[index]!.kind === "set" && imageOps[index]!.handle === handle) attachAt = index;
      }
      expect(attachAt).toBeGreaterThanOrEqual(0);
      const node = imageOps[attachAt]!.node;
      const detachAt = imageOps.findIndex((op, index) =>
        index > attachAt && index < freeAt && op.kind === "set" && op.node === node && op.handle === -1);
      expect(detachAt, `texture ${handle} must detach before free`).toBeGreaterThan(attachAt);
    }
  }, 30_000);

  test("the built pak contains lazy TILESET battlers and no eager battler IMG", async () => {
    const bytes = new Uint8Array(await Bun.file(`${appBundle("kb4-battle")}.pak`).arrayBuffer());
    const keys = unpack(bytes).map((entry) => entry.key);
    expect(keys).toContain("ui:tile.kb4-battle/enemy");
    expect(keys).toContain("ui:tile.kb4-battle/player");
    expect(keys.some((key) => key.includes("battler-enemy.png") || key.includes("battler-player.png"))).toBe(false);
  });

  test("480x272: pinned frame hashes across the win sequence", async () => {
    const { hashes } = await playToWin(60);
    expect(hashes).toEqual({
      intro: "70639d0e",
      command: "d72b8275",
      faintSettled: "bd4647b9",
      winSettled: "3bb76c77",
      done: "eeff8bc5",
    });
  }, 30_000);

  test("960x544: the same sequence at the wide resolution", async () => {
    const { hashes } = await playToWin(60, { width: 960, height: 544 });
    expect(hashes).toEqual({
      intro: "ac3a898e",
      command: "b36f8a75",
      faintSettled: "78090eb9",
      winSettled: "f83be6f7",
      done: "cfa51bc5",
    });
  }, 30_000);

  test("the command grid highlights the selected cell in the theme accent colour", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    const frame = world.render();
    const width = 480;
    const accent: readonly [number, number, number] = [0xff, 0xe9, 0x7a];
    const ink: readonly [number, number, number] = [0xdc, 0xe8, 0xff];
    const hasColour = (x0: number, x1: number, y0: number, y1: number, [r, g, b]: readonly [number, number, number]): boolean => {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          if (frame[i] === r && frame[i + 1] === g && frame[i + 2] === b) return true;
        }
      }
      return false;
    };
    // The panel docks at insetR:8,insetB:8, 240x48 (CommandGrid's fixed
    // size): "Fight" is the top-left cell, "Skill" the top-right.
    const panelX0 = width - 8 - 240;
    const panelY0 = 272 - 8 - 48;
    expect(hasColour(panelX0, panelX0 + 116, panelY0, panelY0 + 22, accent)).toBe(true);
    expect(hasColour(panelX0, panelX0 + 116, panelY0, panelY0 + 22, ink)).toBe(false);
    expect(hasColour(panelX0 + 116, panelX0 + 232, panelY0, panelY0 + 22, ink)).toBe(true);
    expect(hasColour(panelX0 + 116, panelX0 + 232, panelY0, panelY0 + 22, accent)).toBe(false);
  }, 30_000);

  test("the enemy HP bar's fill width is exactly barFillWidth(tweened hp, max, 64)", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // Fight: enemy hp tween starts (4 -> 0)
    pump(world, 1);
    pump(world, 3); // partway through the tween

    const state = sceneState(world);
    expect(state.phase).toBe("beat");
    const tweened = tweenAt(enemyHpTween(state), state.nowTick);
    const expectedFill = barFillWidth(tweened, state.enemy.maxHp, SPRITE_SIZE);
    expect(expectedFill).toBeGreaterThan(0);
    expect(expectedFill).toBeLessThan(SPRITE_SIZE);

    const frame = world.render();
    const width = 480;
    const barX0 = width - SPRITE_SIZE - 24; // enemy HUD docks above the enemy sprite
    const barY = 12 + 3; // StatBar height 6, sampled mid-bar
    const fillColour: readonly [number, number, number] = [0x5f, 0xd6, 0x6a]; // scene.tsx's enemy fill override
    const pixelAt = (x: number): readonly [number, number, number] => {
      const i = (barY * width + x) * 4;
      return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    };
    expect(pixelAt(barX0 + expectedFill - 1)).toEqual(fillColour);
    expect(pixelAt(barX0 + expectedFill)).not.toEqual(fillColour);
  }, 30_000);

  test("the enemy sprite's shake offset matches shakeOffsetX exactly, pixel for pixel", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // Fight -> shake beat on the enemy
    pump(world, 1);
    pump(world, 3);

    const state = sceneState(world);
    const effect = enemyEffect(state);
    expect(effect.kind).toBe("shake");
    const dx = shakeOffsetX(effect, state.nowTick);
    expect(dx).not.toBe(0); // the whole point of this frame

    const width = 480;
    const restX = width - SPRITE_SIZE - 24;
    const restY = 24;
    const sampleY = restY + 40; // below the sprite's mark stripe (rows 20-28)
    const frame = world.render();
    const at = (x: number): readonly [number, number, number] => {
      const i = (sampleY * width + x) * 4;
      return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    };
    const bodyColour: readonly [number, number, number] = [0x4a, 0x96, 0xd6];
    const bg: readonly [number, number, number] = [0x10, 0x18, 0x20];
    // The sprite is a 64px solid fill: sampling a couple of pixels inside
    // its interior can't tell a few-pixel shift apart (both positions are
    // still body colour). Sample its LEFT EDGE instead — the one place a
    // horizontal shift is visible one pixel at a time: just inside the
    // shifted sprite is body colour, one pixel further out is background.
    expect(at(restX + dx)).toEqual(bodyColour);
    expect(at(restX + dx - 1)).toEqual(bg);
  }, 30_000);

  test("the faint effect sinks and fades the enemy sprite by exactly faintPose's numbers", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // Fight: guaranteed kill
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // -> faint beat
    pump(world, 1);
    pump(world, 5);

    const state = sceneState(world);
    const effect = enemyEffect(state);
    expect(effect.kind).toBe("faint");
    const pose = faintPose(effect, state.nowTick);
    expect(pose.sinkY).toBeGreaterThan(0);
    expect(pose.opacity).toBeGreaterThan(0);
    expect(pose.opacity).toBeLessThan(1);

    const width = 480;
    const restX = width - SPRITE_SIZE - 24;
    const restY = 24;
    const frame = world.render();
    const at = (x: number, y: number): readonly [number, number, number] => {
      const i = (y * width + x) * 4;
      return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    };
    const bg: readonly [number, number, number] = [0x10, 0x18, 0x20];
    const bodyColour: readonly [number, number, number] = [0x4a, 0x96, 0xd6];
    const expectBlend = (colour: readonly [number, number, number], opacity: number): number[] =>
      colour.map((c, i) => Math.round(bg[i]! * (1 - opacity) + c * opacity));

    // The exact top edge moves by sinkY: the preceding row is background,
    // while source row zero appears at the computed edge with faded colour.
    expect(at(restX + 2, restY + pose.sinkY - 1)).toEqual([...bg]);
    const sunk = at(restX + 2, restY + pose.sinkY);
    const blended = expectBlend(bodyColour, pose.opacity);
    for (let c = 0; c < 3; c++) expect(Math.abs(sunk[c]! - blended[c]!)).toBeLessThanOrEqual(2);
  }, 30_000);

  // A defeated side must not reappear at rest, fully opaque, the moment
  // its own faint beat gives way to the win/lose message beat (the rules
  // fixture unconditionally resets effectSide/Kind for the NEXT beat, and
  // the presentation has no memory of its own). A fainted fighter must
  // hold its terminal sunk/faded pose for as long as the scene stays up,
  // not just for the duration of its own faint beat.
  test("the enemy stays in its settled faint pose (not fully opaque) through the win message beat", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // Fight: guaranteed kill -> shake beat
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // -> faint beat
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // -> win message beat
    pump(world, 1);
    pump(world, seconds(60, 0.5)); // settle: same wait playToWin uses for "winSettled"

    const state = sceneState(world);
    expect(state.phase).toBe("beat");
    expect(state.message).toBe("You win!");
    // enemyEffect() no longer reports "shake"/"faint" for THIS beat (its
    // effectSide is "none", like every message-only beat), but the sprite
    // must still read as sunk/invisible rather than back at full opacity.

    const width = 480;
    const restX = width - SPRITE_SIZE - 24;
    const restY = 24;
    const frame = world.render();
    const at = (x: number, y: number): readonly [number, number, number] => {
      const i = (y * width + x) * 4;
      return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    };
    const bg: readonly [number, number, number] = [0x10, 0x18, 0x20];
    const bodyColour: readonly [number, number, number] = [0x4a, 0x96, 0xd6];
    // Every pixel of the enemy's rest rectangle (not just one sample) reads
    // as pure background: fully transparent, nowhere near fully opaque body
    // colour.
    for (let y = restY; y < restY + SPRITE_SIZE; y += 4) {
      for (let x = restX; x < restX + SPRITE_SIZE; x += 4) {
        const pixel = at(x, y);
        expect(pixel).toEqual([...bg]);
        expect(pixel).not.toEqual([...bodyColour]);
      }
    }
  }, 30_000);

  // The mirror of the enemy/win-message test above, for the FAILURE path:
  // playerEffect() must fall back to `state.playerFainted` the same way
  // enemyEffect() falls back to `state.enemyFainted` once the player's own
  // faint beat gives way to the "You lost..." message beat, or the player
  // sprite reappears at rest, fully opaque, under the loss text.
  test("the player stays in its settled faint pose (not fully opaque) through the lose message beat", async () => {
    const world = await bootToLoseMessage(60);

    const state = sceneState(world);
    expect(state.phase).toBe("beat");
    expect(state.message).toBe("You lost...");
    expect(state.player.hp).toBe(0);
    const effect = playerEffect(state);
    expect(effect.kind).toBe("faint"); // held from state.playerFainted, not this beat's effectSide
    const pose = faintPose(effect, state.nowTick);
    // The faint beat's own sink/fade animation finished settling long
    // before this later message beat (playToWin's own faintSettled/
    // winSettled checkpoints are seconds(hz, 2) apart, well past the
    // faint beat's own short duration): sunk to the terminal depth,
    // fully faded, not partway through the tween.
    expect(pose.sinkY).toBeGreaterThan(0);
    expect(pose.opacity).toBe(0);

    const width = 480;
    const height = 272;
    const restX = 24; // scene.tsx: player sprite x = 24
    const restY = height - SPRITE_SIZE - 72; // scene.tsx: player sprite y
    const frame = world.render();
    const at = (x: number, y: number): readonly [number, number, number] => {
      const i = (y * width + x) * 4;
      return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    };
    const bg: readonly [number, number, number] = [0x10, 0x18, 0x20];
    const bodyColour: readonly [number, number, number] = [0xd6, 0x5a, 0x4a]; // gen-assets.ts battler-player fill
    // Every pixel of the player's rest rectangle (not just one sample) reads
    // as pure background: fully transparent, nowhere near fully opaque body
    // colour.
    for (let y = restY; y < restY + SPRITE_SIZE; y += 4) {
      for (let x = restX; x < restX + SPRITE_SIZE; x += 4) {
        const pixel = at(x, y);
        expect(pixel).toEqual([...bg]);
        expect(pixel).not.toEqual([...bodyColour]);
      }
    }
  }, 30_000);
});

simDescribe("KB4 battle UI kit: determinism, Hz-independence, steady state", () => {
  test("two independent runs of the identical script hash identically at every checkpoint (no hidden clock)", async () => {
    const a = await playToWin(60);
    const b = await playToWin(60);
    expect(b.hashes).toEqual(a.hashes);
  }, 60_000);

  test("60/30/20/4 Hz reach the identical final pixels and reducer state for the same elapsed time", async () => {
    // Sequential, not Promise.all: the sim harness's session probes are
    // process globals owned by one world at a time (tests/helpers/sim-
    // session.ts), so concurrent boots race on them.
    const runs = [];
    for (const hz of [60, 30, 20, 4]) runs.push(await playToWin(hz));
    const base = runs[0]!;
    for (const run of runs.slice(1)) {
      expect(run.hashes).toEqual(base.hashes);
      expect(run.finalState).toEqual(base.finalState);
    }
  }, 120_000);

  // A structural-op budget that only zeroed its counters ONE FRAME into the
  // beat and only watched 20 frames would happen to skip exactly the
  // frames where MessageBand's typewriter toggles a row/legend Text child
  // between "" and real text (a real QuickJS host counted 2/2/2/2
  // create/destroy/insert/remove on the hit beat's frame 1 and frame 24
  // once a bug reintroduced literal "" instead of the invisible-placeholder
  // guard). This test measures EVERY single frame from the moment the
  // beat's own mount settles to well past its legend completing, with no
  // window to hide behind, and separately confirms the three specific
  // moments that matter (first typed char, the two-line message's wrap
  // point, and legend completion) were actually reached during the
  // measured span. The fixture's own MessageBand (scene.tsx) passes a real
  // `legend`, so this loop also exercises the legend Text child, not just
  // the message rows.
  test("the hit beat's entire typewriter (first char, the line wrap, legend completion) touches no node lifecycle ops on any single frame", async () => {
    const counts = zeroStructural();
    const world = await bootGameWorld(
      appBundle("kb4-battle"),
      60,
      { __kb4Setup: SETUP },
      installStructuralCounter(counts),
      { width: 480, height: 272 },
    );
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // dismiss intro -> command
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // Fight -> enters the hit beat (MOUNT frame,
    // MessageBand appears from unmounted: legitimately structural, not measured)

    const beat = sceneState(world);
    expect(beat.phase).toBe("beat");
    const lines = beat.message.split("\n");
    expect(lines.length).toBe(2); // exercises the row wrap, not just one row
    const total = beat.message.length;
    const wrapAt = lines[0]!.length + 2; // messageRevealed() count at which row 1 gets its first character (rules.ts's visibleLines contract, shared with DialogBox's)

    const reached = { first: false, wrap: false, complete: false };
    for (let i = 0; i < beat.beatDuration + 10; i++) {
      for (const op of STRUCTURAL_OPS) counts[op] = 0;
      pump(world, 1); // pure animation: no button held
      for (const op of STRUCTURAL_OPS) expect(counts[op]).toBe(0);

      const revealed = messageRevealed(sceneState(world));
      if (revealed === 1) reached.first = true;
      if (revealed === wrapAt) reached.wrap = true;
      if (revealed >= total) reached.complete = true;
    }
    expect(reached).toEqual({ first: true, wrap: true, complete: true });
  }, 30_000);

  test("the faint beat's first typed frame and legend completion touch no node lifecycle ops on any single frame", async () => {
    const counts = zeroStructural();
    const world = await bootGameWorld(
      appBundle("kb4-battle"),
      60,
      { __kb4Setup: SETUP },
      installStructuralCounter(counts),
      { width: 480, height: 272 },
    );
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // dismiss intro -> command
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // Fight: guaranteed kill -> hit beat
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // -> faint beat (MOUNT frame, not measured)

    const beat = sceneState(world);
    expect(beat.phase).toBe("beat");
    expect(beat.message.includes("\n")).toBe(false); // single row here; the hit beat above covers the wrap
    const total = beat.message.length;

    const reached = { first: false, complete: false };
    for (let i = 0; i < beat.beatDuration + 10; i++) {
      for (const op of STRUCTURAL_OPS) counts[op] = 0;
      pump(world, 1);
      for (const op of STRUCTURAL_OPS) expect(counts[op]).toBe(0);

      const revealed = messageRevealed(sceneState(world));
      if (revealed === 1) reached.first = true;
      if (revealed >= total) reached.complete = true;
    }
    expect(reached).toEqual({ first: true, complete: true });
  }, 30_000);
});

simDescribe("KB4 battle UI kit: scene input contract", () => {
  // GameView's useActions() closure must register "back" for a game-owned
  // scene (BattleSceneView, active whenever scene() !== null), not just a
  // map choices/shop modal — otherwise CROSS never produces a cancelEdge
  // for a live scene, forcing this fixture's rules.ts to read BTN_CROSS
  // off the raw button mask itself (the same anti-pattern every other
  // input path in this kit avoids). This test drives an actual GameView
  // (not a hand-built SessionInput) and presses CROSS through the real
  // button pipeline.
  test("pressing CROSS through the real GameView delivers cancelEdge to a live battle scene", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE); // dismiss intro -> command
    pump(world, 1);
    pump(world, 1, BTN_RIGHT); // commandIndex 0 (Fight) -> 1 (Skill)
    pump(world, 1);
    pump(world, 1, BTN_CIRCLE); // confirm -> phase "skills"
    pump(world, 1);
    expect(sceneState(world).phase).toBe("skills");

    pump(world, 1, BTN_CROSS); // the real GameView action pipeline, not a hand-built SessionInput
    pump(world, 1);
    expect(sceneState(world).phase).toBe("command"); // cancelEdge reached the scene
  }, 30_000);
});

/** Writes `frame` to tests/goldens/kb4-battle.<name>.png (only when
 *  KB4_BATTLE_UPDATE_GOLDENS is set) and asserts it matches what's there —
 *  the human-eyeball checkpoints in the "manual visual check" describe
 *  block below. */
async function golden(name: string, frame: Uint8Array, width = 480, height = 272): Promise<void> {
  const url = new URL(`./goldens/kb4-battle.${name}.png`, import.meta.url);
  if (process.env.KB4_BATTLE_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
}

simDescribe("KB4 battle UI kit: manual visual check", () => {
  test("writes the indexed command frame at 960x544", async () => {
    const world = await bootGameWorld(
      appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 960, height: 544 },
    );
    pump(world, 1);
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    await golden("indexed.960", world.render().slice(), 960, 544);
  }, 30_000);

  test("writes the win-sequence frames as PNGs (for the human eyeball, not asserted)", async () => {
    const world = await bootGameWorld(appBundle("kb4-battle"), 60, { __kb4Setup: SETUP }, undefined, { width: 480, height: 272 });
    pump(world, 10);
    const intro = world.render().slice();
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    const command = world.render().slice();
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 3);
    const hit = world.render().slice();
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, 5);
    const faint = world.render().slice();
    pump(world, seconds(60, 2));
    pump(world, 1, BTN_CIRCLE);
    pump(world, 1);
    pump(world, seconds(60, 0.5));
    const winmsg = world.render().slice();

    await golden("intro", intro);
    await golden("command", command);
    await golden("hit", hit);
    await golden("faint", faint);
    await golden("winmsg", winmsg);
  }, 30_000);

  test("writes the lose-message frame as a PNG (for the human eyeball, not asserted)", async () => {
    const world = await bootToLoseMessage(60);
    await golden("losemsg", world.render().slice());
  }, 30_000);
});
