// KA1 QuickJS workload: the per-frame cost of live map animations, split
// into the reducer share and the UI share.
//
// Reducer: copyInterp shares the anims array (copy-on-write: mapAnim/
// stopAnim take a private copy via writableAnims, steady-state playback
// clones nothing), so 0 vs 50 live instances must cost the same in
// stepSession. Both scenarios run the SAME parallel fiber (a long wait)
// so the only difference is the anims count; the earlier bench compared
// a no-event world against a fiber world and attributed the fiber cost
// to the instances.
//
// UI: MapAnimLayer.onFrame does per-instance JS work (frame selection via
// animFrameIndex, pixel position resolution, slot comparison) plus host
// renderer calls (jump/setProp, which are host ops, not QuickJS JS). The
// ui0/ui50 cases replicate the per-instance JS hot loop without the host
// ops to isolate the QuickJS JS cost per instance per frame.
//
// Run by tools/ka1-quickjs-bench.sh (which reuses pr1-quickjs-bench.rs).

import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import { animFrameIndex, compileAnim, type MapAnimInstance } from "../src/engine/interpreter.ts";
import type { AnimationDef, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "ka1-bench";

const PULSE: AnimationDef = {
  id: "pulse",
  sheet: "pulse.png",
  count: 4,
  frameDuration: 0.25,
  loop: true,
};

function benchProject(animCount: number): Project {
  const map: MapDef = {
    id: MAP_ID,
    name: "KA1 bench",
    width: 32,
    height: 32,
    sheets: ["plain"],
    ground: new Array(32 * 32).fill("plain.0"),
    // Both scenarios carry the SAME parallel fiber (a long wait) so the
    // 0-vs-50 delta isolates the anims count, not the fiber. The 0-case
    // starts zero instances; the 50-case starts fifty looping ones.
    events: [{
      id: "spawn",
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        commands: [
          ...Array.from({ length: animCount }, (_, i) => ({
            op: "mapAnim" as const,
            id: `fx${i}`,
            anim: "pulse",
            x: i % 32,
            y: Math.floor(i / 32),
            loop: true,
          })),
          { op: "wait" as const, seconds: 100000 },
        ],
      }],
    }],
  };
  return {
    format: "rpgkit-project/v1",
    title: "KA1 QuickJS bench",
    tileSize: 16,
    start: { map: MAP_ID, x: 16, y: 16, dir: "down" as const },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" as const }],
    items: [],
    animations: animCount > 0 ? [PULSE] : [],
    maps: [map],
  };
}

function makeReducerRunner(animCount: number): () => number {
  const project = benchProject(animCount);
  const session = createSession(project, 60);
  let state = startSession(project, session);
  return () => {
    state = stepSession(session, state, { buttons: 0 });
    return state.interp.frame;
  };
}

// --- UI per-instance JS hot loop ---------------------------------------
// Replicates MapAnimLayer.onFrame's per-instance JS work (frame selection,
// pixel resolution, slot comparison) without the host renderer ops, so the
// QuickJS JS cost per instance is isolated. The position math matches
// pixelOf + the Tuxemon anchor in MapAnimLayer.tsx.

const compiled = compileAnim(PULSE, 60);
const TILE = 16;

function makeInstances(count: number): MapAnimInstance[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `fx${i}`,
    anim: "pulse",
    start: 0,
    x: i % 32,
    y: Math.floor(i / 32),
    target: null,
    layer: "above" as const,
    loop: true,
  }));
}

// A stand-in for SessionState.move + chars: the pixel source pixelOf reads.
const move = { px: 256, py: 256, tx: 16, ty: 16 };

function makeUiRunner(animCount: number): () => number {
  const instances = makeInstances(animCount);
  let frame = 0;
  let sink = 0;
  return () => {
    frame++;
    // The per-instance hot loop, mirroring MapAnimLayer.onFrame.
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]!;
      if (inst.layer !== "above") continue;
      const idx = animFrameIndex(compiled, inst, frame);
      if (idx < 0) continue;
      // pixelOf: fixed tile (target === null).
      const px = inst.x * TILE;
      const py = inst.y * TILE;
      // The anchor + slot comparison (h is 16 for the bench sheet).
      const top = py;
      sink += px + top + idx;
    }
    return sink + frame;
  };
}

const runners: Record<string, () => number> = {
  reducer0: makeReducerRunner(0),
  reducer50: makeReducerRunner(50),
  ui0: makeUiRunner(0),
  ui50: makeUiRunner(50),
};

// Reuse pr1-quickjs-bench.rs, which calls globalThis.__pr1Run(name, iters).
// Assigned without a `declare global` so the entry does not collide with
// pr1-quickjs-entry.ts's narrower BenchName-typed global.
const g = globalThis as unknown as {
  __pr1Run: (name: string, iterations: number) => number;
  __pr1Sink: number;
};
g.__pr1Sink = 0;
g.__pr1Run = (name, iterations) => {
  const bench = runners[name];
  if (!bench) throw new Error(`unknown bench ${name}`);
  let sink = 0;
  for (let i = 0; i < iterations; i++) sink += bench();
  g.__pr1Sink = sink;
  return sink;
};
