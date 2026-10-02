// Grow-demo simulation workload evaluated by grow-quickjs-bench.rs inside
// PocketJS's shipping desktop QuickJS guest. Every timed operation runs in the
// guest; Rust supplies only a monotonic clock (growClock.now(), ms) and reads
// QuickJS heap usage between calls.
//
// For every parameter set the grow module exports among PARAM_EXPORTS:
//   fold     createGrow, then stepGrowTick until phase === "done"
//   timeline new GrowTimeline, then prefillTo in fixed 8-tick slices until
//            complete (a bench slice, not the UI's frame: the UI records one
//            tick per frame at 60 Hz)
//   seek     on that materialized timeline: far forward 0 -> total, far back
//            total -> 0, 0 -> total/2, then 20 seeks to LCG-chosen ticks
//
// grow-quickjs-bench.sh rewrites the two "../examples/grow/" imports below to
// an absolute checkout path, so one entry can bundle a baseline worktree too.

import * as grow from "../examples/grow/grow.ts";
import { GrowTimeline } from "../examples/grow/grow-timeline.ts";
import type { GrowParams, GrowState } from "../examples/grow/grow.ts";

declare const growClock: { now(): number };

const PARAM_EXPORTS = ["STAMP_PARAMS", "DEFAULT_PARAMS"] as const;
const SLICE_TICKS = 8;
const RANDOM_SEEKS = 20;
const TICK_GUARD = 1_000_000;

function params(name: string): GrowParams {
  const value = (grow as unknown as Record<string, unknown>)[name];
  if (!value || typeof value !== "object") throw new Error(`grow module does not export ${name}`);
  return value as GrowParams;
}

function round(ms: number): number {
  return Math.round(ms * 10_000) / 10_000;
}

function summary(samples: number[]): { mean: number; max: number; p95: number } {
  if (samples.length === 0) return { mean: 0, max: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    mean: round(total / samples.length),
    max: round(sorted[sorted.length - 1]!),
    p95: round(sorted[Math.ceil((sorted.length - 1) * 0.95)]!),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __growNames: () => string;
  // eslint-disable-next-line no-var
  var __growFold: (name: string) => string;
  // eslint-disable-next-line no-var
  var __growTimeline: (name: string) => string;
  // eslint-disable-next-line no-var
  var __growSeek: (name: string) => string;
  // eslint-disable-next-line no-var
  var __growRelease: () => void;
  // Kept alive between calls so the host can measure retained heap.
  // eslint-disable-next-line no-var
  var __growKeep: { done?: GrowState; timeline?: GrowTimeline; cursor?: GrowState };
}

globalThis.__growKeep = {};

globalThis.__growNames = () =>
  JSON.stringify(PARAM_EXPORTS.filter((name) => {
    const value = (grow as unknown as Record<string, unknown>)[name];
    return !!value && typeof value === "object";
  }));

globalThis.__growRelease = () => {
  globalThis.__growKeep = {};
};

globalThis.__growFold = (name) => {
  const p = params(name);
  let started = growClock.now();
  let s = grow.createGrow(p);
  const createMs = growClock.now() - started;
  const perTick: number[] = [];
  const foldStarted = growClock.now();
  while (s.phase !== "done") {
    if (perTick.length >= TICK_GUARD) throw new Error(`${name}: fold did not finish in ${TICK_GUARD} ticks`);
    started = growClock.now();
    s = grow.stepGrowTick(s);
    perTick.push(growClock.now() - started);
  }
  const foldMs = growClock.now() - foldStarted;
  globalThis.__growKeep.done = s;
  const stats = summary(perTick);
  return JSON.stringify({
    kind: "fold",
    name,
    ticks: s.tick,
    create_ms: round(createMs),
    total_ms: round(createMs + foldMs),
    mean_ms: stats.mean,
    p95_ms: stats.p95,
    max_ms: stats.max,
  });
};

globalThis.__growTimeline = (name) => {
  const p = params(name);
  let started = growClock.now();
  const timeline = new GrowTimeline(p);
  const constructMs = growClock.now() - started;
  const slices: number[] = [];
  let target = 0;
  while (!timeline.complete) {
    if (target >= TICK_GUARD) throw new Error(`${name}: timeline did not finish in ${TICK_GUARD} ticks`);
    target += SLICE_TICKS;
    started = growClock.now();
    timeline.prefillTo(target);
    slices.push(growClock.now() - started);
  }
  globalThis.__growKeep.timeline = timeline;
  const stats = summary(slices);
  return JSON.stringify({
    kind: "timeline",
    name,
    ticks: timeline.furthestTick,
    slices: slices.length,
    slice_ticks: SLICE_TICKS,
    construct_ms: round(constructMs),
    total_ms: round(constructMs + slices.reduce((sum, value) => sum + value, 0)),
    mean_slice_ms: stats.mean,
    p95_slice_ms: stats.p95,
    max_slice_ms: stats.max,
  });
};

globalThis.__growSeek = (name) => {
  const timeline = globalThis.__growKeep.timeline;
  if (!timeline) throw new Error(`${name}: __growTimeline must run before __growSeek`);
  const total = timeline.furthestTick;
  // Untimed: create the seek cursor at tick 0 so the far seek measures replay only.
  let cursor = timeline.at(0);
  const time = (tick: number): number => {
    const started = growClock.now();
    // The bench keeps no old state, so it hands the cursor back for reuse.
    cursor = timeline.at(tick, cursor);
    const ms = growClock.now() - started;
    if (cursor.tick !== Math.min(tick, total)) throw new Error(`${name}: at(${tick}) returned tick ${cursor.tick}`);
    return ms;
  };
  const forwardMs = time(total);
  const backMs = time(0);
  const midMs = time(Math.floor(total / 2));
  const random: number[] = [];
  let lcg = 0x5eed;
  for (let i = 0; i < RANDOM_SEEKS; i++) {
    lcg = (Math.imul(lcg, 1_664_525) + 1_013_904_223) >>> 0;
    random.push(time(lcg % (total + 1)));
  }
  globalThis.__growKeep.cursor = cursor;
  const randomStats = summary(random);
  const all = summary([forwardMs, backMs, midMs, ...random]);
  return JSON.stringify({
    kind: "seek",
    name,
    ticks: total,
    forward_far_ms: round(forwardMs),
    back_far_ms: round(backMs),
    mid_ms: round(midMs),
    random_seeks: RANDOM_SEEKS,
    random_mean_ms: randomStats.mean,
    random_max_ms: randomStats.max,
    mean_ms: all.mean,
    max_ms: all.max,
  });
};
