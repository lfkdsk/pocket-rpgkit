// tests/text-variables.test.ts — the {v:<id>} text token behind
// project.system.textVariables: pure expansion, reducer boxes (text,
// choices), expansion once per box, the off-by-default gate, session
// plumbing and rate independence. (A save cannot be taken while a box is
// open, so expanded text never crosses a save.)

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import { createSession, startSession, stepSession, type SessionInput } from "../src/engine/session.ts";
import { expandTextTokens } from "../src/engine/player-name.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

describe("expandTextTokens", () => {
  const vars = { gold: 120, who: "Mo", neg: -3 };

  test("replaces {v:id} with the value, 0 when unset, alongside {name}", () => {
    expect(expandTextTokens("{name} has {v:gold}G", "Red", vars)).toBe("Red has 120G");
    expect(expandTextTokens("{v:who}/{v:neg}/{v:none}", "Red", vars)).toBe("Mo/-3/0");
    expect(expandTextTokens("{v:}", "Red", vars)).toBe("0");
  });

  test("other braces pass through and inherited keys are not variables", () => {
    expect(expandTextTokens("{other} {v:gold", "Red", vars)).toBe("{other} {v:gold");
    expect(expandTextTokens("{v:constructor}", "Red", vars)).toBe("0");
  });

  test("one pass: a value or name holding a token prints it literally", () => {
    expect(expandTextTokens("{v:t}", "Red", { t: "{name}" })).toBe("{name}");
    expect(expandTextTokens("{name}", "{v:gold}", vars)).toBe("{v:gold}");
  });

  test("without a variable bank only {name} expands", () => {
    expect(expandTextTokens("{name}: {v:gold}", "Red", null)).toBe("Red: {v:gold}");
  });
});

const MAP_ID = "v";
function mapWith(events: GameEvent[]): MapDef {
  return {
    id: MAP_ID,
    name: "t",
    width: 20,
    height: 13,
    sheets: ["town"],
    ground: Array(20 * 13).fill("town.0"),
    events,
  };
}
function world(commands: Command[], textVariables: boolean, parallel: Command[] = []) {
  const events: GameEvent[] = [{ id: "e", x: 10, y: 10, pages: [{ trigger: "autorun", commands }] }];
  if (parallel.length > 0) events.push({ id: "p", x: 1, y: 1, pages: [{ trigger: "parallel", commands: parallel }] });
  return createWorld(mapWith(events), [], 60, { textVariables });
}
const cell = { x: 10, y: 10 };
const noEdges: InterpInput = {
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: cell,
  prevCell: cell,
  facing: 2,
};

describe("{v:id} in the reducer", () => {
  test("a text box shows the live value and reveals over the expanded text", () => {
    const w = world([
      { op: "variable", id: "coins", set: { op: "set", value: 1234 } },
      { op: "text", lines: ["You have {v:coins} coins."] },
    ], true);
    const s = stepInterp(w, createInterpState(), noEdges);
    expect(s.modal).toMatchObject({ kind: "text", lines: ["You have 1234 coins."], total: 20 });
  });

  test("off by default: the braces show verbatim", () => {
    const w = world([
      { op: "variable", id: "coins", set: { op: "set", value: 5 } },
      { op: "text", lines: ["{name}: {v:coins}"] },
    ], false);
    const s = stepInterp(w, createInterpState(createSwitchState({ playerName: "Red" })), noEdges);
    expect(s.modal).toMatchObject({ lines: ["Red: {v:coins}"] });
  });

  test("expanded once when the box opens; a write while it is up does not retype it", () => {
    const w = world(
      [{ op: "text", lines: ["n={v:n}"] }],
      true,
      [{ op: "variable", id: "n", set: { op: "add", value: 1 } }, { op: "wait", seconds: 0 }],
    );
    let s: InterpState = createInterpState();
    s = stepInterp(w, s, noEdges);
    const shown = (s.modal as { lines: string[] }).lines[0]!;
    expect(shown).toMatch(/^n=\d+$/);
    for (let i = 0; i < 30; i++) s = stepInterp(w, s, noEdges);
    expect(Number(s.sw.variables.n)).toBeGreaterThan(Number(shown.slice(2)));
    expect(s.modal).toMatchObject({ kind: "text", lines: [shown] });
  });

  test("choices prompt and rows expand", () => {
    const w = world([
      { op: "variable", id: "price", set: { op: "set", value: 30 } },
      {
        op: "choices",
        prompt: "Pay {v:price}G?",
        options: [{ text: "Yes ({v:price})", commands: [] }, { text: "No", commands: [] }],
      },
    ], true);
    const s = stepInterp(w, createInterpState(), noEdges);
    expect(s.modal).toMatchObject({ kind: "choices", prompt: "Pay 30G?", options: ["Yes (30)", "No"] });
  });
});

function project(textVariables: boolean | undefined): Project {
  const map = mapWith([{
    id: "e",
    x: 3,
    y: 3,
    pages: [{
      trigger: "autorun",
      commands: [
        { op: "wait", seconds: 0.5 },
        { op: "variable", id: "t", set: { op: "add", value: 1 } },
        { op: "text", lines: ["t={v:t}"] },
      ],
    }],
  }]);
  return {
    format: "rpgkit-project/v1",
    title: "text variables",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    ...(textVariables === undefined ? {} : { system: { textVariables } }),
    sheets: [{ id: "town", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}

describe("project.system.textVariables in a session", () => {
  const idle: SessionInput = { buttons: 0 };

  test("the flag reaches the world; absent keeps the braces", () => {
    for (const [flag, line] of [[true, "t=1"], [false, "t={v:t}"], [undefined, "t={v:t}"]] as const) {
      const p = project(flag);
      const sess = createSession(p);
      let s = startSession(p, sess);
      for (let i = 0; i < 40; i++) s = stepSession(sess, s, idle);
      expect(s.interp.modal).toMatchObject({ kind: "text", lines: [line] });
    }
  });

  test("the box opens at the same virtual time with the same text at 60/30/20/4 Hz", () => {
    // The 60 Hz reference tick that opens the box is 31 (0.5 s wait + 1);
    // a slower host shows it on the first frame that folds that tick.
    const seen: string[] = [];
    for (const hz of [60, 30, 20, 4]) {
      const p = project(true);
      const sess = createSession(p, hz);
      let s = startSession(p, sess);
      let opened = -1;
      for (let frame = 0; frame < hz * 2 && opened < 0; frame++) {
        s = stepSession(sess, s, idle);
        if (s.interp.modal) opened = frame + 1;
      }
      expect(opened).toBe(Math.ceil((31 * hz) / 60));
      seen.push(JSON.stringify(s.interp.modal && (s.interp.modal as { lines: string[] }).lines));
    }
    expect(seen).toEqual([seen[0]!, seen[0]!, seen[0]!, seen[0]!]);
    expect(seen[0]).toBe('["t=1"]');
  });
});
