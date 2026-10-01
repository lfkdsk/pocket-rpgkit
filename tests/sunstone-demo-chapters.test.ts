// Sunstone's menu chapters are generated safe points in its deterministic
// journey. This suite catches stale save codes, tape slices, speed drift and
// chapter-origin rewind regressions without a renderer.

import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import { canonicalJson, createSessionSnapshot, decodeSaveCode, encodeSaveCode } from "../src/engine/save.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import { chapterTape, loadDemoChapter } from "../src/ui/demo/runtime.ts";
import type { DemoChapter } from "../src/ui/demo/types.ts";
import type { GameViewDemoHost } from "../src/ui/demo-contract.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { playWinningRun } from "../examples/sunstone/journey.ts";
import {
  SUNSTONE_DEMO,
  SUNSTONE_DEMO_CODES,
  SUNSTONE_DEMO_ORIGINS,
} from "../examples/sunstone/demo-chapters.ts";

const BTN_RIGHT = 0x0020;
const BTN_LTRIGGER = 0x0100;
const BTN_SELECT = 0x0001;
const { project } = buildGame();

function mounted(hz = 60) {
  const attract = new AttractController(project, [], { hz });
  const host: GameViewDemoHost = {
    project,
    session: attract.getSession(),
    attract,
    getState: () => attract.state,
  };
  return { attract, host };
}

describe("Sunstone demo chapters", () => {
  test("save codes and tape suffixes match generated journey safe points", () => {
    const run = playWinningRun(60);
    const session = createSession(project, 60);
    const generated = {
      village: encodeSaveCode(createSessionSnapshot(session, startSession(project, session), 0)),
      forest: encodeSaveCode(createSessionSnapshot(
        session,
        run.states[run.milestones.forest]!,
        run.masks[run.milestones.forest]!,
      )),
      cave: encodeSaveCode(createSessionSnapshot(
        session,
        run.states[run.milestones.cave]!,
        run.masks[run.milestones.cave]!,
      )),
    };
    expect(SUNSTONE_DEMO_CODES.village as string).toBe(generated.village);
    expect(SUNSTONE_DEMO_CODES.forest as string).toBe(generated.forest);
    expect(SUNSTONE_DEMO_CODES.cave as string).toBe(generated.cave);

    const chapters = Object.fromEntries(SUNSTONE_DEMO.chapters.map((chapter) => [chapter.id, chapter]));
    expect(chapterTape(chapters.village!)).toEqual(run.masks);
    expect(chapterTape(chapters.forest!)).toEqual(run.masks.slice(SUNSTONE_DEMO_ORIGINS.forest));
    expect(chapterTape(chapters.cave!)).toEqual(run.masks.slice(SUNSTONE_DEMO_ORIGINS.cave));
    // Suffixes start on the source frame after the saved milestone, and
    // all three chapters window the one recorded tape.
    expect(SUNSTONE_DEMO_ORIGINS.forest as number).toBe(run.milestones.forest + 1);
    expect(SUNSTONE_DEMO_ORIGINS.cave as number).toBe(run.milestones.cave + 1);
    expect(chapters.forest!.tape).toBe(chapters.village!.tape);
    expect(chapters.cave!.tape).toBe(chapters.village!.tape);
  });

  test("every chapter's suffix replay ends on the full replay's terminal state", () => {
    const replay = (chapter: DemoChapter, hz: number): { state: string; frame: number } => {
      const { attract, host } = mounted(hz);
      loadDemoChapter(host, chapter, true, 1);
      const frames = chapterTape(chapter).length;
      let hostFrames = 0;
      while (attract.status().demoFrame < frames) {
        attract.step(0);
        if (++hostFrames > 20_000) throw new Error(`${chapter.id} autoplay did not finish at ${hz} Hz`);
      }
      return { state: canonicalJson(attract.state), frame: attract.state.frame };
    };
    const run = playWinningRun(60);
    const [village, ...resumed] = SUNSTONE_DEMO.chapters as DemoChapter[];
    for (const hz of [60, 20]) {
      const full = replay(village!, hz);
      expect(full.frame).toBe(run.masks.length);
      for (const chapter of resumed) {
        const suffix = replay(chapter, hz);
        expect({ id: chapter.id, hz, frame: suffix.frame }).toEqual({ id: chapter.id, hz, frame: full.frame });
        expect(suffix.state).toBe(full.state);
      }
    }
  });

  test("the real cave tape reaches byte-identical state at every host rate and speed", () => {
    const chapter = SUNSTONE_DEMO.chapters.find((candidate) => candidate.id === "cave")!;
    const terminal: { hz: number; speed: number; state: string; log: number[]; hostFrames: number }[] = [];
    for (const hz of [60, 30, 20, 4]) {
      for (const speed of [1, 2, 4] as const) {
        const { attract, host } = mounted(hz);
        loadDemoChapter(host, chapter, true, speed);
        let hostFrames = 0;
        while (attract.status().demoFrame < chapterTape(chapter).length) {
          attract.step(0);
          if (++hostFrames > 2_000) throw new Error(`cave autoplay did not finish at ${hz} Hz / ${speed}x`);
        }
        expect(attract.state.sw.items.sunstone).toBe(1);
        expect(attract.state.sw.switches.won).toBe(true);
        terminal.push({
          hz,
          speed,
          state: canonicalJson(attract.state),
          log: attract.inputLog,
          hostFrames,
        });
      }
    }
    expect(new Set(terminal.map(({ state }) => state)).size).toBe(1);
    expect(new Set(terminal.map(({ log }) => canonicalJson(log))).size).toBe(1);
    expect(terminal.filter(({ hz }) => hz === 60).map(({ hostFrames }) => hostFrames)).toEqual([941, 471, 236]);
  });

  test("takeover and L rewind return to the chapter origin, including held-edge state", () => {
    const chapter = SUNSTONE_DEMO.chapters.find((candidate) => candidate.id === "cave")!;
    const current = mounted();
    const origin = structuredClone(loadDemoChapter(current.host, chapter, true, 1));
    const oracle = mounted();
    loadDemoChapter(oracle.host, chapter, true, 1);

    for (let frame = 0; frame < 40; frame++) {
      current.attract.step(0);
      oracle.attract.step(0);
    }
    current.attract.step(BTN_RIGHT);
    oracle.attract.step(0);
    expect(current.attract.status().phase).toBe("play");
    expect(current.attract.state).toEqual(oracle.attract.state);

    current.attract.step(BTN_RIGHT);
    current.attract.step(0);
    current.attract.step(BTN_LTRIGGER);
    expect(current.attract.state).toEqual(origin);
    expect(current.attract.foldedMask()).toBe(decodeSaveCode(SUNSTONE_DEMO_CODES.cave).held);

    current.attract.step(0);
    current.attract.step(BTN_SELECT);
    expect(current.attract.status().phase).toBe("attract");
    current.attract.step(0);
    const fresh = mounted();
    loadDemoChapter(fresh.host, chapter, true, 1);
    fresh.attract.step(0);
    expect(current.attract.state).toEqual(fresh.attract.state);
  });
});
