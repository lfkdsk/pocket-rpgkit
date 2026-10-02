// Sparse per-seed timeline for the growth demo. One owned reducer state
// materializes history and each record keeps only metadata plus changed cells.
// Seeking moves one reusable grid cursor forward or backward through those
// edits, so no seek copies the 4096 x 33 backing layers.

import {
  cloneGrowState, createGrow, growGridEdits, growGridHash, growStateHash,
  rememberGrowGridHash, stepGrowTickOwned,
  type GrowGridEdit, type GrowParams, type GrowState,
} from "./grow.ts";

export interface GrowTimelineStats {
  seed: number;
  states: number;
  stepCalls: number;
  seeks: number;
  checkpointInterval: number;
}

const CHECKPOINT_INTERVAL = 32;

interface StateRecord {
  state: GrowState;
  edits: readonly GrowGridEdit[];
  gridHash: number;
}

export interface GrowTimelineSnapshot {
  tick: number;
  state: GrowState;
  edits: readonly GrowGridEdit[];
  gridHash: number;
}

function canonical(state: GrowState): GrowState {
  return state.frame === 0 && state.hz === 0 && state.cameraX === state.cameraFromX
    ? state
    : { ...state, frame: 0, hz: 0, cameraX: state.cameraFromX };
}

function editGrid(state: GrowState, edit: GrowGridEdit, value: number): void {
  const grid = edit.layer === "ground" ? state.ground : edit.layer === "upper" ? state.upper : edit.layer === "road" ? state.road : state.wear!;
  grid[edit.index] = value;
}

export class GrowTimeline {
  readonly params: GrowParams;
  readonly #records: StateRecord[] = [];
  readonly #checkpointTicks = new Set<number>();
  readonly #hashes = new WeakMap<GrowState, string>();
  #builder: GrowState;
  #cursor: GrowState | undefined;
  #marks: Uint16Array | undefined;
  #markEpoch = 0;
  #stepCalls = 0;
  #seeks = 0;

  constructor(params: GrowParams, initial: GrowState = createGrow(params)) {
    const start = canonical(initial);
    this.params = start.params;
    const gridHash = growGridHash(start);
    this.#records.push({ state: start, edits: [], gridHash });
    this.#checkpointTicks.add(0);
    // The builder owns its buffers and mutates them while recording edits.
    // The live UI keeps the initial buffers until it chooses to scrub.
    this.#builder = cloneGrowState(start);
  }

  get seed(): number { return this.params.seed; }
  get furthestTick(): number { return this.#builder.tick; }
  get complete(): boolean { return this.#builder.phase === "done"; }
  /** Rightmost developed column recorded so far. */
  get frontierX(): number { return Math.max(this.#builder.frontierX, this.#builder.roadFrontierX); }

  #append(): void {
    const next = canonical(stepGrowTickOwned(this.#builder));
    if (next.tick !== this.#records.length) return;
    const edits = growGridEdits(next);
    this.#records.push({ state: next, edits, gridHash: growGridHash(next) });
    if (next.tick % CHECKPOINT_INTERVAL === 0 || next.phase === "done") {
      this.#checkpointTicks.add(next.tick);
    }
    this.#builder = next;
  }

  #materializeTo(tick: number): void {
    while (this.#builder.tick < tick && this.#builder.phase !== "done") {
      this.#append();
      this.#stepCalls++;
    }
  }

  #moveCursor(target: number, reusable?: GrowState): GrowState {
    if (reusable && reusable.params.seed === this.seed && reusable.tick < this.#records.length) {
      this.#cursor = reusable;
    }
    if (!this.#cursor) this.#cursor = cloneGrowState(this.#records[0]!.state);

    const grids = this.#cursor;
    if (grids.tick < target) {
      for (let tick = grids.tick + 1; tick <= target; tick++) {
        for (const edit of this.#records[tick]!.edits) editGrid(grids, edit, edit.after);
      }
    } else if (grids.tick > target) {
      for (let tick = grids.tick; tick > target; tick--) {
        const edits = this.#records[tick]!.edits;
        for (let i = edits.length - 1; i >= 0; i--) editGrid(grids, edits[i]!, edits[i]!.before);
      }
    }

    const record = this.#records[target]!;
    const result: GrowState = { ...record.state, ground: grids.ground, upper: grids.upper, road: grids.road };
    if (grids.wear) result.wear = grids.wear;
    rememberGrowGridHash(result, record.gridHash);
    this.#cursor = result;
    return result;
  }

  /**
   * Return the exact reducer state at k, clamped to the terminal state.
   * A caller that no longer needs its current state may pass it as `reusable`
   * to make that state's typed arrays the seek cursor without an allocation;
   * the passed state is then owned by the timeline and must not be kept.
   * Without `reusable` the returned grids are copies, so a later seek cannot
   * rewrite a state the caller is still holding.
   */
  at(tick: number, reusable?: GrowState): GrowState {
    this.#seeks++;
    const requested = Math.max(0, Math.round(tick));
    this.#materializeTo(requested);
    const k = Math.min(requested, this.#builder.tick);
    if (reusable) return this.#moveCursor(k, reusable);
    const result = this.#moveCursor(k);
    return {
      ...result,
      ground: result.ground.slice(), upper: result.upper.slice(), road: result.road.slice(),
      ...(result.wear ? { wear: result.wear.slice() } : {}),
    };
  }

  /** Extend recorded history through a bounded target without moving a cursor. */
  prefillTo(tick: number): number {
    this.#materializeTo(Math.max(0, Math.round(tick)));
    return this.#builder.tick;
  }

  /**
   * Metadata and cell edits for an already materialized tick. The returned
   * state's grids are reconstructed for that tick and then copied, so a
   * later seek or a continued recording cannot rewrite a snapshot the
   * caller is still holding. Callers that only need the edits and metadata
   * (not the grids) should use `frame` to avoid the reconstruction.
   */
  snapshot(tick: number): GrowTimelineSnapshot | undefined {
    const record = this.#records[Math.max(0, Math.round(tick))];
    if (!record) return undefined;
    const at = this.#moveCursor(record.state.tick);
    const state: GrowState = {
      ...record.state,
      ground: at.ground.slice(), upper: at.upper.slice(), road: at.road.slice(),
    };
    if (at.wear) state.wear = at.wear.slice();
    return { tick: record.state.tick, state, edits: record.edits, gridHash: record.gridHash };
  }

  /**
   * Edits and metadata for a materialized tick, without reconstructing its
   * grids: `state.ground` and friends are the live builder buffers and must
   * not be read or kept. For the hot path that applies edits to its own grids.
   */
  frame(tick: number): { state: GrowState; edits: readonly GrowGridEdit[]; gridHash: number } | undefined {
    const record = this.#records[Math.max(0, Math.round(tick))];
    return record ? { state: record.state, edits: record.edits, gridHash: record.gridHash } : undefined;
  }

  /**
   * Fill `out` with every cell index whose `layers` changed on the way from
   * tick `from` to tick `to` (either direction), each index once. Returns
   * false, leaving `out` empty, when that span is not materialized yet.
   */
  changedCells(from: number, to: number, layers: "ground" | "ground+upper", out: number[]): boolean {
    out.length = 0;
    const first = Math.max(0, Math.min(from, to)) + 1;
    const last = Math.max(from, to);
    if (last >= this.#records.length) return false;
    const size = this.params.width * this.params.height;
    if (!this.#marks || this.#marks.length !== size) this.#marks = new Uint16Array(size);
    const marks = this.#marks;
    // One mark generation per call; wrapping restarts from a cleared array.
    if (++this.#markEpoch === 0x1_0000) { marks.fill(0); this.#markEpoch = 1; }
    const epoch = this.#markEpoch;
    const groundOnly = layers === "ground";
    for (let tick = first; tick <= last; tick++) {
      const edits = this.#records[tick]!.edits;
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!;
        if (edit.layer === "road" || edit.layer === "wear" || (groundOnly && edit.layer !== "ground")) continue;
        if (marks[edit.index] === epoch) continue;
        marks[edit.index] = epoch;
        out.push(edit.index);
      }
    }
    return true;
  }

  /** Materialize history and return its terminal tick without moving a cursor. */
  finish(): number {
    while (this.#builder.phase !== "done") {
      this.#append();
      this.#stepCalls++;
    }
    return this.#builder.tick;
  }

  done(): GrowState {
    return this.at(this.finish());
  }

  hash(state: GrowState): string {
    const cached = this.#hashes.get(state);
    if (cached !== undefined) return cached;
    const hash = growStateHash(state);
    this.#hashes.set(state, hash);
    return hash;
  }

  stats(): GrowTimelineStats {
    return {
      seed: this.params.seed,
      states: this.#checkpointTicks.size,
      stepCalls: this.#stepCalls,
      seeks: this.#seeks,
      checkpointInterval: CHECKPOINT_INTERVAL,
    };
  }
}
