// Saves keep the current map's runtime outside the interpreter: the
// character table (cells, facing, step interpolation, running and patrol
// routes with their progress, path searches in flight, the wander RNG), the
// player's forced route and a transfer fade-in. A save taken anywhere a
// scripted scene leaves characters mid-route must resume frame-for-frame
// like the run that never saved, at every host rate. Saves written before
// the map runtime was recorded still load and rebuild the characters from
// the map, as they always did.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SaveError,
  SAVE_CODE_COMPRESSED_PREFIX,
  SAVE_CODE_MAX_BYTES,
  SAVE_MAX_DEPTH,
  canSave,
  canonicalJson,
  createSessionSnapshot,
  decodeEnvelopeText,
  decodeSaveCode,
  encodeEnvelope,
  encodeSaveCode,
  type SaveSnapshot,
} from "../src/engine/save.ts";
import { loadSession, restoreSessionSnapshot, saveSession } from "../src/engine/save-restore.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { deflateRaw } from "../src/engine/deflate.ts";
import type { JsonValue } from "../src/engine/types.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Project } from "../src/engine/types.ts";
import { scriptedProject } from "./fixtures/ks2-save/project.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";

const BTN = { UP: 0x0010, RIGHT: 0x0020, DOWN: 0x0040, LEFT: 0x0080 } as const;

/** One u16 mask per 60 Hz source frame: the player walks around while the
 *  scene plays. */
function sourceTape(frames: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    const phase = Math.floor(f / 90) % 6;
    out.push(phase === 1 ? BTN.RIGHT : phase === 3 ? BTN.DOWN : phase === 4 ? BTN.LEFT : 0);
  }
  return out;
}

/** Host frames see every (60/hz)th source mask. */
function hostTape(source: readonly number[], hz: number): number[] {
  const stride = 60 / hz;
  const out: number[] = [];
  for (let f = 0; f < source.length; f += stride) out.push(source[f]!);
  return out;
}

/** Everything that decides the next frame. Typed path-search buffers print
 *  as index-keyed objects on both sides. SessionState.frame is left out: it
 *  counts host frames for the audio driver's refold check, no reducer reads
 *  it, and a restore derives it from the interpreter clock as before. */
function frameKey(state: SessionState): string {
  return canonicalJson({
    map: state.mapId,
    move: state.move,
    chars: state.chars,
    interp: state.interp,
    fade: state.fade,
    playerRoute: state.playerRoute,
    ext: state.ext,
  });
}

interface Run {
  session: Session;
  states: SessionState[];
  masks: number[];
}

function play(project: Project, hz: number, masks: readonly number[]): Run {
  const session = createSession(project, hz);
  let state = startSession(project, session);
  const states = [state];
  for (const buttons of masks) {
    state = stepSession(session, state, { buttons });
    states.push(state);
  }
  return { session, states, masks: [...masks] };
}

interface SavePoint {
  frame: number;
  kinds: Set<string>;
}

function kindsAt(state: SessionState): Set<string> {
  const kinds = new Set<string>();
  for (const ch of Object.values(state.chars.chars)) {
    if (ch.route && !ch.route.patrol) kinds.add("scripted route");
    if (ch.route?.waiter) kinds.add("waited route");
    if (ch.route?.plan?.search) kinds.add("path search in flight");
    if (ch.moving) kinds.add("character mid-step");
    if (ch.thinkIn > 0) kinds.add("wander timer");
  }
  if (state.playerRoute) kinds.add("player route");
  if (state.fade) kinds.add("fade-in");
  if (state.mapId === "yard") kinds.add("second map");
  return kinds;
}

/** Save points worth resuming from: the first safe frame showing each
 *  runtime feature, plus evenly spaced ones. */
function pickSavePoints(run: Run): SavePoint[] {
  const picked = new Map<number, SavePoint>();
  const seen = new Set<string>();
  let lastSpaced = -Infinity;
  for (let f = 1; f < run.states.length - 1; f++) {
    const state = run.states[f]!;
    if (!canSave(state.move, state.interp, state.scene)) continue;
    const kinds = kindsAt(state);
    const fresh = [...kinds].some((kind) => !seen.has(kind));
    if (fresh || f - lastSpaced >= Math.floor(run.states.length / 6)) {
      for (const kind of kinds) seen.add(kind);
      picked.set(f, { frame: f, kinds });
      if (!fresh) lastSpaced = f;
    }
  }
  return [...picked.values()];
}

/** Save at `point` through a compressed code, load it into a fresh session
 *  and fold the remaining masks. Returns the first diverging frame, or -1. */
function resumeFrom(project: Project, hz: number, run: Run, point: number, strip = false): number {
  const snapshot = createSessionSnapshot(run.session, run.states[point]!, run.masks[point - 1] ?? 0);
  if (strip) delete snapshot.mapRuntime;
  const session = createSession(project, hz);
  const loaded = loadSession(session, encodeSaveCode(snapshot));
  // Without its route a parallel fiber parked on a waited route cannot
  // resume, so such a save is refused outright.
  if (!loaded.ok && strip && loaded.error.code === "shape") return point;
  if (!loaded.ok) throw new Error(`load failed: ${loaded.error.code} ${loaded.error.message}`);
  let state = loaded.state;
  if (frameKey(state) !== frameKey(run.states[point]!)) return point;
  for (let f = point; f < run.masks.length; f++) {
    state = stepSession(session, state, { buttons: run.masks[f]! });
    if (frameKey(state) !== frameKey(run.states[f + 1]!)) return f + 1;
  }
  return -1;
}

const SOURCE_FRAMES = 1_440;

describe("KS2 saves keep the current map's characters", () => {
  const project = scriptedProject();

  for (const hz of [60, 30, 20]) {
    test(`a save anywhere in a scripted scene resumes frame-for-frame at ${hz} Hz`, () => {
      const run = play(project, hz, hostTape(sourceTape(SOURCE_FRAMES), hz));
      const last = run.states.at(-1)!;
      // The scene ran to its end: two loops and the faded transfer.
      expect(last.mapId).toBe("yard");
      const points = pickSavePoints(run);
      const covered = new Set(points.flatMap((p) => [...p.kinds]));
      for (const kind of [
        "scripted route",
        "waited route",
        "path search in flight",
        "character mid-step",
        "wander timer",
        "player route",
        "fade-in",
        "second map",
      ]) {
        expect(covered.has(kind), `no save point with ${kind} at ${hz} Hz`).toBe(true);
      }
      for (const point of points) {
        expect(resumeFrom(project, hz, run, point.frame), `save at host frame ${point.frame}`).toBe(-1);
      }
    });
  }

  test("without the map runtime the same saves diverge (the test can tell)", () => {
    const hz = 60;
    const run = play(project, hz, hostTape(sourceTape(SOURCE_FRAMES), hz));
    const points = pickSavePoints(run).filter((p) => p.kinds.has("waited route") || p.kinds.has("player route"));
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(resumeFrom(project, hz, run, point.frame, true)).toBeGreaterThanOrEqual(0);
    }
  });

  test("a waited route resumes its parallel fiber after a load", () => {
    const hz = 60;
    const run = play(project, hz, hostTape(sourceTape(SOURCE_FRAMES), hz));
    const point = pickSavePoints(run).find((p) => p.kinds.has("waited route"))!;
    const state = run.states[point.frame]!;
    const courier = state.chars.chars.courier!;
    expect(courier.route?.waiter).toBe("plaza/director");
    expect(state.interp.parallels["plaza/director"]?.mode).toBe("external");
    const snapshot = createSessionSnapshot(run.session, state, 0);
    expect(snapshot.mapRuntime!.chars.chars.courier!.route!.waiter).toBe("plaza/director");
    // Search buffers are plain arrays in the save and typed arrays again
    // once restored.
    const search = snapshot.mapRuntime!.chars.chars.courier!.route!.plan?.search;
    if (search) expect(Array.isArray(search.parent)).toBe(true);
    const restored = restoreSessionSnapshot(createSession(project, hz), decodeEnvelopeText(encodeEnvelope(snapshot)));
    const revived = restored.chars.chars.courier!.route!.plan?.search;
    if (revived) expect(revived.parent).toBeInstanceOf(Int32Array);
  });
});

describe("KS2 saves without the map runtime", () => {
  test("a pre-change save envelope still loads and rebuilds characters from the map", () => {
    const project = scriptedProject();
    const run = play(project, 60, hostTape(sourceTape(400), 60));
    const frame = pickSavePoints(run).find((p) => p.kinds.has("scripted route"))!.frame;
    const snapshot = createSessionSnapshot(run.session, run.states[frame]!, 0);
    delete snapshot.mapRuntime;
    // encodeEnvelope over a snapshot without the field writes exactly the
    // bytes an older runtime wrote: same keys, same checksum input.
    const legacy = encodeEnvelope(snapshot);
    expect(legacy).not.toContain("mapRuntime");
    const session = createSession(project, 60);
    const loaded = loadSession(session, legacy);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.snapshot.mapRuntime).toBeUndefined();
    expect(Object.keys(loaded.state.chars.chars)).toEqual([]);
    expect(loaded.state.playerRoute).toBeNull();
    const next = stepSession(session, loaded.state, { buttons: 0 });
    // The authored cells, as before this change.
    expect(next.chars.chars.guard).toMatchObject({ tx: 6, ty: 6 });
    expect(next.chars.chars.courier).toMatchObject({ tx: 3, ty: 4 });
  });

  test("the plain chapter codes Sunstone shipped before still load", () => {
    const legacy = JSON.parse(readFileSync(new URL("./fixtures/ks2-save/sunstone-legacy-codes.json", import.meta.url), "utf8")) as Record<string, string>;
    const { project } = buildGame();
    for (const [id, code] of Object.entries(legacy)) {
      expect(code.startsWith("e"), id).toBe(true);
      const session = createSession(project, 60);
      const loaded = loadSession(session, code);
      expect(loaded.ok, id).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.snapshot.mapRuntime, id).toBeUndefined();
      // Re-encoding the decoded snapshot reproduces the shipped bytes: no
      // field was added on the way in.
      expect(encodeSaveCode(loaded.snapshot, null, { compress: false }), id).toBe(code);
    }
  });
});

describe("KS2 compressed save codes", () => {
  const project = scriptedProject();
  const run = play(project, 60, hostTape(sourceTape(SOURCE_FRAMES), 60));
  const points = pickSavePoints(run);
  const rich = points.find((p) => p.kinds.has("path search in flight")) ?? points[0]!;
  const snapshot = createSessionSnapshot(run.session, run.states[rich.frame]!, 0);

  test("round-trip both encodings to the same snapshot", () => {
    const compressed = encodeSaveCode(snapshot);
    const plain = encodeSaveCode(snapshot, null, { compress: false });
    expect(compressed.startsWith(SAVE_CODE_COMPRESSED_PREFIX)).toBe(true);
    expect(compressed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(compressed.length).toBeLessThan(plain.length / 3);
    const a = decodeSaveCode(compressed);
    const b = decodeSaveCode(plain);
    expect(canonicalJson(a)).toBe(canonicalJson(snapshot));
    expect(canonicalJson(b)).toBe(canonicalJson(snapshot));
    expect(encodeSaveCode(a)).toBe(compressed);
    // Hand-pasted line breaks are ignored.
    expect(canonicalJson(decodeSaveCode(compressed.match(/.{1,20}/g)!.join("\n ")))).toBe(canonicalJson(snapshot));
  });

  test("damaged, truncated and future codes are refused with a typed error", () => {
    const compressed = encodeSaveCode(snapshot);
    const codeOf = (input: string): string => {
      try {
        decodeSaveCode(input);
      } catch (error) {
        expect(error).toBeInstanceOf(SaveError);
        return (error as SaveError).code;
      }
      return "accepted";
    };
    for (const cut of [3, 10, Math.floor(compressed.length / 2), compressed.length - 2]) {
      expect(["bad-json", "checksum", "shape"]).toContain(codeOf(compressed.slice(0, cut)));
    }
    for (let i = 4; i < compressed.length; i += Math.max(1, Math.floor(compressed.length / 40))) {
      const flipped = compressed.slice(0, i) + (compressed[i] === "A" ? "B" : "A") + compressed.slice(i + 1);
      expect(["bad-json", "checksum", "shape"]).toContain(codeOf(flipped));
    }
    expect(codeOf("z2" + compressed.slice(2))).toBe("version");
    expect(codeOf("z1")).toBe("bad-json");
    expect(codeOf("z1$$$$")).toBe("bad-json");
  });

  test("a large state compresses several-fold", () => {
    // Stand-in for a large imported game: hundreds of story variables and
    // self switches, a long party list in extension state.
    const big = createSessionSnapshot(run.session, run.states[rich.frame]!, 0);
    for (let i = 0; i < 600; i++) big.interp.sw.variables[`story.npc_${i % 97}.talked_${i}`] = i % 7;
    for (let i = 0; i < 300; i++) big.interp.sw.self[`plaza/npc_${i}`] = "A";
    big.ext = {
      party: Array.from({ length: 30 }, (_, i) => ({
        slug: `monster_${i % 11}`,
        level: 5 + i,
        moves: ["tackle", "growl", "ember", "bubble"].slice(0, 1 + (i % 4)),
        stats: { hp: 20 + i, attack: 10 + (i % 5), defense: 8, speed: 9 },
      })),
    };
    expect(validateSnapshot(big)).toBeNull();
    const plain = encodeSaveCode(big, null, { compress: false });
    const compressed = encodeSaveCode(big);
    expect(compressed.length * 4).toBeLessThan(plain.length);
    expect(canonicalJson(decodeSaveCode(compressed))).toBe(canonicalJson(big));
  });
});

describe("KS2 structured save/load", () => {
  const project = scriptedProject();

  test("saving off a safe point says so instead of throwing", () => {
    const run = play(project, 60, hostTape(sourceTape(200), 60));
    const busy = run.states.find((s) => !canSave(s.move, s.interp, s.scene))!;
    const result = saveSession(run.session, busy, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not-safe-point");
    const safe = run.states.find((s) => canSave(s.move, s.interp, s.scene))!;
    expect(saveSession(run.session, safe, 0).ok).toBe(true);
  });

  test("bad saves, other builds and unknown maps return codes and change nothing", () => {
    const session = createSession(project, 60);
    const state = startSession(project, session);
    const snapshot = createSessionSnapshot(session, state, 0);
    const code = encodeSaveCode(snapshot);
    const errorOf = (input: SaveSnapshot | string, s: Session = session): string => {
      const result = loadSession(s, input);
      return result.ok ? "ok" : result.error.code;
    };
    expect(errorOf(code)).toBe("ok");
    expect(errorOf(encodeEnvelope(snapshot))).toBe("ok");
    expect(errorOf(snapshot)).toBe("ok");
    expect(errorOf("")).toBe("bad-json");
    expect(errorOf("{not json")).toBe("bad-json");
    expect(errorOf(encodeEnvelope(snapshot).replace("rpgkit-save/v1", "other/v1"))).toBe("format");
    expect(errorOf(encodeEnvelope(snapshot).replace("\"version\":1", "\"version\":9"))).toBe("version");
    expect(errorOf(encodeEnvelope(snapshot).replace(/"checksum":"[0-9a-f]+"/, "\"checksum\":\"00000000\""))).toBe("checksum");
    // A save for a map this build does not have.
    const elsewhere = { ...snapshot, map: "nowhere" };
    expect(errorOf(encodeSaveCode(elsewhere))).toBe("shape");
    // A character table naming an event the map does not own.
    const run = play(project, 60, hostTape(sourceTape(120), 60));
    const walking = run.states.find((s) => s.chars.chars.guard?.route && canSave(s.move, s.interp, s.scene))!;
    const ghost = createSessionSnapshot(run.session, walking, 0);
    const chars = ghost.mapRuntime!.chars.chars;
    chars.ghost = { ...chars.guard!, id: "ghost" };
    expect(errorOf(encodeSaveCode(ghost))).toBe("shape");
    // A content build mismatch.
    const sharded = createSession(project, 60);
    sharded.content = { manifest: "a".repeat(64), schema: "b".repeat(64) };
    expect(errorOf(code, sharded)).toBe("content");
  });

  test("a crafted path search cannot loop the backtrack", () => {
    const run = play(project, 60, hostTape(sourceTape(SOURCE_FRAMES), 60));
    const point = pickSavePoints(run).find((p) => p.kinds.has("path search in flight"))!;
    const snapshot = createSessionSnapshot(run.session, run.states[point.frame]!, 0);
    expect(validateSnapshot(snapshot)).toBeNull();
    const id = Object.keys(snapshot.mapRuntime!.chars.chars).find(
      (key) => snapshot.mapRuntime!.chars.chars[key]!.route?.plan?.search,
    )!;
    const search = snapshot.mapRuntime!.chars.chars[id]!.route!.plan!.search! as unknown as {
      parent: number[];
      queue: number[];
      qt: number;
    };
    const W = (search as unknown as { W: number }).W;
    const original = [...search.parent];
    // Point the second queued cell's parent at the third: a cycle.
    const second = search.queue[1]!;
    const third = search.queue[2]!;
    search.parent[second] = (third << 2) | 0;
    expect(validateSnapshot(snapshot)).toMatch(/parent must be an adjacent cell queued earlier/);
    // A correctly encoded but later-queued neighbour is refused too: find a
    // queued cell with a neighbour queued after it and swap the parent link.
    search.parent.splice(0, search.parent.length, ...original);
    const position = new Map(search.queue.slice(0, search.qt).map((cell, k) => [cell, k]));
    let crafted = false;
    for (let k = 1; k < search.qt && !crafted; k++) {
      const cell = search.queue[k]!;
      const moves: [number, number][] = [[cell - W, 0], [cell + 1, 1], [cell + W, 2], [cell - 1, 3]];
      for (const [from, dir] of moves) {
        const at = position.get(from);
        const sameRow = dir === 0 || dir === 2 || Math.floor(from / W) === Math.floor(cell / W);
        if (at !== undefined && at > k && sameRow) {
          search.parent[cell] = (from << 2) | dir;
          crafted = true;
          break;
        }
      }
    }
    expect(crafted).toBe(true);
    expect(validateSnapshot(snapshot)).toMatch(/parent must be an adjacent cell queued earlier/);
  });
});

describe("KS2 character motion in a save must be self-consistent", () => {
  const { project } = buildGame();
  // Sunstone's village (20x13) a few frames in, characters spawned.
  const villageSnapshot = (): SaveSnapshot => {
    const session = createSession(project, 60);
    let state = startSession(project, session);
    for (let i = 0; i < 3; i++) state = stepSession(session, state, { buttons: 0 });
    expect(state.mapId).toBe("village");
    return createSessionSnapshot(session, state, 0);
  };
  type Motion = Partial<Pick<NonNullable<SaveSnapshot["mapRuntime"]>["chars"]["chars"][string],
    "tx" | "ty" | "px" | "py" | "phase" | "moving" | "stepDir">>;
  const withMotion = (motion: Motion, id = "ambient-music"): SaveSnapshot => {
    const snapshot = villageSnapshot();
    Object.assign(snapshot.mapRuntime!.chars.chars[id]!, motion);
    return snapshot;
  };
  const load = (snapshot: SaveSnapshot) => loadSession(createSession(project, 60), encodeSaveCode(snapshot));
  const refusal = (snapshot: SaveSnapshot): string => {
    const loaded = load(snapshot);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return "";
    expect(loaded.error.code).toBe("shape");
    return loaded.error.message;
  };

  test("a step in flight off the map edge is refused instead of walking out", () => {
    // Checksum-valid and well-typed: east-edge cell, one tick into a step
    // east. Loaded, the next tick put the character on (20,1).
    const edge = withMotion({ tx: 19, ty: 1, px: 19 * 16 + 2, py: 16, phase: 1, moving: true, stepDir: 3 });
    expect(validateSnapshot(edge)).toBeNull(); // in bounds is a map question
    expect(refusal(edge)).toMatch(/step target \(20,1\) is outside village/);
    // The same step one cell further in loads and lands on the edge cell.
    const inside = withMotion({ tx: 18, ty: 1, px: 18 * 16 + 2, py: 16, phase: 1, moving: true, stepDir: 3 });
    const session = createSession(project, 60);
    const loaded = loadSession(session, encodeSaveCode(inside));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    let next = loaded.state;
    for (let i = 0; i < 7; i++) next = stepSession(session, next, { buttons: 0 });
    expect(next.chars.chars["ambient-music"]).toMatchObject({ tx: 19, ty: 1, px: 19 * 16, moving: false });
    // A step west from column 0 is refused without the map.
    const west = withMotion({ tx: 0, ty: 1, px: -2, py: 16, phase: 1, moving: true, stepDir: 1 });
    expect(validateSnapshot(west)).toMatch(/non-negative coordinates/);
  });

  test("pixel position, phase and moving must agree", () => {
    const cases: [string, Motion, RegExp][] = [
      ["pixel far off its tile", { px: 1e300 }, /at rest must sit on its tile origin/],
      ["at rest with a step phase", { phase: 3 }, /at rest must have phase 0/],
      ["moving with phase 0", { moving: true, phase: 0, px: 2 }, /needs phase >= 1/],
      ["moving across the step axis", { tx: 5, ty: 5, moving: true, stepDir: 3, phase: 1, px: 82, py: 81 },
        /between its tile and the stepDir neighbour/],
      ["moving the wrong way", { tx: 5, ty: 5, moving: true, stepDir: 3, phase: 1, px: 78, py: 80 },
        /between its tile and the stepDir neighbour/],
      ["moving past the target", { tx: 5, ty: 5, moving: true, stepDir: 0, phase: 4, px: 80, py: 96 },
        /between its tile and the stepDir neighbour/],
      // 5 px in one tick is no speed the tile divides into: the next tick
      // would throw inside the step loop.
      ["speed the tile cannot divide", { tx: 5, ty: 5, moving: true, stepDir: 0, phase: 1, px: 80, py: 85 },
        /a step the runtime can finish/],
    ];
    for (const [name, motion, reason] of cases) {
      const snapshot = withMotion(motion);
      expect(validateSnapshot(snapshot), name).toMatch(reason);
      expect(refusal(snapshot), name).toMatch(reason);
    }
    // Slow and fast steps the runtime does produce stay valid.
    for (const motion of [
      { tx: 5, ty: 5, moving: true, stepDir: 2, phase: 3, px: 80, py: 80 - 0.75 }, // 64-tick step
      { tx: 5, ty: 5, moving: true, stepDir: 1, phase: 1, px: 72, py: 80 }, // 2-tick step
    ] as Motion[]) {
      expect(validateSnapshot(withMotion(motion))).toBeNull();
      expect(load(withMotion(motion)).ok).toBe(true);
    }
  });

  test("a saved player route cannot be mid-step while the player rests", () => {
    const run = play(scriptedProject(), 60, hostTape(sourceTape(SOURCE_FRAMES), 60));
    const point = pickSavePoints(run).find((p) => p.kinds.has("player route"))!;
    const snapshot = createSessionSnapshot(run.session, run.states[point.frame]!, 0);
    expect(validateSnapshot(snapshot)).toBeNull();
    snapshot.mapRuntime!.playerRoute!.phase = 2;
    expect(validateSnapshot(snapshot)).toMatch(/playerRoute\.phase: integer <= 0 required/);
  });
});

describe("KS2 save-code input bounds", () => {
  const project = scriptedProject();
  const session = createSession(project, 60);
  const state = startSession(project, session);
  const code = encodeSaveCode(createSessionSnapshot(session, state, 0));
  const refusal = (input: string): { code: string; message: string } => {
    try {
      decodeSaveCode(input);
    } catch (error) {
      // Typed, never a raw RangeError or TypeError.
      expect(error).toBeInstanceOf(SaveError);
      return { code: (error as SaveError).code, message: (error as SaveError).message };
    }
    return { code: "accepted", message: "" };
  };
  /** `levels` nested arrays. */
  const nest = (levels: number): JsonValue => {
    let v: JsonValue = [];
    for (let i = 1; i < levels; i++) v = [v];
    return v;
  };

  test("empty input, unknown prefixes and stray characters", () => {
    expect(refusal("").code).toBe("bad-json");
    expect(refusal(" \n\t ").code).toBe("bad-json");
    expect(refusal("z0" + code.slice(2)).code).toBe("version");
    expect(refusal("zz" + code.slice(2)).code).toBe("version");
    expect(refusal("e!" + code.slice(2)).code).toBe("bad-json");
    expect(refusal("{}" + code).code).toBe("bad-json");
  });

  test("every truncation of a code is refused with a typed error", () => {
    for (let cut = 1; cut < code.length; cut++) {
      expect(["bad-json", "checksum", "shape", "version"]).toContain(refusal(code.slice(0, cut)).code);
    }
  });

  test("an overlong code is refused before it is decoded", () => {
    // Longer than any 16 MiB envelope can encode to.
    const max = Math.ceil(SAVE_CODE_MAX_BYTES / 3) * 4;
    expect(refusal("e" + "A".repeat(max)).message).toMatch(/longer than \d+ characters/);
    // Whitespace padding counts too once it is out of all proportion.
    expect(refusal(code + " ".repeat(max * 2)).message).toMatch(/longer than \d+ characters/);
    // Envelope text gets the same byte bound.
    expect(() => decodeEnvelopeText(" ".repeat(SAVE_CODE_MAX_BYTES + 1))).toThrow(/larger than/);
  });

  test("a small code that inflates to deeply nested JSON is refused, not a stack overflow", () => {
    // 100,000 nested arrays compress to a code of about 1.5 KB.
    const envelope = encodeEnvelope(createSessionSnapshot(session, state, 0))
      .replace('"ext":null', `"ext":${"[".repeat(100_000)}${"]".repeat(100_000)}`);
    const bomb = SAVE_CODE_COMPRESSED_PREFIX + Buffer.from(deflateRaw(new TextEncoder().encode(envelope))).toString("base64url");
    expect(bomb.length).toBeLessThan(4_000);
    expect(refusal(bomb)).toEqual({ code: "bad-json", message: `save data nests deeper than ${SAVE_MAX_DEPTH} levels` });
    expect(() => decodeEnvelopeText(envelope)).toThrow(SaveError);
    const loaded = loadSession(createSession(project, 60), bomb);
    expect(loaded.ok ? "ok" : loaded.error.code).toBe("bad-json");
  });

  test("saves at the depth bound round-trip; one level deeper is refused at save time", () => {
    // Envelope (1) > state (2) > ext (3...): 126 levels of ext reach the bound.
    const atBound = saveSession(session, { ...state, ext: nest(SAVE_MAX_DEPTH - 2) }, 0);
    expect(atBound.ok).toBe(true);
    if (!atBound.ok) return;
    const loaded = loadSession(createSession(project, 60), encodeSaveCode(atBound.snapshot));
    expect(loaded.ok).toBe(true);
    const deeper = saveSession(session, { ...state, ext: nest(SAVE_MAX_DEPTH - 1) }, 0);
    expect(deeper.ok ? "ok" : deeper.error.code).toBe("shape");
    // And a code written past it anyway does not load.
    const snapshot = { ...atBound.snapshot, ext: nest(SAVE_MAX_DEPTH - 1) };
    expect(refusal(encodeSaveCode(snapshot)).message).toMatch(/nests deeper than/);
  });
});

describe("KS2 envelope text is bounded in UTF-8 bytes", () => {
  // Envelopes are filled through the extension slot and written by the real
  // encoder, so each carries a correct checksum: a refusal can only come
  // from the size bound.
  const project = scriptedProject();
  const session = createSession(project, 60);
  const state = startSession(project, session);
  const snapshot = createSessionSnapshot(session, state, 0);
  const withExt = (ext: string): string => encodeEnvelope({ ...snapshot, ext });
  const encoder = new TextEncoder();
  const bytes = (text: string): number => encoder.encode(text).length;
  const room = SAVE_CODE_MAX_BYTES - bytes(withExt(""));
  const tooLarge = { code: "bad-json", message: `save data is larger than ${SAVE_CODE_MAX_BYTES} bytes` };
  const refusal = (text: string): { code: string; message: string } => {
    try {
      decodeEnvelopeText(text);
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError);
      return { code: (error as SaveError).code, message: (error as SaveError).message };
    }
    return { code: "accepted", message: "" };
  };
  const loadsExt = (text: string, ext: string): void => {
    expect(bytes(text)).toBe(SAVE_CODE_MAX_BYTES);
    expect(decodeEnvelopeText(text).ext === ext).toBe(true);
  };

  test("ASCII exactly at the bound loads; one byte more is refused", () => {
    loadsExt(withExt("a".repeat(room)), "a".repeat(room));
    expect(refusal(withExt("a".repeat(room + 1)))).toEqual(tooLarge);
  });

  test("three-byte characters exactly at the bound load; one byte more is refused", () => {
    const n = Math.floor(room / 3);
    const ext = "中".repeat(n) + "a".repeat(room - 3 * n);
    const at = withExt(ext);
    // Far fewer code units than bytes: a UTF-16 length check would pass both.
    expect(at.length * 3).toBeGreaterThan(SAVE_CODE_MAX_BYTES);
    loadsExt(at, ext);
    const over = withExt(ext + "a");
    expect(over.length).toBeLessThan(SAVE_CODE_MAX_BYTES);
    expect(refusal(over)).toEqual(tooLarge);
  });

  test("lone surrogates count three bytes each and do not swallow their neighbour", () => {
    // JSON.stringify escapes lone surrogates; written raw instead, the text
    // parses to the same state, so the checksum still holds.
    const raw = (text: string): string => text.split("\\ud800").join("\ud800").split("\\udc00").join("\udc00");
    const unit = "\ud800中a\udc00"; // 3 + 3 + 1 + 3 bytes
    const n = Math.floor(room / 10);
    const ext = unit.repeat(n) + "a".repeat(room - 10 * n);
    const at = raw(withExt(ext));
    expect(at.includes("\\ud800")).toBe(false);
    loadsExt(at, ext);
    expect(refusal(raw(withExt(ext + "a")))).toEqual(tooLarge);
  });

  test("a surrogate pair is four bytes, also where it straddles the bound", () => {
    const pairs = "😀".repeat(Math.floor(room / 4)) + "a".repeat(room % 4);
    loadsExt(withExt(pairs), pairs);
    const ascii = "a".repeat(room - 4);
    loadsExt(withExt(ascii + "😀"), ascii + "😀");
    // The pair's bytes cross the bound by one and by two.
    expect(refusal(withExt("a".repeat(room - 3) + "😀"))).toEqual(tooLarge);
    expect(refusal(withExt("a".repeat(room - 2) + "😀"))).toEqual(tooLarge);
  });

  test("six million three-byte characters are refused before parsing, on every public path", () => {
    const text = withExt("中".repeat(6_000_000));
    expect(text.length).toBeLessThan(SAVE_CODE_MAX_BYTES);
    expect(bytes(text)).toBeGreaterThan(SAVE_CODE_MAX_BYTES);
    // The count stops just past the bound instead of reading the whole text.
    const original = String.prototype.charCodeAt;
    let reads = 0;
    String.prototype.charCodeAt = function (this: string, i: number): number {
      reads++;
      return original.call(this, i);
    };
    let refused: { code: string; message: string };
    try {
      refused = refusal(text);
    } finally {
      String.prototype.charCodeAt = original;
    }
    expect(refused).toEqual(tooLarge);
    expect(reads).toBeLessThanOrEqual(Math.ceil(SAVE_CODE_MAX_BYTES / 3) + 1_000);
    expect(reads).toBeLessThan(text.length);
    const loaded = loadSession(createSession(project, 60), text);
    expect(loaded.ok ? "ok" : { code: loaded.error.code as string, message: loaded.error.message }).toEqual(tooLarge);
  });
});
