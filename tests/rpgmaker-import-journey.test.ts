// tests/rpgmaker-import-journey.test.ts — the two imported RPG Maker test
// projects played to the end, first on the pure session reducer (the tape
// driver in helpers/rmi-journey.ts walks the main path of each
// tests/fixtures/rpgmaker/README.md walkthrough), then the recorded button
// tape replayed against the built GameView bundle (tests/fixtures/rmi-play)
// on the wasm sim host. The replay must reach the same state at every
// marked frame, and the marked frames are checked by what they show:
// water in the village, the dialog and choices boxes, the placeholder
// battle screen, the curtain picture, the tint.
//
// RMI_SHOTS=<dir> also writes each marked frame (2x) as a PNG for review.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { SessionState } from "../src/engine/session.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";
import { playHollow, playStage, type RmiDriver } from "./helpers/rmi-journey.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";

const ROOT = join(import.meta.dir, "..");
const W = 480;
const H = 272;

const preflight = appPreflight("rmi-play");
if (!preflight.ok) throw new Error(`rpgmaker-import journey: ${preflight.reason}`);
installGameSimIsolation();

const hollowProject = (await importRmProject(loadRmProject(join(ROOT, "tests/fixtures/rpgmaker/hollow-mz")))).project;
const stageProject = (await importRmProject(loadRmProject(join(ROOT, "tests/fixtures/rpgmaker/stage-mv")))).project;

/** Everything the story depends on (no pixels, no clocks). */
function storyState(s: SessionState): Record<string, unknown> {
  return {
    mapId: s.mapId,
    at: [s.move.tx, s.move.ty, s.move.facing],
    switches: s.sw.switches,
    variables: s.sw.variables,
    self: s.sw.self,
    items: s.sw.items,
    gold: s.sw.gold,
    erased: s.interp.erased,
  };
}

/** Pixel class counts of a frame. */
function census(rgba: Uint8Array, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (test(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)) n++;
  return n;
}
function censusRect(
  rgba: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  test: (r: number, g: number, b: number) => boolean,
): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (test(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)) n++;
    }
  }
  return n;
}
const water = (r: number, g: number, b: number) => b > 150 && b > r + 60 && b > g + 20;
const grass = (r: number, g: number, b: number) => g > 120 && g > r + 30 && g > b + 30;
/** The kit dialog paper (#0b1626). */
const navy = (r: number, g: number, b: number) => r === 11 && g === 22 && b === 38;
const battleBg = (r: number, g: number, b: number) => r === 0x1b && g === 0x14 && b === 0x30;
const curtain = (r: number, g: number, b: number) => r > 60 && r > 2 * g && r > 2 * b;
/** Mean brightness of the stage above the dialog box (x 104..375, y 32..169). */
const stageBrightness = (rgba: Uint8Array): number => {
  let sum = 0;
  let n = 0;
  for (let y = 32; y < 170; y++) {
    for (let x = 104; x < 376; x++) {
      const i = (y * W + x) * 4;
      sum += rgba[i]! + rgba[i + 1]! + rgba[i + 2]!;
      n++;
    }
  }
  return sum / n / 3;
};

async function writeShot(game: string, name: string, rgba: Uint8Array): Promise<void> {
  const dir = process.env.RMI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const big = new Uint8Array(W * 2 * H * 2 * 4);
  for (let y = 0; y < H * 2; y++) {
    for (let x = 0; x < W * 2; x++) {
      const s = ((y >> 1) * W + (x >> 1)) * 4;
      big.set(rgba.subarray(s, s + 4), (y * W * 2 + x) * 4);
    }
  }
  await Bun.write(join(dir, `${game}-${name}.png`), encodePNG(big, W * 2, H * 2));
}

/** Replay `d`'s tape in the bundle; return the frame at each mark. */
async function replay(game: "hollow" | "stage", d: RmiDriver): Promise<Map<string, Uint8Array>> {
  const world = await bootGameWorld(appBundle("rmi-play"), 60, { __rmiGame: game });
  const byFrame = new Map<number, string[]>();
  for (const [name, frame] of Object.entries(d.marks)) {
    if (!byFrame.has(frame)) byFrame.set(frame, []);
    byFrame.get(frame)!.push(name);
  }
  const shots = new Map<string, Uint8Array>();
  for (let i = 0; i < d.masks.length; i++) {
    world.frame(d.masks[i]!);
    const names = byFrame.get(i);
    if (!names) continue;
    const s = world.probes().state;
    const px = world.render().slice();
    for (const name of names) {
      shots.set(name, px);
      shots.set(`${name}:state`, new TextEncoder().encode(JSON.stringify(storyState(s))));
      await writeShot(game, name, px);
    }
  }
  return shots;
}

const stateAt = (shots: Map<string, Uint8Array>, name: string): unknown =>
  JSON.parse(new TextDecoder().decode(shots.get(`${name}:state`)!));

describe("rpgmaker-import journey: hollow-mz (village, house, cave, battle)", () => {
  const d = playHollow(hollowProject);

  test("the tape reaches the walkthrough's final state", () => {
    const s = d.state;
    expect(s.mapId).toBe("map001");
    expect([s.move.tx, s.move.ty, s.move.facing]).toEqual([13, 10, 2]);
    expect(s.sw.switches).toMatchObject({ s001: true, s002: true, s004: false, s010: true, s011: true, "party-actor002": true });
    expect(s.sw.variables).toMatchObject({ v001: 3, v005: 100, v009: 5 });
    const luck = Number(s.sw.variables.v002);
    expect(luck).toBeGreaterThanOrEqual(1);
    expect(luck).toBeLessThanOrEqual(6);
    expect(s.sw.variables.v003).toBe(10 + luck);
    expect(s.sw.variables.v006 ?? 0).toBe(0);
    expect(s.sw.variables.v007 ?? 0).toBe(0);
    expect(s.sw.items).toEqual({ item001: 2, item002: 1 });
    expect(s.sw.gold).toBe(150);
    expect(s.sw.self).toMatchObject({
      "map001/ev001": "A",
      "map001/ev005": "A",
      "map001/ev009": "B",
      "map002/ev002": "A",
    });
    for (const mark of ["intro", "village", "elder-choices", "luck-text", "house", "chest", "gate-open", "cave", "battle", "golem-down", "end"]) {
      expect(d.marks[mark]).toBeNumber();
    }
    const luckText = d.markStates["luck-text"]!.interp.modal;
    expect(luckText?.kind).toBe("text");
    if (luckText?.kind === "text") {
      expect(luckText.lines.join(" ")).toContain(`luck today reads ${luck}.`);
      expect(luckText.lines.join(" ")).not.toContain("{v:");
    }
  });

  test("the tape is deterministic", () => {
    expect(playHollow(hollowProject).masks).toEqual(d.masks);
  });

  test("the GameView bundle replays the tape to the same states and pictures", async () => {
    const shots = await replay("hollow", d);
    for (const [name, state] of Object.entries(d.markStates)) expect(stateAt(shots, name)).toEqual(storyState(state));
    expect(stateAt(shots, "end")).toEqual(storyState(d.state));

    // Village after the intro: grass and the animated pond on screen, no box.
    const village = shots.get("village")!;
    expect(census(village, grass)).toBeGreaterThan(W * H / 4);
    expect(census(village, water)).toBeGreaterThan(16 * 16 * 6);
    // The plugin placeholder text box (navy dialog) during the intro.
    expect(census(shots.get("intro")!, navy)).toBeGreaterThan(W * 40);
    // The elder's choices box.
    expect(census(shots.get("elder-choices")!, navy)).toBeGreaterThan(W * 20);
    // The live variable line is fully typeset, not a blank first reveal
    // frame or a literal broken token. Its exact expanded number is checked
    // in the reducer assertion above; here the dialog's text region must
    // contain rendered light glyph pixels.
    expect(censusRect(
      shots.get("luck-text")!, 20, 182, 460, 240,
      (r, g, b) => r > 170 && g > 170 && b > 170,
    )).toBeGreaterThan(W);
    // The house interior has no grass.
    expect(census(shots.get("house")!, grass)).toBeLessThan(W * H / 50);
    // The placeholder battle fills the screen with its backdrop.
    expect(census(shots.get("battle")!, battleBg)).toBeGreaterThan(W * H * 0.8);
  }, 60_000);
});

describe("rpgmaker-import journey: stage-mv (cutscene)", () => {
  const d = playStage(stageProject);

  test("the tape reaches the walkthrough's final state", () => {
    const s = d.state;
    expect(s.mapId).toBe("map001");
    expect([s.move.tx, s.move.ty, s.move.facing]).toEqual([13, 10, 3]);
    expect(s.sw.switches).toMatchObject({ s001: true, s002: true, s003: true, s004: false });
    expect(s.sw.variables).toMatchObject({ v001: 3, v002: 1 });
    expect(d.markStates["cutscene-done"]!.sw.variables.v001).toBe(3);
    expect(s.sw.self).toMatchObject({ "map001/ev001": "A" });
    expect(s.interp.erased).toMatchObject({ "map001/ev007": true });
    for (const mark of ["curtain", "tint", "balloon", "cutscene-done", "claps", "end"]) expect(d.marks[mark]).toBeNumber();
  });

  test("the GameView bundle replays the tape to the same states and pictures", async () => {
    const shots = await replay("stage", d);
    for (const [name, state] of Object.entries(d.markStates)) expect(stateAt(shots, name)).toEqual(storyState(state));
    expect(stateAt(shots, "end")).toEqual(storyState(d.state));
    // The full-screen curtain picture.
    expect(census(shots.get("curtain")!, curtain)).toBeGreaterThan(W * H * 0.5);
    // Erase Event hides the smoke puff (6,5) for good: the cell shows the
    // stage floor again (the 17x13 map is centred: origin (104,32)).
    const end = shots.get("end")!;
    const at = (x: number, y: number) => [...end.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
    const [r, , b] = at(104 + 6 * 16 + 8, 32 + 5 * 16 + 8);
    expect(r! - b!).toBeGreaterThan(60); // warm floor boards, not the grey puff
    // The dusk tint darkens the stage compared with after the cutscene.
    expect(stageBrightness(shots.get("tint")!)).toBeLessThan(stageBrightness(shots.get("cutscene-done")!) * 0.97);
  }, 60_000);
});
