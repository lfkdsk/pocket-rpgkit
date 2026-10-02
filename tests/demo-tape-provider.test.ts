// Lazy chapter tapes: a provider is resolved on first selection, at most
// once, and shared by every chapter that names it. Booting the menu and
// listing the autoplay page must not resolve anything.

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import { createSessionSnapshot, type SaveSnapshot } from "../src/engine/save.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { chapterTape, chapterTapeFrames, loadDemoChapter, validateDemoOptions, validatedDemoRewind } from "../src/ui/demo/runtime.ts";
import { attractRewindOptions, type GameViewDemoHost, type GameViewDemoRuntime } from "../src/ui/demo-contract.ts";
import type { DemoChapter, DemoOptions, DemoRewindOptions } from "../src/ui/demo/types.ts";
import type { AttractRewindOptions } from "../src/engine/attract.ts";
import type { Project } from "../src/engine/types.ts";

const { project } = buildGame();

// The menu modules are TSX for PocketJS's Solid compiler, which bun test does
// not run. Its runtime logic needs no rendering here, so load them with a
// factory that refuses to build elements.
Bun.plugin({
  name: "demo-menu-without-jsx",
  setup(build) {
    build.onLoad({ filter: /src\/ui\/.*\.tsx$/ }, async ({ path }) => {
      const transpiler = new Bun.Transpiler({
        loader: "tsx",
        tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "__noJsx", jsxFragmentFactory: "__noJsx" } },
      });
      const code = transpiler.transformSync(await Bun.file(path).text());
      return {
        loader: "js",
        contents: `const __noJsx = () => { throw new Error("demo menu rendering is not part of this test"); };\n${code}`,
      };
    });
  },
});
const { createDemo } = await import("../src/ui/demo/demo.tsx");

function snapshotAt(map: "village" | "forest" | "cave", x: number, y: number): SaveSnapshot {
  const session = createSession(project, 60);
  const snapshot = createSessionSnapshot(session, startSession(project, session), 0);
  snapshot.map = map;
  snapshot.player = initialMovement(x, y, 2, { tile: 16, speed: 2 });
  return snapshot;
}

function mounted(): { attract: AttractController; host: GameViewDemoHost } {
  const attract = new AttractController(project, [], { hz: 60 });
  return {
    attract,
    host: { project, session: attract.getSession(), attract, getState: () => attract.state },
  };
}

/** One recorded tape shared by three chapters, as a game that keeps its
 *  whole mainline in the pak would declare it. */
function sharedTapeOptions(): { options: DemoOptions; calls: () => number; tape: Uint16Array } {
  const tape = new Uint16Array(30);
  for (let i = 0; i < tape.length; i++) tape[i] = i % 3 === 0 ? BTN.RIGHT : 0;
  let calls = 0;
  const provider = (): Uint16Array => { calls++; return tape; };
  const chapters: DemoChapter[] = [
    { id: "village", title: "Village", snapshot: snapshotAt("village", 9, 9), tape: provider, tapeFrames: 30 },
    { id: "forest", title: "Forest", snapshot: snapshotAt("forest", 10, 13), tape: provider, tapeStart: 10, tapeFrames: 20 },
    { id: "cave", title: "Cave", snapshot: snapshotAt("cave", 9, 11), tape: provider, tapeStart: 25 },
  ];
  return { options: { chapters, boot: null }, calls: () => calls, tape };
}

function withRuntime<T>(options: DemoOptions, body: (runtime: GameViewDemoRuntime, host: ReturnType<typeof mounted>) => T): T {
  return createRoot((dispose) => {
    try {
      const host = mounted();
      return body(createDemo(options).create(host.host), host);
    } finally {
      dispose();
    }
  });
}

function press(runtime: GameViewDemoRuntime, button: number): ReturnType<GameViewDemoRuntime["step"]> {
  return runtime.step(button, button);
}

describe("ui/demo lazy tape providers", () => {
  test("validation, runtime boot and the autoplay listing never call a provider", () => {
    const { options, calls } = sharedTapeOptions();
    validateDemoOptions(options);
    withRuntime(options, (runtime) => {
      expect(calls()).toBe(0);
      press(runtime, BTN.SELECT);
      expect(runtime.isOpen()).toBe(true);
      // chapters -> warp -> autoplay, then walk the rows twice over.
      press(runtime, BTN.RIGHT);
      press(runtime, BTN.RIGHT);
      for (let i = 0; i < 8; i++) press(runtime, BTN.DOWN);
      expect(calls()).toBe(0);
    });
  });

  test("a provider shared by several chapters is resolved once across selections", () => {
    const { options, calls, tape } = sharedTapeOptions();
    const [village, forest, cave] = options.chapters as DemoChapter[];

    const first = mounted();
    loadDemoChapter(first.host, forest!, true, 1);
    expect(calls()).toBe(1);
    expect(first.attract.status()).toMatchObject({ phase: "attract", demoFrame: 0 });
    loadDemoChapter(first.host, cave!, true, 1);
    loadDemoChapter(first.host, village!, false, 1);
    loadDemoChapter(first.host, forest!, true, 1);
    expect(calls()).toBe(1);

    // The windows are views onto the one decoded tape, not copies.
    const forestTape = chapterTape(forest!) as Uint16Array;
    const caveTape = chapterTape(cave!) as Uint16Array;
    expect(forestTape.buffer).toBe(tape.buffer);
    expect(caveTape.buffer).toBe(tape.buffer);
    expect([...forestTape]).toEqual([...tape.subarray(10, 30)]);
    expect([...caveTape]).toEqual([...tape.subarray(25)]);
    expect(chapterTape(village!)).toBe(tape);
    expect(calls()).toBe(1);

    // Autoplay consumes exactly the declared window.
    const auto = mounted();
    loadDemoChapter(auto.host, cave!, true, 4);
    auto.attract.step(0);
    expect(auto.attract.status().demoFrame).toBe(4);
    expect(calls()).toBe(1);
  });

  test("menu selection and the autoplay page share the one resolution", () => {
    const { options, calls } = sharedTapeOptions();
    withRuntime(options, (runtime, { attract }) => {
      press(runtime, BTN.SELECT);
      press(runtime, BTN.DOWN); // chapters: forest
      expect(press(runtime, BTN.CIRCLE).stateChanged).toBe(true);
      expect(attract.state.mapId).toBe("forest");
      expect(calls()).toBe(1);

      press(runtime, BTN.SELECT);
      press(runtime, BTN.RIGHT);
      // autoplay rows: speed, village, forest, cave. The cursor follows the
      // chapter just loaded (forest), so one step down is the cave.
      press(runtime, BTN.RIGHT);
      press(runtime, BTN.DOWN);
      expect(press(runtime, BTN.CIRCLE).stateChanged).toBe(true);
      expect(attract.state.mapId).toBe("cave");
      expect(attract.status().phase).toBe("attract");
      expect(calls()).toBe(1);
    });
  });

  test("a throwing provider shows a menu error, keeps the world, and is retried", () => {
    let calls = 0;
    let broken = true;
    const chapter: DemoChapter = {
      id: "forest",
      title: "Forest",
      snapshot: snapshotAt("forest", 10, 13),
      tape: () => {
        calls++;
        if (broken) throw new Error("pak entry missing");
        return [0, BTN.RIGHT];
      },
    };
    withRuntime({ chapters: [chapter], boot: null }, (runtime, { attract }) => {
      const before = attract.state;
      press(runtime, BTN.SELECT);
      expect(press(runtime, BTN.CIRCLE).stateChanged).toBe(false);
      expect(runtime.isOpen()).toBe(true);
      expect(attract.state).toBe(before);
      expect(calls).toBe(1);

      broken = false;
      press(runtime, BTN.CIRCLE); // dismiss the error
      expect(press(runtime, BTN.CIRCLE).stateChanged).toBe(true);
      expect(attract.state.mapId).toBe("forest");
      expect(calls).toBe(2);
      chapterTape(chapter);
      expect(calls).toBe(2);
    });
  });

  test("windows are validated and listed without resolving", () => {
    const tape = [0, 0, 0];
    const at = (fields: Partial<DemoChapter>): DemoOptions => ({
      chapters: [{ id: "a", title: "A", snapshot: snapshotAt("village", 9, 9), tape, ...fields }],
    });
    expect(() => validateDemoOptions(at({ tapeStart: 2, tapeFrames: 1 }))).not.toThrow();
    expect(() => validateDemoOptions(at({ tapeStart: 2, tapeFrames: 2 }))).toThrow("ends past the tape");
    expect(() => validateDemoOptions(at({ tapeStart: -1 }))).toThrow("tapeStart");
    expect(() => validateDemoOptions(at({ tapeFrames: 1.5 }))).toThrow("tapeFrames");

    let calls = 0;
    const provider = (): number[] => { calls++; return [1, 2, 3]; };
    expect(chapterTapeFrames({ id: "a", title: "A", snapshot: "", tape: provider })).toBeNull();
    expect(chapterTapeFrames({ id: "a", title: "A", snapshot: "", tape: provider, tapeFrames: 0 })).toBe(0);
    expect(chapterTapeFrames({ id: "a", title: "A", snapshot: "", tape, tapeStart: 1 })).toBe(2);
    expect(calls).toBe(0);
    expect(() => chapterTape({ id: "a", title: "A", snapshot: "", tape: provider, tapeStart: 2, tapeFrames: 5 }))
      .toThrow("ends past");
  });
});

describe("demo rewind options", () => {
  test("createDemo hands validated rewind limits to the GameView controller", () => {
    const rewind = { rewindSeconds: 5, keyframeIntervalFrames: 600, keyframeMaxBytes: 1 << 20, keyframeMaxCount: 16 };
    const config = createDemo({ chapters: [], boot: null, rewind });
    expect(config.rewind).toEqual(rewind);
    expect(config.rewind).not.toBe(rewind);
    expect(createDemo({ chapters: [], boot: null }).rewind).toBeUndefined();
    // GameView spreads config.rewind into its AttractController options.
    const attract = new AttractController(project, [], { hz: 60, ...config.rewind });
    expect(attract.keyframeStats()).toMatchObject({
      intervalFrames: 600,
      maxBytes: 1 << 20,
      maxCount: 16,
    });

    expect(() => validateDemoOptions({ chapters: [], rewind: { rewindSeconds: 0 } })).toThrow("positive number");
    expect(() => validateDemoOptions({ chapters: [], rewind: { keyframeMaxCount: -1 } }))
      .toThrow("rewind.keyframeMaxCount must be a non-negative safe integer");
    expect(() => validateDemoOptions({ chapters: [], rewind: { keyframeMaxBytes: 1.5 } }))
      .toThrow("rewind.keyframeMaxBytes");
    expect(() => validateDemoOptions({ chapters: [], rewind: { keyframeMaxBytes: 0, keyframeMaxCount: 0 } }))
      .not.toThrow();
  });

  test("rewind records reject arrays, null and unknown keys", () => {
    expect(() => validateDemoOptions({ chapters: [], rewind: [] as unknown as DemoRewindOptions }))
      .toThrow("rewind must be an object");
    expect(() => validateDemoOptions({ chapters: [], rewind: null as unknown as DemoRewindOptions }))
      .toThrow("rewind must be an object");
    // A structurally assignable record must not carry trusted AttractOptions.
    for (const smuggled of ["hz", "maps", "immutableState", "battle", "tapeHz", "scenes"]) {
      expect(
        () => validateDemoOptions({ chapters: [], rewind: { [smuggled]: 1 } as unknown as DemoRewindOptions }),
        `smuggled ${smuggled}`,
      ).toThrow(`rewind.${smuggled} is not a known rewind option`);
    }
    // The validator returns a clean record holding only the four fields.
    const clean = validatedDemoRewind({ rewindSeconds: 2, keyframeMaxCount: 8 });
    expect(Object.keys(clean!)).toEqual(["rewindSeconds", "keyframeMaxCount"]);
    expect(() => validatedDemoRewind({ rewindSeconds: 2, hz: 60 } as unknown as DemoRewindOptions))
      .toThrow("rewind.hz is not a known rewind option");
  });

  test("createDemo refuses a rewind record with smuggled trusted options", () => {
    const poisoned = { rewindSeconds: 2, hz: 60, maps: {}, immutableState: true } as unknown as DemoRewindOptions;
    expect(() => createDemo({ chapters: [], boot: null, rewind: poisoned }))
      .toThrow("rewind.hz is not a known rewind option");
    const config = createDemo({ chapters: [], boot: null, rewind: { rewindSeconds: 2, keyframeMaxCount: 8 } });
    expect(Object.keys(config.rewind!)).toEqual(["rewindSeconds", "keyframeMaxCount"]);
  });

  test("GameView forwarding drops smuggled keys and keeps the host hz", () => {
    // A hand-built GameViewDemoConfig bypasses validateDemoOptions; the
    // forwarding GameView uses must still strip keys that would overwrite
    // its trusted hz/maps/extensions/battle/scene/immutableState settings.
    const smuggled = {
      rewindSeconds: 1,
      hz: 60,
      maps: {},
      immutableState: true,
      battle: {},
    } as unknown as AttractRewindOptions;
    const forwarded = attractRewindOptions(smuggled);
    expect(Object.keys(forwarded!)).toEqual(["rewindSeconds"]);
    expect(forwarded).toEqual({ rewindSeconds: 1 });

    // The controller keeps the host hz: at hz 1 one host step folds the
    // whole 60 Hz second. A smuggled hz: 60 would fold a single frame.
    const minimal: Project = {
      format: "rpgkit-project/v1",
      title: "rewind forwarding fixture",
      tileSize: 16,
      start: { map: "a", x: 3, y: 3, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      maps: [{
        id: "a",
        name: "a",
        width: 8,
        height: 8,
        sheets: ["plain"],
        ground: new Array(64).fill("plain.0"),
      }],
    };
    const controller = new AttractController(minimal, new Array(120).fill(0), {
      hz: 1,
      tapeHz: 60,
      ...attractRewindOptions(smuggled),
    });
    controller.startAttract();
    expect(controller.status().demoFrame).toBe(0);
    controller.step(0);
    expect(controller.status().demoFrame).toBe(60);
    controller.step(0);
    expect(controller.status().demoFrame).toBe(120);
  });
});
