// tests/attract.test.ts — D1/D2 attract controller semantics over
// the pure session reducer (engine/attract.ts):
//
//   1. CLEAN LOOP   the second attract loop reproduces the first frame for
//                   frame; a loop restart is a fresh startSession, not a
//                   fold over victory residue.
//   2. TAKE OVER    taking over at frame k leaves state[k] field-equal to a
//                   run that never took over; takeover changes only the
//                   input source from k+1.
//   3. REWIND       rewinding at frame k to k-3s yields the state of the
//                   from-frame-0 oracle while production restores the nearest
//                   keyframe; distance is 3 seconds at 60/30/20/4 Hz.
//   4. PLAYER INPUT frames the player adds after takeover are part of the
//                   same stream: rewinding walks back through them too.
//   5. RESUME       SELECT after a rewind into the tape prefix resumes the
//                   demo at the rewound frame.
//   6. IDLE/RESET   N seconds without input enters attract; SELECT in
//                   attract restarts from frame 0.
//   7. COST         bounded suffix wall time and rewind-history memory.
//
// The journey tapes are generated at the test's hz by examples/sunstone/journey.ts;
// the shipped frozen tape is 60 Hz (desktop/web run at 60 Hz).

import { describe, expect, test } from "bun:test";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { playWinningRun } from "../examples/sunstone/journey.ts";
import { expandTapeRuns } from "../src/engine/tape.ts";
import { DEMO_TAPE_RUNS } from "../examples/sunstone/demo-tape.ts";
const builtinAttractTape = (): number[] => expandTapeRuns(DEMO_TAPE_RUNS);
import {
  ATTRACT_INPUT_LOG_FRAMES,
  AttractController,
  type AttractStatus,
} from "../src/engine/attract.ts";
import type { SessionState } from "../src/engine/session.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";

const BTN_SELECT = 0x0001;
const BTN_LTRIGGER = 0x0100;
const BTN_RTRIGGER = 0x0200;
const BTN_ZL = 0x0400;
const BTN_ZR = 0x0800;
const BTN_UP = 0x0010;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;

const { project } = buildGame();

function controller(
  hz = 60,
  tape?: number[],
  opts?: { idleFrames?: number; endHoldFrames?: number; tapeHz?: number },
) {
  const t = tape ?? playWinningRun(hz).masks;
  return new AttractController(project, t, {
    hz,
    tapeHz: opts?.tapeHz ?? hz,
    idleFrames: opts?.idleFrames ?? hz * 10,
    endHoldFrames: opts?.endHoldFrames ?? hz,
  });
}

/** Drive a controller with per-frame live masks; return every state. */
function drive(c: AttractController, live: number[]): SessionState[] {
  const out: SessionState[] = [];
  for (const m of live) out.push(c.step(m).state);
  return out;
}

/** States of a plain, non-attract replay of `masks` from frame 0. */
function plainReplay(masks: number[], hz = 60): SessionState[] {
  const c = controller(hz, masks);
  return drive(c, masks);
}

function sourceReplayStates(masks: readonly number[]): SessionState[] {
  const session = createSession(project, 60);
  let state = startSession(project, session);
  let previous = 0;
  const states: SessionState[] = [state];
  for (const mask of masks) {
    const pressed = mask & ~previous;
    previous = mask;
    state = stepSession(session, state, {
      buttons: mask,
      confirmEdge: !!(pressed & BTN_CIRCLE),
      cancelEdge: !!(pressed & BTN_CROSS),
      upEdge: !!(pressed & BTN_UP),
      downEdge: !!(pressed & BTN_DOWN),
    });
    states.push(state);
  }
  return states;
}

describe("D1 — attract loop is a clean reset", () => {
  test("demo presentation reveals 15 characters per second at every host rate", () => {
    const tape = builtinAttractTape();
    for (const hz of [60, 30, 20, 4] as const) {
      const c = controller(hz, tape, { tapeHz: 60, endHoldFrames: 60_000 });
      c.startAttract();

      let shown = c.presentedModal();
      let opened = 0;
      while (shown?.kind !== "text" && opened++ < hz * 30) {
        c.step(0);
        shown = c.presentedModal();
      }
      expect(shown?.kind, `presentation opened @${hz}`).toBe("text");
      if (shown?.kind !== "text") throw new Error(`missing text presentation at ${hz} Hz`);
      const total = shown.total;
      const identity = `${shown.fiber}\u0000${shown.lines.join("\u0000")}`;

      let presented = shown;
      let revealFrames = 0;
      while (!presented.complete && revealFrames++ < hz * 10) {
        c.step(0);
        const next = c.presentedModal();
        if (next?.kind !== "text") throw new Error(`text presentation closed at ${hz} Hz`);
        presented = next;
      }
      expect(`${presented.fiber}\u0000${presented.lines.join("\u0000")}`).toBe(identity);
      // One host-frame tolerance covers quantization at 4 Hz. The 15 is a
      // literal product requirement, independent of production constants.
      expect(revealFrames / hz + 1e-9, `literal 15 cps @${hz}`).toBeGreaterThanOrEqual(total / 15 - 1 / hz);
      expect(revealFrames / hz, `literal 15 cps @${hz}`).toBeLessThanOrEqual(total / 15 + 1 / hz + 1e-9);
    }
  });

  test("every completed line rests for the length-weighted readable interval at every host rate", () => {
    const tape = builtinAttractTape();
    for (const hz of [60, 30, 20, 4] as const) {
      const c = controller(hz, tape, { tapeHz: 60, endHoldFrames: 60_000 });
      c.startAttract();
      let previousKey: string | null = null;
      const holds: { chars: number; sourceFrames: number }[] = [];
      for (let hostFrame = 0; hostFrame < hz * 180 && c.status().demoFrame < tape.length; hostFrame++) {
        const before = c.length;
        c.step(0);
        const modal = c.presentedModal();
        if (modal?.kind !== "text" || !modal.complete) continue;
        const key = `${modal.fiber}\u0000${modal.lines.join("\u0000")}`;
        if (key === previousKey || c.status().readHold <= 0) continue;
        previousKey = key;
        const start = c.length;
        let guard = 0;
        while (c.status().readHold > 0 && guard++ < hz * 4) c.step(0);
        holds.push({ chars: modal.total, sourceFrames: c.length - start + (start - before) });
      }
      expect(holds.length, `dialog count @${hz}`).toBeGreaterThan(0);
      for (const hold of holds) {
        const wantSeconds = Math.min(2.5, 1.5 + hold.chars / 120);
        const want = Math.ceil(wantSeconds * 60);
        expect(hold.sourceFrames, `${hold.chars} chars @${hz}`).toBeGreaterThanOrEqual(want);
        expect(hold.sourceFrames / 60, `${hold.chars} chars @${hz}`).toBeGreaterThanOrEqual(1.5);
        expect(wantSeconds).toBeLessThanOrEqual(2.5);
      }
    }
  });

  test("rewinding through a reading hold resumes its remaining dwell", () => {
    const tape = builtinAttractTape();
    const ref = controller(60, tape, { tapeHz: 60, endHoldFrames: 60_000 });
    ref.startAttract();
    while (ref.status().readHold === 0) ref.step(0);
    for (let i = 0; i < 45; i++) ref.step(0);
    const rewindAt = ref.length;

    const rewound = controller(60, tape, { tapeHz: 60, endHoldFrames: 60_000 });
    rewound.startAttract();
    while (rewound.length < rewindAt + 180) rewound.step(0);
    rewound.step(BTN_LTRIGGER);
    expect(rewound.length).toBe(rewindAt);
    expect(rewound.status().readHold).toBe(ref.status().readHold);
    expect(rewound.state).toEqual(ref.state);

    let refLeft = 0;
    while (ref.status().readHold > 0) { ref.step(0); refLeft++; }
    let rewoundLeft = 0;
    while (rewound.status().readHold > 0) { rewound.step(0); rewoundLeft++; }
    expect(rewoundLeft).toBe(refLeft);
  });

  test("two loops reproduce identical frame states and the restart frame is startSession", () => {
    const hz = 60;
    const tape = playWinningRun(hz).masks;
    const endHold = hz; // 1 s victory rest
    const c = controller(hz, tape, { endHoldFrames: endHold });
    c.startAttract();

    // First paced loop + rest, feeding no live input.
    const firstLoop: SessionState[] = [];
    let resetStatus: AttractStatus | null = null;
    for (let i = 0; i < 20_000; i++) {
      const r = c.step(0);
      resetStatus = r.status;
      if (resetStatus.loopReset) break;
      firstLoop.push(r.state);
    }
    expect(resetStatus?.loopReset).toBe(true);

    // The reset frame's world equals a brand-new session.
    const fresh = startSession(project, c.getSession());
    expect(c.state).toEqual(fresh);

    // Second loop: identical states, victory flags cleared.
    const secondLoop: SessionState[] = [];
    for (let i = 0; i < firstLoop.length; i++) secondLoop.push(c.step(0).state);
    expect(secondLoop).toEqual(firstLoop);
    expect(secondLoop[0]!.sw.switches.won).toBeUndefined();
    expect(secondLoop[0]!.mapId).toBe("village");
  });

  test("N seconds without live input enters attract by itself", () => {
    const c = controller(60, undefined, { idleFrames: 60 });
    for (let i = 0; i < 59; i++) {
      c.step(0);
      expect(c.status().phase).toBe("play");
    }
    c.step(0); // frame 60
    expect(c.status().phase).toBe("attract");
    expect(c.status().demoFrame).toBe(0);
    expect(c.state).toEqual(startSession(project, c.getSession()));
  });

  test("SELECT during attract restarts the loop from frame 0", () => {
    const c = controller();
    c.startAttract();
    for (let i = 0; i < 50; i++) c.step(0);
    expect(c.status().demoFrame).toBe(50);
    const r = c.step(BTN_SELECT);
    expect(r.status.loopReset).toBe(true);
    expect(c.status().demoFrame).toBe(0);
    expect(c.state).toEqual(startSession(project, c.getSession()));
  });
});

describe("D2 — takeover changes the input source, not the world", () => {
  const takeoverKs = [1, 40, 120, 300];

  for (const k of takeoverKs) {
    test(`state at takeover frame ${k} equals the no-takeover state`, () => {
      const tape = playWinningRun(60).masks;
      // Reference: pure attract, never taken over.
      const ref = controller(60, tape);
      ref.startAttract();
      for (let i = 0; i <= k; i++) ref.step(0);
      // Takeover: press RIGHT on frame k.
      const taken = controller(60, tape);
      taken.startAttract();
      for (let i = 0; i < k; i++) taken.step(0);
      taken.step(BTN_RIGHT);
      expect(taken.status().phase).toBe("play");
      // Field-for-field equality of the whole session at frame k.
      expect(taken.state).toEqual(ref.state);
      expect(taken.status().controlNotice).toBeGreaterThan(0);
      expect(taken.status().demoFrame).toBe(ref.status().demoFrame);
    });
  }

  test("from the next frame the live buttons drive the player", () => {
    const tape = playWinningRun(60).masks;
    const c = controller(60, tape);
    c.startAttract();
    const before = c.step(0).state;
    // Take over while holding UP on frame 0; keep holding.
    c.step(BTN_UP); // frame 0 still folds tape[0]
    const tile0 = { x: c.state.move.tx, y: c.state.move.ty };
    void before;
    for (let i = 0; i < 8; i++) c.step(BTN_UP);
    // Live input moved the player one tile north of frame 0's cell.
    expect(c.state.move.tx).toBe(tile0.x);
    expect(c.state.move.ty).toBe(tile0.y - 1);
  });

  for (const [name, mask] of [["R trigger", BTN_RTRIGGER], ["ZL", BTN_ZL], ["ZR", BTN_ZR]] as const) {
    test(`${name} takes over like every non-transport button`, () => {
      const c = controller(60, builtinAttractTape(), { tapeHz: 60 });
      c.startAttract();
      const ref = controller(60, builtinAttractTape(), { tapeHz: 60 });
      ref.startAttract();
      ref.step(0);
      const result = c.step(mask);
      expect(result.status.phase).toBe("play");
      expect(result.state).toEqual(ref.state);
    });
  }
  test("SELECT during live play that never matched the tape restarts the demo", () => {
    // Boot starts in play. The first tape mask is a movement press, so an
    // idle boot frame already diverges: SELECT there must not resume the
    // tape at an inconsistent frame — it restarts cleanly.
    const c = controller();
    expect(c.status().phase).toBe("play");
    c.step(0);
    c.step(BTN_SELECT);
    expect(c.status().phase).toBe("attract");
    expect(c.status().demoFrame).toBe(0);
    expect(c.state).toEqual(startSession(project, c.getSession()));
  });
});

describe("D2 — rewind is a from-zero replay of the unified input stream", () => {
  test("rewinding inside terminal hold restores the exact hold position", () => {
    const c = controller(60, [0], { endHoldFrames: 5, tapeHz: 60 });
    c.startAttract();
    c.step(0); // source frame
    c.step(0);
    c.step(0);
    c.step(0); // three end-hold frames
    expect(c.status().endHold).toBe(3);
    c.step(BTN_LTRIGGER); // default rewind reaches frame zero
    expect(c.status().endHold).toBe(0);

    const precise = new AttractController(project, [0], {
      hz: 60, tapeHz: 60, endHoldFrames: 5, rewindSeconds: 1 / 60,
    });
    precise.startAttract();
    precise.step(0);
    precise.step(0);
    precise.step(0);
    precise.step(0);
    precise.step(BTN_LTRIGGER);
    expect(precise.status().endHold).toBe(2);
    precise.step(0);
    expect(precise.status().endHold).toBe(3);
    precise.step(0);
    expect(precise.status().loopReset).toBe(false);
    precise.step(0);
    expect(precise.status().loopReset).toBe(true);
  });

  test("rewind at frame k to k-180 equals a fresh replay (60 Hz, 3 s)", () => {
    const tape = playWinningRun(60).masks;
    const k = 400;
    const c = controller(60, tape);
    c.startAttract();
    while (c.length < k) c.step(0);
    const beforeLength = c.length;
    c.step(BTN_LTRIGGER); // rewind on frame k
    expect(c.status().rewindNotice).toBeGreaterThan(0);
    expect(c.inputLog).toHaveLength(beforeLength - 180);
    const sourceFrame = c.status().demoFrame;
    expect(c.state).toEqual(sourceReplayStates(tape)[sourceFrame]);
  });

  test("3 virtual seconds is 3*hz frames at every sim rate", () => {
    for (const hz of [60, 30, 20, 4] as const) {
      const tape = builtinAttractTape();
      const c = controller(hz, tape, { tapeHz: 60 });
      c.startAttract();
      for (let i = 0; i < 6 * hz; i++) c.step(0);
      const before = c.inputLog.length;
      c.step(BTN_LTRIGGER);
      expect(c.inputLog, `hz ${hz}`).toHaveLength(Math.max(0, before - 3 * 60));
    }
  });

  test("rewinding at frame 0 stays at frame 0", () => {
    const c = controller();
    c.startAttract();
    c.step(BTN_LTRIGGER);
    expect(c.inputLog).toHaveLength(0);
    expect(c.state).toEqual(startSession(project, c.getSession()));
  });

  test("the player's own post-takeover frames are rewound too", () => {
    const tape = playWinningRun(60).masks;
    const k = 200;
    const c = controller(60, tape);
    c.startAttract();
    while (c.length < k) c.step(0);
    c.step(BTN_RIGHT); // takeover frame k (folds tape[k])
    // Player walks north for two tiles (16 held frames), then idle frames.
    for (let i = 0; i < 16; i++) c.step(BTN_UP);
    for (let i = 0; i < 4; i++) c.step(0);
    const total = c.inputLog.length;

    // Unified stream the controller actually folded. Pacing frames inserted
    // before takeover remain ordinary u16 zero masks in this same stream.
    const prefix = c.inputLog.slice(0, -(16 + 4));
    const unified = prefix.concat(Array<number>(16).fill(BTN_UP), Array<number>(4).fill(0));
    expect(c.inputLog).toEqual(unified);

    c.step(BTN_LTRIGGER);
    expect(c.inputLog).toHaveLength(total - 180);
    const replay = plainReplay(unified.slice(0, total - 180), 60);
    expect(c.state).toEqual(replay[replay.length - 1]!);

    // Continuing live play folds from that exact state.
    const a = c.state;
    c.step(BTN_UP);
    expect(c.state).not.toEqual(a);
  });

  test("SELECT after rewinding into the tape prefix resumes the demo there", () => {
    const tape = Array<number>(400).fill(0);
    const k = 200;
    const c = controller(60, tape);
    c.startAttract();
    for (let i = 0; i < k; i++) c.step(0);
    c.step(BTN_RIGHT); // take over
    for (let i = 0; i < 16; i++) c.step(BTN_UP); // diverge
    c.step(BTN_LTRIGGER); // back into the tape prefix
    const at = c.inputLog.length;
    c.step(BTN_SELECT);
    expect(c.status().phase).toBe("attract");
    expect(c.status().demoFrame).toBe(at);
    // The next folded frames are the tape's again.
    const s0 = c.state;
    c.step(0);
    const ref = plainReplay(tape.slice(0, at + 1), 60);
    expect(c.state).toEqual(ref[ref.length - 1]!);
    void s0;
  });
});

describe("D2 — rewind cost is a bounded keyframe suffix", () => {
  test("a long session restores the nearest minute keyframe", () => {
    // Frame 7,820 restores the frame-7,200 keyframe and folds 620 reducer
    // inputs, rather than rebuilding all 7,820 from the initial state.
    const longTape = Array<number>(8000).fill(0);
    const c = new AttractController(project, longTape, {
      hz: 60, idleFrames: 60_000, endHoldFrames: 60_000, rewindSeconds: 3,
    });
    c.startAttract();
    for (let i = 0; i < 8000; i++) c.step(0);
    const t0 = performance.now();
    c.step(BTN_LTRIGGER); // frame 8000 -> 7820
    const ms = performance.now() - t0;
    const keyframes = c.keyframeStats();
    expect(c.inputLog).toHaveLength(7820);
    expect(keyframes.lastRefoldStart).toBe(7200);
    expect(keyframes.lastRefoldFrames).toBe(620);
    // The u16 payload reserves exactly ten minutes at 60 Hz. Controller
    // metadata packs display state into one flag byte per timeline tick.
    expect(c.inputLogAllocatedBytes).toBe(ATTRACT_INPUT_LOG_FRAMES * Uint16Array.BYTES_PER_ELEMENT);
    expect(c.historyAllocatedBytes).toBe(ATTRACT_INPUT_LOG_FRAMES * 3);
    expect(c.keyframeEstimatedBytes).toBeGreaterThan(0);
    expect(c.rewindHistoryEstimatedBytes).toBe(c.historyAllocatedBytes + c.keyframeEstimatedBytes);
    // Loose Bun threshold for CI noise; QuickJS has a dedicated host bench.
    expect(ms).toBeLessThan(400);
    console.log(
      `attract rewind: ${keyframes.lastRefoldFrames}-frame suffix at frame 8000 = ${ms.toFixed(2)} ms ` +
      `(${(ms / keyframes.lastRefoldFrames).toFixed(4)} ms/frame); input log allocation = ` +
      `${c.inputLogAllocatedBytes} bytes (${c.inputLogAllocatedBytes / 1024} KiB), ` +
      `keyframes ${c.keyframeEstimatedBytes} estimated bytes`,
    );
  });
});

describe("D1 — one published tape is complete-state portable across host rates", () => {
  test("every frozen-tape world is the direct replay world at 60/30/20/4 Hz", () => {
    const tape = builtinAttractTape();
    const plain = controller(60, tape, { tapeHz: 60, endHoldFrames: 60_000 });
    for (const mask of tape) plain.step(mask);
    const direct = sourceReplayStates(tape);
    const states = [60, 30, 20, 4].map((hz) => {
      const c = controller(hz, tape, { tapeHz: 60, endHoldFrames: 60_000 });
      c.startAttract();
      let hostFrames = 0;
      let checked = 0;
      while (c.status().demoFrame < tape.length && hostFrames++ < hz * 600) {
        const before = c.status().demoFrame;
        c.step(0);
        const after = c.status().demoFrame;
        if (after === before) {
          expect(c.state, `${hz} Hz frozen at source ${after}`).toEqual(direct[after]);
          continue;
        }
        // Low-rate hosts can consume several tape masks before one paint.
        // The current world is the direct world at the final consumed k;
        // the 60 Hz case observes every intermediate k independently.
        expect(c.state, `${hz} Hz source ${after}`).toEqual(direct[after]);
        checked++;
      }
      expect(c.status().demoFrame, `${hz} Hz completed`).toBe(tape.length);
      expect(checked).toBeGreaterThan(0);
      return c.state;
    });
    for (let i = 1; i < states.length; i++) expect(states[i]).toEqual(states[0]);
    for (const state of states) expect(state).toEqual(plain.state);
  });
});

describe("demo chapter origins and playback speed", () => {
  test("an empty initial tape stays in live play until a chapter is loaded", () => {
    const c = new AttractController(project, [], { hz: 60, idleFrames: 2 });
    for (let frame = 0; frame < 10; frame++) c.step(0);
    expect(c.status().phase).toBe("play");
    c.step(BTN_SELECT);
    expect(c.status().phase).toBe("play");

    c.step(0); // release SELECT so loading does not inherit a transport edge
    c.loadState(startSession(project, c.getSession()), 0, [0, 0], true, 2);
    expect(c.status().phase).toBe("attract");
    c.step(0);
    expect(c.status().demoFrame).toBe(2);
  });

  test("1x, 2x, and 4x consume the same tape into byte-identical state", () => {
    const tape = Array<number>(32).fill(0);
    const terminal = ([1, 2, 4] as const).map((speed) => {
      const c = controller(60, [], { endHoldFrames: 60_000 });
      const origin = startSession(project, c.getSession());
      origin.sw.switches["chapter.loaded"] = true;
      origin.interp.sw = origin.sw;
      c.loadState(origin, 0, tape, true, speed);
      while (c.status().demoFrame < tape.length) c.step(0);
      expect(c.getPlaybackSpeed()).toBe(speed);
      expect(c.inputLog).toHaveLength(tape.length);
      return c.state;
    });
    expect(terminal[1]).toEqual(terminal[0]);
    expect(terminal[2]).toEqual(terminal[0]);
  });

  test("a loaded chapter is the clean loop and rewind origin", () => {
    const c = new AttractController(project, [], {
      hz: 60,
      endHoldFrames: 60_000,
      rewindSeconds: 1 / 60,
    });
    const origin = startSession(project, c.getSession());
    origin.sw.variables["chapter"] = 2;
    origin.interp.sw = origin.sw;
    c.loadState(origin, BTN_RIGHT, [BTN_RIGHT, 0, BTN_UP], true);
    const canonical = structuredClone(c.state);
    expect(c.foldedMask()).toBe(BTN_RIGHT);

    c.step(BTN_CROSS); // takeover gesture still folds tape[0]
    c.step(BTN_LTRIGGER); // one-frame rewind returns to the chapter origin
    expect(c.state).toEqual(canonical);
    expect(c.foldedMask()).toBe(BTN_RIGHT);
    expect(c.status().demoFrame).toBe(0);

    c.startAttract();
    c.step(0);
    const oracle = new AttractController(project, [], { hz: 60 });
    oracle.loadState(structuredClone(canonical), BTN_RIGHT, [BTN_RIGHT], true);
    oracle.step(0);
    expect(c.state).toEqual(oracle.state);
  });

  test("menu-consumed held input is synchronized without folding", () => {
    const c = controller(60, Array<number>(8).fill(0));
    c.startAttract();
    c.syncLiveButtons(BTN_CROSS);
    const before = c.state;
    c.step(BTN_CROSS);
    expect(c.status().phase).toBe("attract");
    expect(c.state).not.toBe(before);
    expect(c.status().demoFrame).toBe(1);
  });

  test("invalid speeds and tape masks are rejected before replacement", () => {
    const c = controller(60, []);
    const before = c.state;
    expect(() => c.setPlaybackSpeed(3 as 1)).toThrow(/1, 2, or 4/);
    expect(() => c.loadState(startSession(project, c.getSession()), 0, [0x10000], true)).toThrow(/u16/);
    expect(c.state).toBe(before);
  });
});

// --- D3 grown-world play mode ----------------------------------------------
// The grow demo has no tape and never auto-attracts: attractEnabled:false,
// startPlay() enters play directly, idle does nothing, SELECT invokes
// onSelect (back to the growth screen), L still rewinds.

describe("D3 play mode (attractEnabled:false)", () => {
  test("starts in play, never enters attract on idle, SELECT calls onSelect", () => {
    let backs = 0;
    const c = new AttractController(project, [], {
      hz: 60,
      idleFrames: 5,
      attractEnabled: false,
      onSelect: () => backs++,
    });
    c.startPlay();
    for (let i = 0; i < 50; i++) c.step(0);
    expect(c.status().phase).toBe("play");
    expect(backs).toBe(0);
    c.step(BTN_SELECT);
    expect(backs).toBe(1);
    // Still in play (the callback owns the mode switch in the view).
    expect(c.status().phase).toBe("play");
  });

  test("L still rewinds live input from frame 0", () => {
    const c = new AttractController(project, [], { hz: 60, attractEnabled: false });
    c.startPlay();
    for (let i = 0; i < 240; i++) c.step(i % 16 < 8 ? BTN_RIGHT : 0);
    const before = c.length;
    const r = c.step(BTN_LTRIGGER);
    expect(r.status.rewound).toBe(true);
    expect(c.length).toBe(before - 180);
  });
});
