// tests/player-name.test.ts — the {name} token: pure substitution, reducer
// expansion in text and choices, the configurable project default, and save
// round-trip.

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import {
  DEFAULT_PLAYER_NAME,
  NAME_TOKEN,
  UNKNOWN_TEXT_TOKEN,
  expandTextLines,
  expandTextTokens,
  substitutePlayerName,
  type TextTokenResolver,
  type TextTokenView,
} from "../src/engine/player-name.ts";
import {
  canonicalJson,
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  fnv1aText,
} from "../src/engine/save.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

// --- pure substitution ------------------------------------------------------

describe("substitutePlayerName", () => {
  test("replaces every token and leaves other braces alone", () => {
    expect(substitutePlayerName("Hi {name}!", "Red")).toBe("Hi Red!");
    expect(substitutePlayerName("{name}/{name}", "Red")).toBe("Red/Red");
    expect(substitutePlayerName("{other} and {name}", "Red")).toBe("{other} and Red");
    expect(substitutePlayerName("no token", "Red")).toBe("no token");
  });

  test("a name that contains the token is substituted once (it terminates)", () => {
    // {name} with name "a{name}b" -> "aa{name}bb" is NOT rescanned, so the
    // expansion always terminates even if a future rename op sets such a name.
    expect(substitutePlayerName("{name}", `a${NAME_TOKEN}b`)).toBe(`a${NAME_TOKEN}b`);
  });
});

// --- reducer expansion ------------------------------------------------------

const MAP_ID = "v";
function world(commands: Command[]) {
  const ev: GameEvent = {
    id: "e",
    x: 10,
    y: 10,
    pages: [{ trigger: "autorun", commands }],
  };
  const map: MapDef = {
    id: MAP_ID,
    name: "t",
    width: 20,
    height: 13,
    sheets: ["town"],
    ground: Array(20 * 13).fill("town.0"),
    events: [ev],
  };
  return createWorld(map, [], 60);
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

describe("{name} in the reducer", () => {
  test("a text modal shows the banked player name and counts reveal over it", () => {
    const w = world([{ op: "text", lines: ["Hey {name}."], cps: 30 }]);
    let s = createInterpState(createSwitchState({ playerName: "Red" }));
    s = stepInterp(w, s, noEdges);
    expect(s.modal).toMatchObject({ kind: "text", lines: ["Hey Red."] });
    // "Hey Red." is 8 chars; total must reflect the EXPANDED text, not the
    // 12-character authored "Hey {name}.".
    expect((s.modal as { total: number }).total).toBe(8);
  });

  test("absent playerName falls back to the default", () => {
    const w = world([{ op: "text", lines: ["{name}"] }]);
    let s = createInterpState();
    s.sw.playerName = undefined as unknown as string;
    s = stepInterp(w, s, noEdges);
    expect(s.modal).toMatchObject({ lines: [DEFAULT_PLAYER_NAME] });
  });

  test("choices prompt and options expand the token", () => {
    const w = world([{
      op: "choices",
      prompt: "{name}, pick",
      options: [
        { text: "I am {name}", commands: [] },
        { text: "no name", commands: [] },
      ],
    }]);
    let s = createInterpState(createSwitchState({ playerName: "Ada" }));
    s = stepInterp(w, s, noEdges);
    expect(s.modal).toMatchObject({
      kind: "choices",
      prompt: "Ada, pick",
      options: ["I am Ada", "no name"],
    });
  });
});

// --- project default --------------------------------------------------------

function baseProject(playerName?: string): Project {
  const map: MapDef = {
    id: "m",
    name: "m",
    width: 8,
    height: 8,
    sheets: ["town"],
    ground: Array(64).fill("town.0"),
    events: [],
  };
  return {
    format: "rpgkit-project/v1",
    title: "name test",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    ...(playerName !== undefined ? { playerName } : {}),
    sheets: [{ id: "town", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}

describe("player name session seeding", () => {
  test("a fresh session uses project.playerName, else the built-in default", () => {
    const named = createSession(baseProject("Red"));
    expect(startSession(baseProject("Red"), named).sw.playerName).toBe("Red");
    const def = createSession(baseProject());
    expect(startSession(baseProject(), def).sw.playerName).toBe(DEFAULT_PLAYER_NAME);
  });

  test("a restored switch bank keeps its saved name over the project default", () => {
    const p = baseProject("Red");
    const sess = createSession(p);
    const saved = createSwitchState({ playerName: "Ghost" });
    expect(startSession(p, sess, saved).sw.playerName).toBe("Ghost");
  });
});

// --- save round-trip --------------------------------------------------------

describe("player name saves", () => {
  test("the name is carried byte-for-byte through an envelope", () => {
    const interp = createInterpState(createSwitchState({ playerName: "Red" }));
    const snap = createSnapshot("m", {
      tx: 0, ty: 0, px: 0, py: 0, facing: 0, phase: 0, moving: false,
      walking: false, stepDir: 0,
    }, interp, 0);
    const loaded = decodeEnvelopeText(encodeEnvelope(snap));
    expect(loaded.interp.sw.playerName).toBe("Red");
  });

  test("a checksum-valid bank with a bad name is rejected", () => {
    const interp = createInterpState();
    const snap = createSnapshot("m", {
      tx: 0, ty: 0, px: 0, py: 0, facing: 0, phase: 0, moving: false,
      walking: false, stepDir: 0,
    }, interp, 0);
    const env = JSON.parse(encodeEnvelope(snap)) as {
      format: string; version: number; checksum: string; state: any;
    };
    env.state.interp.sw.playerName = "";
    env.checksum = fnv1aText(canonicalJson(env.state));
    expect(() => decodeEnvelopeText(JSON.stringify(env))).toThrow(/playerName/);
  });
});

// --- {x:} game-provided text tokens -----------------------------------------

const view: TextTokenView = { playerName: "Red", variables: { coins: 7 }, gold: 250, mapId: "town" };

describe("expandTextTokens {x:}", () => {
  test("expands {x:} through the resolver in the same left-to-right pass", () => {
    const seen: string[] = [];
    const resolver: TextTokenResolver = (key, v) => {
      seen.push(key);
      if (key === "map") return v.mapId;
      if (key === "gold") return `${v.gold}G`;
      if (key === "who") return v.playerName;
      return undefined;
    };
    const out = expandTextTokens("[{x:map}] {name} has {x:gold} ({x:who}, {x:nope})", "Red", null, resolver, view);
    expect(out).toBe("[town] Red has 250G (Red, ???)");
    expect(seen).toEqual(["map", "gold", "who", "nope"]);
  });

  test("the view is the live session slice: variables, gold, map id", () => {
    const resolver: TextTokenResolver = (key, v) =>
      key === "v" ? String(v.variables.coins) : key === "g" ? String(v.gold) : key === "m" ? v.mapId : undefined;
    expect(expandTextTokens("{x:v}/{x:g}/{x:m}", "Red", { coins: 7 }, resolver, view)).toBe("7/250/town");
  });

  test("an unanswered key (resolver returns undefined) shows the fallback", () => {
    const resolver: TextTokenResolver = () => undefined;
    expect(expandTextTokens("a{x:date}b", "Red", null, resolver, view)).toBe(`a${UNKNOWN_TEXT_TOKEN}b`);
    expect(expandTextTokens("{x:}", "Red", null, resolver, view)).toBe(UNKNOWN_TEXT_TOKEN);
  });

  test("without a resolver {x:} shows the fallback and {v:} keeps its gate", () => {
    // No resolver: {x:} -> ??? regardless of the textVariables gate.
    expect(expandTextTokens("{x:date}", "Red", null)).toBe(UNKNOWN_TEXT_TOKEN);
    expect(expandTextTokens("{x:date}", "Red", { coins: 7 })).toBe(UNKNOWN_TEXT_TOKEN);
    // {v:} still needs the variables argument; {name} still substitutes.
    expect(expandTextTokens("{name}: {x:date} {v:coins}", "Red", null)).toBe(`Red: ${UNKNOWN_TEXT_TOKEN} {v:coins}`);
    expect(expandTextTokens("{name}: {x:date} {v:coins}", "Red", { coins: 7 })).toBe(`Red: ${UNKNOWN_TEXT_TOKEN} 7`);
  });

  test("a resolver answer containing a token is printed literally (one pass)", () => {
    const resolver: TextTokenResolver = (key) => (key === "inject" ? "{name}{x:date}" : undefined);
    expect(expandTextTokens("{x:inject}", "Red", null, resolver, view)).toBe("{name}{x:date}");
  });

  test("text without {x:} is unchanged from the pre-{x:} behavior", () => {
    // With a resolver registered but no {x:} in the text, output is exactly
    // the {name}/{v:} path (and the resolver is never called).
    const resolver: TextTokenResolver = () => { throw new Error("must not be called"); };
    expect(expandTextTokens("Hi {name}, {v:coins}!", "Red", { coins: 7 }, resolver, view))
      .toBe("Hi Red, 7!");
    expect(expandTextTokens("plain", "Red", null, resolver, view)).toBe("plain");
  });

  test("an unclosed token passes through verbatim", () => {
    const resolver: TextTokenResolver = () => "x";
    expect(expandTextTokens("a {x:date b", "Red", null, resolver, view)).toBe("a {x:date b");
    expect(expandTextTokens("a {x:date b", "Red", null)).toBe("a {x:date b");
  });

  test("expandTextLines carries the resolver to every line", () => {
    const resolver: TextTokenResolver = (key, v) => (key === "map" ? v.mapId : undefined);
    expect(expandTextLines(["{x:map}", "no token", "{x:nope}"], "Red", null, resolver, view))
      .toEqual(["town", "no token", UNKNOWN_TEXT_TOKEN]);
  });

  test("without the system.textTokens opt-in {x:} stays literal, even with a resolver", () => {
    // A project that does not declare system.textTokens keeps the pre-{x:}
    // behavior: the braces print verbatim, the resolver is never called, and
    // {name}/{v:} expand as before. This is what keeps the schema change
    // additive (the review's old-document counterexample).
    const resolver: TextTokenResolver = () => { throw new Error("resolver must not run without the opt-in"); };
    expect(expandTextTokens("{x:date}", "Red", null, resolver, view, false)).toBe("{x:date}");
    expect(expandTextTokens("a {x:date b", "Red", null, resolver, view, false)).toBe("a {x:date b");
    expect(expandTextTokens("{name}: {x:date} {v:coins}", "Red", { coins: 7 }, resolver, view, false))
      .toBe("Red: {x:date} 7");
    expect(expandTextTokens("{name}: {x:date} {v:coins}", "Red", null, resolver, view, false))
      .toBe("Red: {x:date} {v:coins}");
    expect(expandTextLines(["{x:map}", "{name}"], "Red", null, resolver, view, false))
      .toEqual(["{x:map}", "Red"]);
  });
});
