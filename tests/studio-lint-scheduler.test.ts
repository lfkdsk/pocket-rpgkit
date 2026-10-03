// The Studio lint scheduler's generation guard. The lint is debounced and
// async: a run that resolves after a newer edit was scheduled must neither
// commit its stale results nor mark the lint idle before the newest run has
// rendered (a capture waits on lintIdle for the --double gate).

import { describe, expect, test } from "bun:test";
import { LintScheduler } from "../editor/studio/problem-lint.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Studio lint scheduler", () => {
  test("a run resolving after a newer schedule neither commits nor clears pending", async () => {
    const committed: string[][] = [];
    const runs: Array<{ resolve: (problems: string[]) => void }> = [];
    const scheduler = new LintScheduler({
      debounceMs: 5,
      run: () => {
        const d = deferred<string[]>();
        runs.push(d);
        return d.promise;
      },
      commit: (problems) => committed.push(problems),
    });

    scheduler.schedule();
    expect(scheduler.idle()).toBe(false);
    await sleep(12); // first debounce fires, run A in flight
    expect(runs.length).toBe(1);

    // A newer edit schedules B while A is still awaiting its checks.
    scheduler.schedule();
    await sleep(12); // second debounce fires, run B in flight
    expect(runs.length).toBe(2);

    // The stale run resolves first: it must not commit or clear pending.
    runs[0]!.resolve(["stale"]);
    await sleep(2);
    expect(committed).toEqual([]);
    expect(scheduler.idle()).toBe(false);

    // The latest run commits and only then marks the lint idle.
    runs[1]!.resolve(["latest"]);
    await sleep(2);
    expect(committed).toEqual([["latest"]]);
    expect(scheduler.idle()).toBe(true);
  });

  test("a stale run resolving before the newer debounce fires neither commits nor reports idle", async () => {
    // The window between schedule() and the new debounce timer: if the
    // generation were taken when the timer fires, run A would still own the
    // latest generation here and commit its stale results.
    const committed: string[][] = [];
    const runs: Array<{ resolve: (problems: string[]) => void }> = [];
    const scheduler = new LintScheduler({
      debounceMs: 20,
      run: () => {
        const d = deferred<string[]>();
        runs.push(d);
        return d.promise;
      },
      commit: (problems) => committed.push(problems),
    });

    scheduler.schedule();
    await sleep(30); // A's debounce fires; run A in flight
    expect(runs.length).toBe(1);

    // A newer edit schedules B; A resolves before B's debounce fires.
    scheduler.schedule();
    runs[0]!.resolve(["stale"]);
    await sleep(2);
    expect(runs.length).toBe(1);
    expect(committed).toEqual([]);
    expect(scheduler.idle()).toBe(false);

    // B's debounce fires; only its run commits and clears pending.
    await sleep(30);
    expect(runs.length).toBe(2);
    runs[1]!.resolve(["latest"]);
    await sleep(2);
    expect(committed).toEqual([["latest"]]);
    expect(scheduler.idle()).toBe(true);
  });

  test("schedules inside one debounce window collapse to a single latest run", async () => {
    const runs: number[] = [];
    const scheduler = new LintScheduler({
      debounceMs: 20,
      run: async () => { runs.push(1); return []; },
      commit: () => {},
    });
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    await sleep(35);
    expect(runs).toEqual([1]);
    expect(scheduler.idle()).toBe(true);
  });

  test("each schedule takes a new generation even before the timer fires", async () => {
    const committed: number[] = [];
    const scheduler = new LintScheduler({
      debounceMs: 30,
      run: async () => [],
      commit: (next) => committed.push(next.length),
    });
    scheduler.schedule();
    await sleep(40); // run A commits
    expect(committed).toEqual([0]);
    scheduler.schedule();
    await sleep(40); // run B commits
    expect(committed).toEqual([0, 0]);
    expect(scheduler.idle()).toBe(true);
  });
});
