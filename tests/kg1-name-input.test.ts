// tests/kg1-name-input.test.ts — the built-in name-input SceneRules.
//
// Covers the reducer lifecycle: charset navigation with wrap, append,
// backspace, maxLength clamp, prefill (variable / player name / default),
// OK writing a variable or the player name, empty-buffer refusal, cancel,
// charset/columns/title args, held-key repeat, multi-hz parity, and the
// {name} text substitution after a player rename.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  NAME_INPUT_SCENE_ID,
  nameInputRules,
  type NameInputState,
} from "../src/engine/name-input.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "name-map";

function map(events: GameEvent[] = []): MapDef {
  return {
    id: MAP_ID,
    name: "Name input fixture",
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events,
  };
}

function project(events: GameEvent[] = [], playerName?: string): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Name input fixture",
    tileSize: 16,
    start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map(events)],
    ...(playerName ? { playerName } : {}),
  };
}

function page(
  trigger: GameEvent["pages"][number]["trigger"],
  commands: Command[],
  condition?: GameEvent["pages"][number]["condition"],
): GameEvent["pages"][number] {
  return { trigger, commands, ...(condition ? { condition } : {}) };
}

function event(id: string, pages: GameEvent["pages"]): GameEvent {
  return { id, x: 6, y: 6, pages };
}

/** Autorun opens the name-input scene on boot; page 2 stops re-trigger. */
function nameInputProject(args: Record<string, unknown> = {}, trailing: Command[] = []): Project {
  return project([
    event("name-open", [
      page("autorun", [
        { op: "scene", id: NAME_INPUT_SCENE_ID, args: args as never },
        ...trailing,
        { op: "switch", id: "name.finished", value: true },
      ]),
      page("action", [], { switch: "name.finished" }),
    ]),
  ]);
}

function makeSession(p: Project, hz: 60 | 30 | 20 | 4 = 60): Session {
  return createSession(p, hz, { scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules } });
}

function step(
  session: Session,
  state: SessionState,
  edges: { confirm?: boolean; cancel?: boolean; up?: boolean; down?: boolean; left?: boolean; right?: boolean } = {},
  buttons = 0,
): SessionState {
  return stepSession(session, state, {
    buttons,
    confirmEdge: edges.confirm === true,
    cancelEdge: edges.cancel === true,
    upEdge: edges.up === true,
    downEdge: edges.down === true,
    leftEdge: edges.left === true,
    rightEdge: edges.right === true,
  });
}

function openScene(session: Session, state: SessionState): SessionState {
  let next = state;
  for (let frame = 0; frame < 10 && next.scene === null; frame++) next = step(session, next);
  return next;
}

function settle(session: Session, state: SessionState): SessionState {
  let next = state;
  for (let frame = 0; frame < 600 && next.scene !== null; frame++) next = step(session, next);
  for (let frame = 0; frame < 10; frame++) next = step(session, next);
  return next;
}

function nameState(state: SessionState): NameInputState {
  if (state.scene?.kind !== "scene") throw new Error("name scene not open");
  return state.scene.state as unknown as NameInputState;
}

/** Drive the grid cursor to entry `target` with right-edge presses. */
function gotoEntry(session: Session, state: SessionState, target: number): SessionState {
  let next = state;
  const total = nameState(next).charset.length + 3;
  let cur = nameState(next).cursor;
  const moves = (target - cur + total) % total;
  for (let i = 0; i < moves; i++) next = step(session, next, { right: true });
  expect(nameState(next).cursor).toBe(target);
  return next;
}

const BACK = 67;
const OK = 68;
const CANCEL = 69;

describe("KG1 built-in name input", () => {
  test("editing: navigate with wrap, append, backspace, maxLength clamp", () => {
    const p = nameInputProject({ variable: "nick", maxLength: 4 });
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session));
    const ns = () => nameState(state);

    state = gotoEntry(session, state, 0); // 'A'
    state = step(session, state, { confirm: true });
    expect(ns().buffer).toBe("A");

    state = gotoEntry(session, state, 1); // 'B'
    state = step(session, state, { confirm: true });
    expect(ns().buffer).toBe("AB");

    // Wrap: right from the last entry (CANCEL, 69) returns to 'A' (0).
    state = gotoEntry(session, state, CANCEL);
    state = step(session, state, { right: true });
    expect(ns().cursor).toBe(0);

    // Backspace removes the last char.
    state = gotoEntry(session, state, BACK);
    state = step(session, state, { confirm: true });
    expect(ns().buffer).toBe("A");

    // Fill to the cap, then an extra append is ignored.
    state = gotoEntry(session, state, 2); // 'C'
    for (let i = 0; i < 4; i++) state = step(session, state, { confirm: true });
    expect(ns().buffer).toBe("ACCC");
    state = step(session, state, { confirm: true });
    expect(ns().buffer).toBe("ACCC");
    expect(ns().phase).toBe("edit");
  });

  test("prefill: variable value, then player name, then args.default", () => {
    // Variable target prefills from the variable's current string.
    let p = nameInputProject({ variable: "nick" });
    let session = makeSession(p);
    let state = openScene(session, startSession(p, session, createSwitchState({ variables: { nick: "Bob" } })));
    expect(nameState(state).buffer).toBe("Bob");

    // Player-name target prefills from the current player name.
    p = nameInputProject({});
    session = makeSession(p);
    state = openScene(session, startSession(p, session, createSwitchState({ playerName: "Hero" })));
    expect(nameState(state).buffer).toBe("Hero");

    // args.default overrides both.
    p = nameInputProject({ variable: "nick", default: "Zed" });
    session = makeSession(p);
    state = openScene(session, startSession(p, session, createSwitchState({ variables: { nick: "Bob" } })));
    expect(nameState(state).buffer).toBe("Zed");

    // No prefill anywhere: the default player name is NOT used for a
    // variable target (only the live variable value).
    p = nameInputProject({ variable: "nick" });
    session = makeSession(p);
    state = openScene(session, startSession(p, session));
    expect(nameState(state).buffer).toBe("");
  });

  test("confirm: OK writes the variable or the player name; empty buffer refused", () => {
    let p = nameInputProject({ variable: "nick" });
    let session = makeSession(p);
    let state = openScene(session, startSession(p, session));
    state = gotoEntry(session, state, 0); // 'A'
    state = step(session, state, { confirm: true });
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true });
    state = settle(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.variables["nick"]).toBe("A");

    // Player-name target.
    p = nameInputProject({});
    session = makeSession(p);
    state = openScene(session, startSession(p, session, createSwitchState({ playerName: "Hero" })));
    expect(nameState(state).buffer).toBe("Hero");
    state = gotoEntry(session, state, 3); // 'D'
    state = step(session, state, { confirm: true });
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true });
    state = settle(session, state);
    expect(state.sw.playerName).toBe("HeroD");

    // Empty buffer: OK does not complete.
    p = nameInputProject({ variable: "nick" });
    session = makeSession(p);
    state = openScene(session, startSession(p, session));
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true });
    expect(state.scene).not.toBeNull();
    expect(nameState(state).phase).toBe("edit");

    // allowEmpty + variable target commits the empty string.
    p = nameInputProject({ variable: "nick", allowEmpty: true });
    session = makeSession(p);
    state = openScene(session, startSession(p, session));
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true });
    state = settle(session, state);
    expect(state.sw.variables["nick"]).toBe("");

    // allowEmpty must NOT bypass the player-name non-empty rule.
    p = nameInputProject({ allowEmpty: true });
    session = makeSession(p);
    state = openScene(session, startSession(p, session));
    state = gotoEntry(session, state, BACK);
    for (let i = 0; i < 6; i++) state = step(session, state, { confirm: true });
    expect(nameState(state).buffer).toBe("");
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true });
    expect(state.scene).not.toBeNull();
  });

  test("cancel: leaves the target untouched", () => {
    const p = nameInputProject({ variable: "nick" });
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session, createSwitchState({ variables: { nick: "Bob" } })));
    state = gotoEntry(session, state, 0); // 'A'
    state = step(session, state, { confirm: true });
    expect(nameState(state).buffer).toBe("BobA");
    state = step(session, state, { cancel: true });
    state = settle(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.variables["nick"]).toBe("Bob");
  });

  test("grid CANCEL action closes and leaves the target untouched", () => {
    // The physical cancel key is covered above; the grid's own CANCEL entry
    // must close and skip the writeback by default (swallowCancel opts out).
    const p = nameInputProject({ variable: "nick" });
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session, createSwitchState({ variables: { nick: "Bob" } })));
    state = gotoEntry(session, state, 0); // 'A'
    state = step(session, state, { confirm: true });
    expect(nameState(state).buffer).toBe("BobA");
    state = gotoEntry(session, state, CANCEL);
    state = step(session, state, { confirm: true });
    state = settle(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.variables["nick"]).toBe("Bob");
  });

  test("charset/columns/title args are honored", () => {
    const p = nameInputProject({ charset: ["a", "b", "c"], columns: 3, title: "Nick" });
    const session = makeSession(p);
    const state = openScene(session, startSession(p, session));
    const ns = nameState(state);
    expect(ns.charset).toEqual(["a", "b", "c"]);
    expect(ns.columns).toBe(3);
    expect(ns.rows).toBe(2); // 3 chars + 3 actions = 6 entries / 3
    expect(ns.title).toBe("Nick");
    expect(ns.maxLength).toBe(8); // default
  });

  test("maxLength clamps to 1..24 instead of falling back to 8", () => {
    // B7: a value above the cap clamps DOWN to the cap (25 -> 24), and a
    // value below the floor clamps UP to it (0 -> 1), matching the documented
    // "clamped to 1..24" rather than the old fallback-to-8.
    for (const [given, want] of [[25, 24], [30, 24], [0, 1], [-5, 1], [1, 1], [24, 24]] as const) {
      const p = nameInputProject({ variable: "nick", maxLength: given });
      const session = makeSession(p);
      const state = openScene(session, startSession(p, session));
      expect(nameState(state).maxLength).toBe(want);
    }
    // A non-integer still falls back to the default.
    const p = nameInputProject({ variable: "nick", maxLength: 3.5 });
    const session = makeSession(p);
    const state = openScene(session, startSession(p, session));
    expect(nameState(state).maxLength).toBe(8);
  });

  test("charset rejects control characters", () => {
    // B7: a custom charset keeps only printable single code units; NUL,
    // newline and other controls are dropped (Tuxemon renders NUL as a
    // disabled cell, never a writable char).
    const p = nameInputProject({ variable: "nick", charset: ["A", "\n", "B", "\0", "\t", "C", " "] });
    const session = makeSession(p);
    const state = openScene(session, startSession(p, session));
    expect(nameState(state).charset).toEqual(["A", "B", "C", " "]);
  });

  test("charset rejects C1 controls and unpaired surrogates", () => {
    // B7: the printable-only claim covers C1 controls (U+0085 NEL, U+009F)
    // and unpaired surrogates (U+D800), not just C0 and DEL.
    const p = nameInputProject({
      variable: "nick",
      charset: ["A", "\u0085", "\u009f", "\ud800", "\n", "\x7f"],
    });
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session));
    expect(nameState(state).charset).toEqual(["A"]);
    // The rejected entries can never reach the write buffer: append the
    // single surviving char and commit.
    state = gotoEntry(session, state, 0); // 'A'
    state = step(session, state, { confirm: true });
    state = gotoEntry(session, state, nameState(state).charset.length + 1); // OK
    state = step(session, state, { confirm: true });
    state = settle(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.variables["nick"]).toBe("A");
  });

  test("charset rejects format controls and line/paragraph separators", () => {
    // 修复 3: "printable" covers every non-printable Unicode category, not
    // just C0/C1 — U+200B ZERO WIDTH SPACE and U+FEFF ZERO WIDTH NO-BREAK
    // SPACE are Cf, U+2028/U+2029 are Zl/Zp. Each would render an invisible
    // or line-breaking grid cell, so all are dropped. Space separators (Zs)
    // render a visible cell and are kept, so U+00A0 survives.
    const p = nameInputProject({
      variable: "nick",
      charset: ["A", "\u200b", "\u2028", "\u2029", "\ufeff", "\u00a0", "B"],
    });
    const session = makeSession(p);
    const state = openScene(session, startSession(p, session));
    expect(nameState(state).charset).toEqual(["A", "\u00a0", "B"]);
  });

  test("swallowCancel: true makes cancel a no-op (Tuxemon escape_key_exits=False)", () => {
    // B7: Tuxemon's rename_player/rename_monster open the input menu with
    // escape_key_exits=False, so the cancel key is swallowed, not closing.
    // The generic scene defaults to closing on cancel; swallowCancel opts
    // into the Tuxemon adapter semantics.
    const p = nameInputProject({ variable: "nick", swallowCancel: true });
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session, createSwitchState({ variables: { nick: "Bob" } })));
    state = step(session, state, { cancel: true }); // physical cancel swallowed
    expect(state.scene, "scene stays open").not.toBeNull();
    expect(nameState(state).phase).toBe("edit");
    // The grid CANCEL action is swallowed too.
    state = gotoEntry(session, state, CANCEL);
    state = step(session, state, { confirm: true });
    expect(state.scene, "scene stays open").not.toBeNull();
    expect(nameState(state).phase).toBe("edit");
    // OK still commits.
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true });
    state = settle(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.variables["nick"]).toBe("Bob");
  });

  test("held-direction repeat is deterministic and tick-based", () => {
    const p = nameInputProject({ variable: "nick" });
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session));
    // One right edge, then keep RIGHT held: the first repeat fires after
    // 30 reference ticks, then every 6.
    state = step(session, state, { right: true }, BTN.RIGHT);
    expect(nameState(state).cursor).toBe(1);
    for (let i = 0; i < 29; i++) state = step(session, state, {}, BTN.RIGHT);
    expect(nameState(state).cursor).toBe(1); // delay not elapsed
    state = step(session, state, {}, BTN.RIGHT);
    expect(nameState(state).cursor).toBe(2); // first repeat
    for (let i = 0; i < 6; i++) state = step(session, state, {}, BTN.RIGHT);
    expect(nameState(state).cursor).toBe(3); // second repeat
    // Releasing stops the repeat.
    state = step(session, state, {});
    state = step(session, state, {});
    expect(nameState(state).cursor).toBe(3);
  });

  test("held-direction repeat folds every due repeat at 60/30/20/4 Hz", () => {
    // One right edge, then RIGHT held for 60 more reference ticks. The repeat
    // schedule (first at 30 ticks, then every 6) is defined on the reference
    // clock, so the cursor and the residual hold accumulator must match
    // across host rates: a 4 Hz frame carries 15 ticks and crosses up to
    // three repeat periods, so every due repeat must fold in one step.
    const expected = { cursor: 7, holdTicks: 24, holdDir: BTN.RIGHT, buffer: "" };
    for (const hz of [60, 30, 20, 4] as const) {
      const p = nameInputProject({ variable: "nick" });
      const session = makeSession(p, hz);
      let state = openScene(session, startSession(p, session));
      state = step(session, state, { right: true }, BTN.RIGHT); // edge + held
      for (let i = 0; i < hz; i++) state = step(session, state, {}, BTN.RIGHT); // 60 ticks
      const ns = nameState(state);
      expect({ cursor: ns.cursor, holdTicks: ns.holdTicks, holdDir: ns.holdDir, buffer: ns.buffer })
        .toEqual(expected);
    }
  });

  test("60/30/20/4 Hz reach the same committed name", () => {
    // Tape: open, append 'A' (entry 0), walk to OK (68), confirm.
    const tape: { confirm?: boolean; right?: boolean }[] = [
      { confirm: true },
      ...Array.from({ length: OK }, () => ({ right: true })),
      { confirm: true },
    ];
    const outcomes = ([60, 30, 20, 4] as const).map((hz) => {
      const p = nameInputProject({ variable: "nick" });
      const session = makeSession(p, hz);
      let state = openScene(session, startSession(p, session));
      for (const edges of tape) state = step(session, state, edges);
      state = settle(session, state);
      return { nick: state.sw.variables["nick"], finished: state.sw.switches["name.finished"] };
    });
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ nick: "A", finished: true });
    }
  });

  test("attract/takeover live input carries left/right edges to the scene", () => {
    // B3: AttractController.reduce forwarded only confirm/cancel/up/down, so
    // name input could not make its first horizontal move (or establish a
    // held-repeat direction) in demo, takeover, or replay paths.
    const p = nameInputProject({ variable: "nick" });
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
    });
    for (let i = 0; i < 5 && controller.state.scene === null; i++) controller.step(0);
    expect(controller.state.scene, "name scene opened").not.toBeNull();
    expect(nameState(controller.state).cursor).toBe(0);
    controller.step(BTN.RIGHT); // live takeover press
    controller.step(0);
    expect(nameState(controller.state).cursor).toBe(1);
    controller.step(BTN.LEFT);
    controller.step(0);
    expect(nameState(controller.state).cursor).toBe(0);
  });

  test("a player rename flows into the {name} text token", () => {
    const p = nameInputProject({}, [{ op: "text", lines: ["Hi {name}!"] }]);
    const session = makeSession(p);
    let state = openScene(session, startSession(p, session, createSwitchState({ playerName: "Hero" })));
    state = gotoEntry(session, state, OK);
    state = step(session, state, { confirm: true }); // keep "Hero"
    state = settle(session, state);
    expect(state.sw.playerName).toBe("Hero");
    const modal = state.interp.modal;
    expect(modal?.kind).toBe("text");
    if (modal?.kind === "text") {
      expect(modal.lines).toEqual(["Hi Hero!"]);
    }
  });
});
