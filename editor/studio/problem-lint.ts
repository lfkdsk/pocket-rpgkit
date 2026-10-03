// editor/studio/problem-lint.ts — debounced, generation-checked scheduler for
// the async rpgkit-check lint. The lint is debounced and async, so a capture
// waits for lintIdle() before taking a documentation shot. The generation is
// taken at schedule() time, not when the debounce timer fires: an older run
// that resolves after a newer edit was scheduled must neither commit its
// stale results nor mark the lint idle before the newest run has rendered.

import type { StudioProblem } from "./problems.ts";

export interface LintSchedulerHooks<T> {
  /** The debounced async work (schema problems + rpgkit-check). */
  run: () => Promise<T[]>;
  /** Commit the latest run's results on the UI thread. */
  commit: (problems: T[]) => void;
  /** Debounce delay in ms (250 in the editor). */
  debounceMs?: number;
}

export class LintScheduler<T = StudioProblem> {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** True from schedule() until the latest scheduled run has committed, so a
   *  capture can wait for the problems count to stop changing. */
  pending = false;

  constructor(private readonly hooks: LintSchedulerHooks<T>) {}

  schedule(): void {
    // Take the new generation immediately: a run already in flight belongs
    // to the previous generation and must not commit or clear pending.
    this.generation++;
    this.pending = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => void this.fire(), this.hooks.debounceMs ?? 250);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    const generation = this.generation;
    const next = await this.hooks.run();
    // A newer edit scheduled its own run meanwhile; only the latest
    // generation may commit and clear pending.
    if (generation !== this.generation) return;
    this.pending = false;
    this.hooks.commit(next);
  }

  idle(): boolean {
    return !this.pending;
  }
}
