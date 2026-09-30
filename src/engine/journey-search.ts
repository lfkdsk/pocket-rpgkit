// src/engine/journey-search.ts — frame-level route search for
// deterministic journey drivers (examples/sunstone/journey.ts, the Alpine
// Post game) on hosts whose frame spans several motion reference ticks.
//
// At 60 Hz one host frame is one reference tick, so a driver that holds a
// direction until the mover rests on a tile boundary lands exactly where it
// planned. At lower rates one frame folds MOTION_HZ / hz ticks under ONE
// held mask (motion-clock.ts): at 20 Hz a step that arrives on the second
// tick commits a new step on the third, and at 4 Hz a single held frame
// (15 ticks) walks almost two tiles. A tile-exact driver has to look ahead,
// and the lookahead has to be the real reducer, not a model of it.
//
// searchWalk() is A* over host frames: each node is a real stepSession
// result, each edge one of the masks {none, down, left, up, right}. Nodes
// that change map, start an event (except by arriving on the goal), fade,
// or stand on / commit to an avoided cell (transfer pads) are dropped, so
// every returned plan is a simulated trajectory the driver replays
// verbatim. The heuristic is the terrain-only BFS distance in reference
// ticks divided by ticks per frame, which never overestimates (bodies only
// add detours). Waiting is a mask too, and the node key includes every
// character, so a corridor blocked by a wandering NPC is waited out like
// any other route.

import { stepFrames } from "./movement.ts";
import { canStepFrom, type Dir4, type PassageTable } from "./passability.ts";
import { sessionPassageTable, stepSession, type Session, type SessionState } from "./session.ts";

// BTN masks, duplicated so this engine module keeps zero framework imports.
const BTN_UP = 0x0010;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_LEFT = 0x0080;

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
/** Candidate masks in a fixed order, so equal-cost plans tie-break the same
 *  way on every run. */
const CANDIDATES = [0, BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;

export interface WalkSearch {
  session: Session;
  /** State the plan starts from (the driver's current state). */
  state: SessionState;
  /** Mask folded on the previous frame; press edges derive against it. */
  prevMask: number;
  tx: number;
  ty: number;
  /** Cell indices (y * width + x) on the current map the player must never
   *  stand on or step into, except the goal itself. */
  avoid: ReadonlySet<number>;
  maxExpansions?: number;
}

export interface WalkPlan {
  /** One held mask per host frame. */
  masks: number[];
  /** The state after each mask, for the caller's replay check. */
  states: SessionState[];
}

interface Node {
  state: SessionState;
  mask: number;
  parent: Node | null;
  g: number;
  f: number;
  h: number;
  seq: number;
}

/** Terrain-only BFS distance (in tiles) from every cell to (tx,ty),
 *  entering no avoided cell other than the goal. */
function distanceField(table: PassageTable, tx: number, ty: number, avoid: ReadonlySet<number>): Int32Array {
  const W = table.width;
  const H = table.height;
  const dist = new Int32Array(W * H).fill(-1);
  const goal = ty * W + tx;
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (let dir = 0 as Dir4; dir < 4; dir = (dir + 1) as Dir4) {
      // A neighbour n reaches cur by stepping in the opposite direction.
      const nx = cx - DX[dir];
      const ny = cy - DY[dir];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] !== -1 || avoid.has(ni)) continue;
      if (!canStepFrom(table, nx, ny, dir)) continue;
      dist[ni] = dist[cur]! + 1;
      queue.push(ni);
    }
  }
  return dist;
}

function nodeKey(s: SessionState): string {
  return `${JSON.stringify(s.move)}|${s.sw.rng}|${JSON.stringify(s.chars)}`;
}

function heapPush(heap: Node[], n: Node): void {
  heap.push(n);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(heap[i]!, heap[p]!)) break;
    [heap[i], heap[p]] = [heap[p]!, heap[i]!];
    i = p;
  }
}

function heapPop(heap: Node[]): Node | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
      if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  }
  return top;
}

function less(a: Node, b: Node): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  return a.seq < b.seq;
}

/** Plan host-frame masks that bring the player to rest on (tx,ty). */
export function searchWalk(q: WalkSearch): WalkPlan {
  const { session: sess, state: start } = q;
  const table = sessionPassageTable(sess, start);
  const W = table.width;
  const goal = q.ty * W + q.tx;
  const dist = distanceField(table, q.tx, q.ty, q.avoid);
  const stepTicks = stepFrames(sess.cfg);
  const tpf = sess.ticksPerFrame;
  const maxExpansions = q.maxExpansions ?? 200_000;

  const at = (s: SessionState): boolean => !s.move.moving && s.move.tx === q.tx && s.move.ty === q.ty;
  if (at(start)) return { masks: [], states: [] };

  // Remaining reference ticks to the goal along terrain, or -1 when the
  // state cannot reach it without entering an avoided cell.
  const ticksLeft = (s: SessionState): number => {
    const m = s.move;
    if (m.moving) {
      const d = dist[(m.ty + DY[m.stepDir]) * W + (m.tx + DX[m.stepDir])]!;
      return d < 0 ? -1 : d * stepTicks + (stepTicks - m.phase);
    }
    const d = dist[m.ty * W + m.tx]!;
    return d < 0 ? -1 : d * stepTicks;
  };
  const cellOf = (s: SessionState): number => s.move.ty * W + s.move.tx;
  const destOf = (s: SessionState): number =>
    (s.move.ty + DY[s.move.stepDir]) * W + (s.move.tx + DX[s.move.stepDir]);

  let seq = 0;
  const h0 = ticksLeft(start);
  if (h0 < 0) throw new Error(`journey-search: (${q.tx},${q.ty}) unreachable from ${start.mapId}(${start.move.tx},${start.move.ty})`);
  const root: Node = { state: start, mask: q.prevMask, parent: null, g: 0, h: Math.ceil(h0 / tpf), f: Math.ceil(h0 / tpf), seq: seq++ };
  const heap: Node[] = [root];
  const seen = new Set<string>([nodeKey(start)]);
  let expansions = 0;

  while (heap.length > 0) {
    const node = heapPop(heap)!;
    if (++expansions > maxExpansions) break;
    for (const mask of CANDIDATES) {
      const pressed = mask & ~node.mask;
      const next = stepSession(sess, node.state, {
        buttons: mask,
        confirmEdge: false,
        cancelEdge: false,
        upEdge: !!(pressed & BTN_UP),
        downEdge: !!(pressed & BTN_DOWN),
      });
      if (next.mapId !== start.mapId) continue;
      // The goal may itself be a touch trigger (a lamp room that opens the
      // ending on entry): arriving there is success even though the fiber
      // it starts is already running when the frame ends.
      const arrived = at(next);
      if (!arrived && (next.interp.main !== null || next.fade || next.interp.error)) continue;
      const cell = cellOf(next);
      if (cell !== goal && q.avoid.has(cell)) continue;
      if (next.move.moving) {
        const dest = destOf(next);
        if (dest !== goal && q.avoid.has(dest)) continue;
      }
      const left = ticksLeft(next);
      if (left < 0) continue;
      const key = nodeKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      const h = Math.ceil(left / tpf);
      const child: Node = { state: next, mask, parent: node, g: node.g + 1, h, f: node.g + 1 + h, seq: seq++ };
      if (arrived) {
        const masks: number[] = [];
        const states: SessionState[] = [];
        for (let n: Node | null = child; n && n.parent; n = n.parent) {
          masks.push(n.mask);
          states.push(n.state);
        }
        return { masks: masks.reverse(), states: states.reverse() };
      }
      heapPush(heap, child);
    }
  }
  throw new Error(
    `journey-search: no plan to ${start.mapId}(${q.tx},${q.ty}) from (${start.move.tx},${start.move.ty}) ` +
      `at ${sess.hz} Hz (${expansions > maxExpansions ? `gave up after ${maxExpansions} expansions` : "search space exhausted"})`,
  );
}
