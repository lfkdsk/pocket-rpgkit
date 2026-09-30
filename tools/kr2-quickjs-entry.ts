// Pure engine workload bundled for tools/kr2-quickjs-bench.rs. It keeps one
// deterministic 100k-frame session hot for rewind timing and a separate pair
// straddling a periodic keyframe for per-frame/spike measurements.

import { buildGame } from "../examples/sunstone/game-data.ts";
import { DEMO_TAPE_RUNS } from "../examples/sunstone/demo-tape.ts";
import {
  ATTRACT_KEYFRAME_INTERVAL_FRAMES,
  AttractController,
} from "../src/engine/attract.ts";
import { expandTapeRuns } from "../src/engine/tape.ts";
import type { Project } from "../src/engine/types.ts";

const L = 0x0100;
const LONG_HIGH_WATER = 100_000;
const PROFILE_START = ATTRACT_KEYFRAME_INTERVAL_FRAMES - 100;
const PROFILE_FRAMES = 240;

const project: Project = {
  format: "rpgkit-project/v1",
  title: "KR2 QuickJS rewind benchmark",
  tileSize: 16,
  start: { map: "plain", x: 3, y: 3, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{
    id: "plain",
    name: "Plain",
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events: [],
  }],
};

function controller(tape: readonly number[], keyframeMaxBytes?: number): AttractController {
  const value = new AttractController(project, tape, {
    hz: 60,
    tapeHz: 60,
    idleFrames: 1_000_000,
    endHoldFrames: 1_000_000,
    rewindSeconds: 3,
    ...(keyframeMaxBytes === undefined ? {} : { keyframeMaxBytes }),
  });
  value.startAttract();
  return value;
}

function advanceTo(value: AttractController, length: number): void {
  // A previous benchmark invocation left L held in the transport edge state.
  // The first zero releases it and is also an ordinary source/display step.
  while (value.length < length) value.step(0);
}

const longTape = new Array<number>(LONG_HIGH_WATER + ATTRACT_KEYFRAME_INTERVAL_FRAMES).fill(0);
const long = controller(longTape);
advanceTo(long, LONG_HIGH_WATER);

const { project: sunstone } = buildGame();
const short = new AttractController(sunstone, expandTapeRuns(DEMO_TAPE_RUNS), {
  hz: 60,
  tapeHz: 60,
  idleFrames: 60_000,
  endHoldFrames: 60_000,
  rewindSeconds: 3,
});
short.startAttract();
while (short.status().demoFrame < 500) short.step(0);
const shortHighWater = short.length;

const profileTape = new Array<number>(PROFILE_START + PROFILE_FRAMES + 1).fill(0);
const profileKeyed = controller(profileTape);
const profilePlain = controller(profileTape, 0);
advanceTo(profileKeyed, PROFILE_START);
advanceTo(profilePlain, PROFILE_START);

declare const kr2Clock: { now(): number };

interface FrameProfile {
  frames: number;
  steadyMeanMs: number;
  steadyMaxMs: number;
  plainMeanMs: number;
  plainMaxMs: number;
  keyframeSpikeMs: number;
  keyframeCount: number;
  keyframeBytes: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __kr2Rewind: (name: "short" | "long") => string;
  // eslint-disable-next-line no-var
  var __kr2ProfileFrames: () => string;
  // eslint-disable-next-line no-var
  var __kr2Sink: number;
}

globalThis.__kr2Sink = 0;
globalThis.__kr2Rewind = (name) => {
  const value = name === "long" ? long : short;
  const highWater = name === "long" ? LONG_HIGH_WATER : shortHighWater;
  value.step(0); // release the previous L edge; first call simply advances
  advanceTo(value, highWater);
  value.step(L);
  const stats = value.keyframeStats();
  globalThis.__kr2Sink ^= value.state.frame | value.length | stats.lastRefoldFrames;
  return JSON.stringify({
    name,
    before: highWater,
    after: value.length,
    lastRefoldStart: stats.lastRefoldStart,
    lastRefoldFrames: stats.lastRefoldFrames,
    keyframes: stats.count,
    keyframeBytes: stats.estimatedBytes,
    sink: globalThis.__kr2Sink,
  });
};

globalThis.__kr2ProfileFrames = () => {
  let steadyTotal = 0;
  let steadyMax = 0;
  let steadyCount = 0;
  let plainTotal = 0;
  let plainMax = 0;
  let keyframeSpike = 0;

  for (let frame = 0; frame < PROFILE_FRAMES; frame++) {
    const captures = (profileKeyed.length + 1) % ATTRACT_KEYFRAME_INTERVAL_FRAMES === 0;
    let started = kr2Clock.now();
    profileKeyed.step(0);
    const keyedMs = kr2Clock.now() - started;
    if (captures) keyframeSpike = Math.max(keyframeSpike, keyedMs);
    else {
      steadyTotal += keyedMs;
      steadyMax = Math.max(steadyMax, keyedMs);
      steadyCount++;
    }

    started = kr2Clock.now();
    profilePlain.step(0);
    const plainMs = kr2Clock.now() - started;
    plainTotal += plainMs;
    plainMax = Math.max(plainMax, plainMs);
  }

  const stats = profileKeyed.keyframeStats();
  const profile: FrameProfile = {
    frames: PROFILE_FRAMES,
    steadyMeanMs: steadyTotal / steadyCount,
    steadyMaxMs: steadyMax,
    plainMeanMs: plainTotal / PROFILE_FRAMES,
    plainMaxMs: plainMax,
    keyframeSpikeMs: keyframeSpike,
    keyframeCount: stats.count,
    keyframeBytes: stats.estimatedBytes,
  };
  globalThis.__kr2Sink ^= profileKeyed.state.frame | profilePlain.state.frame;
  return JSON.stringify(profile);
};
