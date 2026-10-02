// tests/attract-tape.test.ts — attract tape source (src/host/
// attract-tape.ts): the built-in winning run is the default, and a valid
// attract-tape.json on a mounted data.fs replaces it; a missing, corrupt,
// or malformed override falls back to the built-in tape.

import { afterEach, describe, expect, test } from "bun:test";
import { createSimFsHost, type SimFsHost } from "../vendor/pocketjs/hosts/sim/fs.ts";
import { write } from "@pocketjs/framework/fs";
import { loadAttractTape as loadWithBuiltin } from "../src/host/attract-tape.ts";
import { expandTapeRuns } from "../src/engine/tape.ts";
import { DEMO_TAPE_FRAMES as BUILTIN_TAPE_FRAMES, DEMO_TAPE_RUNS } from "../examples/sunstone/demo-tape.ts";

const builtinAttractTape = (): number[] => expandTapeRuns(DEMO_TAPE_RUNS);
const loadAttractTape = () => loadWithBuiltin(DEMO_TAPE_RUNS);

const g = globalThis as { fs?: unknown };
let host: SimFsHost | null = null;

afterEach(() => {
  host?.dispose();
  host = null;
  g.fs = undefined;
});

describe("attract tape source", () => {
  test("the built-in tape is the 539-frame winning run without fs", () => {
    const { masks, external, worldTraversal } = loadAttractTape();
    expect(external).toBe(false);
    expect(worldTraversal).toBe("legacy-transfer");
    expect(masks).toHaveLength(BUILTIN_TAPE_FRAMES);
    expect(masks).toEqual(builtinAttractTape());
    // One u16 per frame, values inside the button-mask window.
    expect(masks.every((m) => Number.isInteger(m) && m >= 0 && m <= 0xffff)).toBe(true);
  });

  test("a valid fs override replaces the built-in tape", () => {
    host = createSimFsHost();
    g.fs = host.ns;
    // devtools tape shape: {v:1, frames, masks:[[mask,count],…]}.
    write("attract-tape.json", JSON.stringify({ v: 1, frames: 3, masks: [[0, 1], [0x0020, 1], [0, 1]] }));
    const { masks, external, worldTraversal } = loadAttractTape();
    expect(external).toBe(true);
    expect(worldTraversal).toBe("legacy-transfer");
    expect(masks).toEqual([0, 0x0020, 0]);
  });

  test("an explicit traversal identity survives loading", () => {
    host = createSimFsHost();
    g.fs = host.ns;
    write("attract-tape.json", JSON.stringify({
      v: 3,
      frames: 3,
      masks: [[0, 3]],
      worldTraversal: "seamless-v1",
    }));
    expect(loadAttractTape()).toMatchObject({
      masks: [0, 0, 0],
      external: true,
      worldTraversal: "seamless-v1",
    });
  });

  const bad: { name: string; body: string }[] = [
    { name: "not JSON", body: "{" },
    { name: "no tape version", body: JSON.stringify({ frames: 1, masks: [[0, 1]] }) },
    { name: "unsupported tape version", body: JSON.stringify({ v: 4, frames: 1, masks: [[0, 1]] }) },
    { name: "no masks", body: JSON.stringify({ v: 1 }) },
    { name: "masks not an array", body: JSON.stringify({ v: 1, frames: 1, masks: {} }) },
    { name: "a run with the wrong arity", body: JSON.stringify({ v: 1, frames: 1, masks: [[0]] }) },
    { name: "a mask outside u16", body: JSON.stringify({ v: 1, frames: 1, masks: [[0x10000, 1]] }) },
    { name: "a non-positive count", body: JSON.stringify({ v: 1, frames: 1, masks: [[0, 0]] }) },
    { name: "frames disagrees with the runs", body: JSON.stringify({ v: 1, frames: 2, masks: [[0, 3]] }) },
    { name: "an empty tape", body: JSON.stringify({ v: 1, frames: 0, masks: [] }) },
    { name: "an unknown traversal identity", body: JSON.stringify({ v: 3, frames: 1, masks: [[0, 1]], worldTraversal: "future" }) },
  ];
  for (const c of bad) {
    test(`a ${c.name} override falls back to the built-in tape`, () => {
      host = createSimFsHost();
      g.fs = host.ns;
      write("attract-tape.json", c.body);
      const { masks, external, worldTraversal } = loadAttractTape();
      expect(external).toBe(false);
      expect(worldTraversal).toBe("legacy-transfer");
      expect(masks).toEqual(builtinAttractTape());
    });
  }

  test("a missing file on a mounted fs also falls back", () => {
    host = createSimFsHost();
    g.fs = host.ns;
    const { masks, external } = loadAttractTape();
    expect(external).toBe(false);
    expect(masks).toHaveLength(BUILTIN_TAPE_FRAMES);
  });
});
