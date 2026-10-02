// tests/event-touch.test.ts — the eventTouch page trigger (RPG Maker MV
// Event Touch).
//
// A blocking (blocks:true) eventTouch page fires when the player's step is
// refused by the event's body (a bump) or the event's own step is refused
// by the player's body. A non-blocking page fires on entry like
// playerTouch. Contacts are detected in a reference tick's movement phase
// and start the page in that SAME tick's interpreter phase, under the
// playerTouch gates (no running main fiber, no box holding the player), in
// event-id order with the other blocking triggers. Pure bun: folds the
// session reducer.

import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import { BTN_BITS } from "../src/engine/camera.ts";
import {
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  sessionStateFingerprint,
} from "../src/engine/save.ts";
import { restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, Dir, GameEvent, MapDef, MoveRoute, Page, Project, TileId } from "../src/engine/types.ts";

const GRASS: TileId = "town.0";
const { RIGHT } = BTN_BITS;
const LTRIGGER = 0x0100; // BTN.L (contracts/spec/spec.ts): rewind

const pg = (trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page => ({
  trigger, sprite: null, commands, ...extra,
});
const ge = (id: string, x: number, y: number, pages: Page[]): GameEvent => ({ id, x, y, pages });

/** Count the fire in `hit:<id>`, then hold the main fiber for `hold`
 *  seconds so a test can see which page owns it and when it started. */
function touchCommands(id: string, hold = 1): Command[] {
  return [
    { op: "variable", id: `hit:${id}`, set: { op: "add", value: 1 } },
    { op: "wait", seconds: hold },
  ];
}

function room(events: GameEvent[], w = 11, h = 7): MapDef {
  return {
    id: "room", name: "room", width: w, height: h, sheets: ["town"],
    ground: new Array<TileId>(w * h).fill(GRASS), events,
  };
}

function project(
  events: GameEvent[],
  start: { x: number; y: number; dir: Dir } = { x: 2, y: 3, dir: "right" },
  system?: Project["system"],
): Project {
  return {
    format: "rpgkit-project/v1",
    title: "event touch",
    tileSize: 16,
    start: { map: "room", ...start },
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [],
    maps: [room(events)],
    ...(system ? { system } : {}),
  };
}

function boot(p: Project, hz = 60, immutableState = false): { sess: Session; s: SessionState } {
  const sess = createSession(p, hz, { immutableState });
  return { sess, s: startSession(p, sess) };
}

const hits = (s: SessionState, id: string): number => Number(s.sw.variables[`hit:${id}`] ?? 0);
const mainId = (s: SessionState): string | null =>
  s.interp.main ? s.interp.main.key.slice("room".length + 1) : null;
/** Reference tick the main fiber started on (its first `wait` pins it). */
const mainSince = (s: SessionState): number => (s.interp.main as unknown as { since: number }).since;

/** Fold host frames until `pred` holds; returns the state and the host
 *  frame count it took (throws after `limit`). */
function until(
  sess: Session,
  s0: SessionState,
  pred: (s: SessionState) => boolean,
  input: SessionInput = { buttons: 0 },
  limit = 600,
): { s: SessionState; frames: number } {
  let s = s0;
  for (let f = 1; f <= limit; f++) {
    s = stepSession(sess, s, input);
    if (pred(s)) return { s, frames: f };
  }
  throw new Error("condition never held");
}

function fold(sess: Session, s0: SessionState, frames: number, input: SessionInput = { buttons: 0 }): SessionState {
  let s = s0;
  for (let f = 0; f < frames; f++) s = stepSession(sess, s, input);
  return s;
}

/** A page default that forces the KM1 movement-control path. */
const KM1: Partial<Page> = { moveSpeed: 4 };

for (const [label, extra] of [["legacy path", {}], ["KM1 path", KM1]] as const) {
  describe(`eventTouch bump (${label})`, () => {
    test("walking into a blocking eventTouch NPC fires on the bump tick", () => {
      const npc = ge("npc", 4, 3, [pg("eventTouch", touchCommands("npc"), { blocks: true, sprite: "npc", ...extra })]);
      const { sess, s } = boot(project([npc]));
      const held = { buttons: RIGHT };
      const r = until(sess, s, (x) => hits(x, "npc") > 0, held);
      // One 8-tick step (2,3) -> (3,3); its arrival tick refuses the held
      // continuation into the body and the page starts on that same tick.
      expect(r.frames).toBe(8);
      expect(r.s.move.tx).toBe(3);
      expect(r.s.move.moving).toBe(false);
      expect(mainId(r.s)).toBe("npc");
      expect(mainSince(r.s)).toBe(r.s.interp.frame);
      // Busy: the mover is frozen while the fiber runs; no second fire.
      let t = fold(sess, r.s, 30, held);
      expect(hits(t, "npc")).toBe(1);
      // No latch (MV parity): once the page ends, the still-held direction
      // bumps again and re-fires.
      t = until(sess, t, (x) => hits(x, "npc") === 2, held).s;
      expect(t.move.tx).toBe(3);
    });

    test("a blocking playerTouch page never fires on a bump (unchanged)", () => {
      const npc = ge("npc", 4, 3, [pg("playerTouch", touchCommands("npc"), { blocks: true, sprite: "npc", ...extra })]);
      const { sess, s } = boot(project([npc]));
      const t = fold(sess, s, 120, { buttons: RIGHT });
      expect(hits(t, "npc")).toBe(0);
      expect(t.interp.main).toBeNull();
      expect(t.move.tx).toBe(3);
    });

    test("a non-blocking eventTouch page fires once on entry", () => {
      const plate = ge("plate", 4, 3, [pg("eventTouch", touchCommands("plate", 0.1), { ...extra })]);
      const { sess, s } = boot(project([plate]));
      const r = until(sess, s, (x) => hits(x, "plate") > 0, { buttons: RIGHT });
      expect(r.frames).toBe(16);
      expect(r.s.move.tx).toBe(4);
      // Standing on it (released) never re-fires.
      const t = fold(sess, r.s, 120);
      expect(hits(t, "plate")).toBe(1);
      expect(t.move.tx).toBe(4);
    });

    test("an NPC whose route step is refused by the player fires", () => {
      const walker = ge("walker", 6, 3, [pg("eventTouch", touchCommands("walker"), {
        blocks: true, sprite: "npc", ...extra,
        moveRoute: { steps: ["moveLeft"], repeat: true, skippable: false },
      })]);
      const { sess, s } = boot(project([walker]));
      const r = until(sess, s, (x) => hits(x, "walker") > 0);
      expect(r.s.chars.chars.walker!.tx).toBe(3);
      expect(r.s.move.tx).toBe(2);
      expect(mainId(r.s)).toBe("walker");
    });

    test("an approach NPC reaching the player fires", () => {
      const chaser = ge("chaser", 6, 3, [pg("eventTouch", touchCommands("chaser"), {
        blocks: true, sprite: "npc", moveType: "approach", ...extra,
      })]);
      const { sess, s } = boot(project([chaser]));
      const r = until(sess, s, (x) => hits(x, "chaser") > 0);
      expect(r.s.chars.chars.chaser!.tx).toBe(3);
      expect(r.s.chars.chars.chaser!.ty).toBe(3);
      expect(mainId(r.s)).toBe("chaser");
    });

    test("a blocking playerTouch NPC walking into the player never fires (unchanged)", () => {
      const walker = ge("walker", 6, 3, [pg("playerTouch", touchCommands("walker"), {
        blocks: true, sprite: "npc", ...extra,
        moveRoute: { steps: ["moveLeft"], repeat: true, skippable: false },
      })]);
      const { sess, s } = boot(project([walker]));
      const t = fold(sess, s, 240);
      expect(hits(t, "walker")).toBe(0);
      expect(t.chars.chars.walker!.tx).toBe(3);
    });
  });
}

describe("eventTouch arbitration and gates", () => {
  test("two contacts on one tick: the lower id wins, one main fiber", () => {
    const route = (dir: "moveLeft" | "moveRight"): MoveRoute =>
      ({ steps: [dir], repeat: true, skippable: false });
    // Mirror images: both land next to the player on the same tick and are
    // refused on the same boundary tick.
    const b = ge("b", 6, 3, [pg("eventTouch", touchCommands("b"), { blocks: true, sprite: "npc", moveRoute: route("moveLeft") })]);
    const a = ge("a", 0, 3, [pg("eventTouch", touchCommands("a"), { blocks: true, sprite: "npc", moveRoute: route("moveRight") })]);
    const { sess, s } = boot(project([b, a], { x: 3, y: 3, dir: "down" }));
    const r = until(sess, s, (x) => x.interp.main !== null);
    expect(r.s.chars.chars.a!.tx).toBe(2);
    expect(r.s.chars.chars.b!.tx).toBe(4);
    expect(mainId(r.s)).toBe("a");
    expect(hits(r.s, "a")).toBe(1);
    expect(hits(r.s, "b")).toBe(0);
    // Both stay refused every tick. Without a latch the lower id keeps
    // winning each time the main fiber frees up (one fiber at a time).
    const t = until(sess, r.s, (x) => hits(x, "a") === 2).s;
    expect(mainId(t)).toBe("a");
    expect(hits(t, "b")).toBe(0);
    expect(mainSince(t)).toBeGreaterThanOrEqual(mainSince(r.s) + 60);
  });

  test("no fire while another main fiber runs", () => {
    const intro = ge("intro", 0, 0, [pg("autorun", [
      { op: "wait", seconds: 2 },
      { op: "switch", id: "introDone", value: true },
    ], { condition: { all: [{ kind: "switch", id: "introDone", value: false }] } })]);
    const walker = ge("walker", 5, 3, [pg("eventTouch", touchCommands("walker"), {
      blocks: true, sprite: "npc", moveRoute: { steps: ["moveLeft"], repeat: true, skippable: false },
    })]);
    const { sess, s } = boot(project([intro, walker]));
    // The walker is adjacent (refused every tick) long before the autorun
    // ends at 2 s; it fires only after.
    const mid = fold(sess, s, 60);
    expect(mid.chars.chars.walker!.tx).toBe(3);
    expect(mainId(mid)).toBe("intro");
    expect(hits(mid, "walker")).toBe(0);
    const r = until(sess, mid, (x) => hits(x, "walker") > 0);
    expect(r.s.sw.switches.introDone).toBe(true);
    expect(mainSince(r.s)).toBeGreaterThanOrEqual(120);
  });

  test("no fire while a message box holds the player", () => {
    const banner = ge("banner", 0, 0, [pg("parallel", [
      { op: "text", lines: ["Hold on."] },
      { op: "variable", id: "seen", set: { op: "set", value: 1 } },
    ], { condition: { variable: { id: "seen", op: "==", value: 0 } } })]);
    const walker = ge("walker", 5, 3, [pg("eventTouch", touchCommands("walker"), {
      blocks: true, sprite: "npc", moveRoute: { steps: ["moveLeft"], repeat: true, skippable: false },
    })]);
    const { sess, s } = boot(project([banner, walker], undefined, { messageBlocksPlayer: true }));
    const mid = fold(sess, s, 90);
    expect(mid.interp.modal?.kind).toBe("text");
    expect(mid.chars.chars.walker!.tx).toBe(3);
    expect(hits(mid, "walker")).toBe(0);
    // Finish the typewriter, then close the box: the next refused step fires.
    let t = stepSession(sess, mid, { buttons: 0, confirmEdge: true });
    t = stepSession(sess, t, { buttons: 0 });
    t = stepSession(sess, t, { buttons: 0, confirmEdge: true });
    expect(t.interp.modal).toBeNull();
    t = until(sess, t, (x) => hits(x, "walker") > 0, { buttons: 0 }, 10).s;
    expect(mainId(t)).toBe("walker");
  });
});

describe("eventTouch determinism", () => {
  const bumpProject = () => project([
    ge("npc", 5, 3, [pg("eventTouch", touchCommands("npc", 2), { blocks: true, sprite: "npc" })]),
    ge("walker", 9, 1, [pg("eventTouch", touchCommands("walker", 2), {
      blocks: true, sprite: "npc", moveRoute: { steps: ["moveLeft", "moveLeft", "moveDown", "moveRight"], repeat: true, skippable: false },
    })]),
  ]);

  test("the bump fires at the same virtual time at 60/30/20/4 Hz", () => {
    const seen = ([60, 30, 20, 4] as const).map((hz) => {
      const { sess, s } = boot(bumpProject(), hz);
      // 2 virtual seconds of holding right, then 1 s released.
      let t = fold(sess, s, 2 * hz, { buttons: RIGHT });
      const at2 = { since: mainSince(t), main: mainId(t), x: t.move.tx, hits: hits(t, "npc"), frame: t.interp.frame };
      t = fold(sess, t, hz);
      return { at2, at3: sessionStateFingerprint(t), chars: t.chars, move: t.move };
    });
    expect(seen[0]!.at2.main).toBe("npc");
    expect(seen[0]!.at2.since).toBe(16); // two steps, then the arrival bump
    for (const v of seen.slice(1)) expect(v).toEqual(seen[0]!);
  });

  for (const immutableState of [false, true]) {
    test(`save before a contact restores to the same fire tick (immutableState=${immutableState})`, () => {
      const { sess, s } = boot(bumpProject(), 60, immutableState);
      // One step right, at rest on (3,3), then save before the bump.
      let t = fold(sess, s, 8, { buttons: RIGHT });
      t = fold(sess, t, 1);
      expect(t.move.moving).toBe(false);
      expect(hits(t, "npc")).toBe(0);
      const restored = restoreSessionSnapshot(
        sess,
        decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(sess, t, 0))),
      );
      const a = until(sess, t, (x) => hits(x, "npc") > 0, { buttons: RIGHT });
      const b = until(sess, restored, (x) => hits(x, "npc") > 0, { buttons: RIGHT });
      expect(b.frames).toBe(a.frames);
      expect(mainSince(b.s)).toBe(mainSince(a.s));
      expect(sessionStateFingerprint(b.s)).toBe(sessionStateFingerprint(a.s));
      const a2 = fold(sess, a.s, 200, { buttons: RIGHT });
      const b2 = fold(sess, b.s, 200, { buttons: RIGHT });
      expect(sessionStateFingerprint(b2)).toBe(sessionStateFingerprint(a2));
      expect(b2.chars).toEqual(a2.chars);
    });
  }

  test("rewind refolds the same contacts from a keyframe and from zero", () => {
    // Hold right into the NPC for the whole tape; the walker loops through
    // the player's column, so contacts recur across the rewound window.
    const tape = new Array<number>(600).fill(RIGHT);
    const options = {
      hz: 60, tapeHz: 60, idleFrames: 60_000, endHoldFrames: 60_000,
      rewindSeconds: 0.5, keyframeIntervalFrames: 17,
    };
    const keyed = new AttractController(bumpProject(), tape, options);
    const fromZero = new AttractController(bumpProject(), tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let i = 0; i < 200; i++) {
      keyed.step(0);
      fromZero.step(0);
    }
    const before = sessionStateFingerprint(keyed.state);
    expect(hits(keyed.state, "npc")).toBeGreaterThan(0);
    keyed.step(LTRIGGER);
    fromZero.step(LTRIGGER);
    expect(keyed.state).toEqual(fromZero.state);
    expect(keyed.keyframeStats().lastRefoldStart).toBeGreaterThan(0);
    // Replaying the same 30 frames lands on the pre-rewind state again.
    for (let i = 0; i < 30; i++) {
      keyed.step(0);
      fromZero.step(0);
    }
    expect(keyed.state).toEqual(fromZero.state);
    expect(sessionStateFingerprint(keyed.state)).toBe(before);
  });

  test("touchContacts never reaches a map without eventTouch pages", () => {
    const p = project([
      ge("npc", 4, 3, [pg("action", touchCommands("npc"), { blocks: true, sprite: "npc" })]),
      ge("walker", 6, 3, [pg("playerTouch", touchCommands("walker"), {
        blocks: true, sprite: "npc", moveRoute: { steps: ["moveLeft"], repeat: true, skippable: false },
      })]),
    ]);
    const { sess, s } = boot(p);
    expect(sess.worlds.get("room")!.hasEventTouch).toBeUndefined();
    const t = fold(sess, s, 120, { buttons: RIGHT });
    expect(hits(t, "npc") + hits(t, "walker")).toBe(0);
  });
});
