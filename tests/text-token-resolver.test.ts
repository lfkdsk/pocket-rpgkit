// tests/text-token-resolver.test.ts — the {x:<key>} token end to end: a
// session-registered resolver answers from live state (map id, variables,
// gold) when a box opens, the expanded modal survives save/restore, and the
// same tape replays byte-identically at any host rate.

import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../src/engine/session.ts";
import { canonicalJson, createSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { AttractController } from "../src/engine/attract.ts";
import type { TextTokenResolver, TextTokenView } from "../src/engine/player-name.ts";
import type { Command, GameEvent, JsonValue, MapDef, Project } from "../src/engine/types.ts";
import type { ExtensionOptions } from "../src/engine/extensions.ts";

/** The resolver the fixture games register: map id, a variable, formatted
 *  gold; "nope" is deliberately unanswered. */
const resolver: TextTokenResolver = (key: string, view: TextTokenView): string | undefined => {
  if (key === "map") return view.mapId;
  if (key === "coins") return String(view.variables.coins ?? 0);
  if (key === "gold") return `${view.gold} G`;
  if (key === "name") return view.playerName;
  return undefined;
};

function fixtureProject(): Project {
  const intro: GameEvent = {
    id: "intro",
    x: 1,
    y: 1,
    pages: [{
      trigger: "autorun",
      commands: [
        { op: "variable", id: "coins", set: { op: "set", value: 7 } },
        { op: "text", lines: ["Map {x:map}: {name} has {x:coins} coins and {x:gold}.", "Missing: {x:nope}."] },
        {
          op: "choices",
          prompt: "{x:map} pick",
          options: [
            { text: "{x:gold} yes", commands: [] },
            { text: "plain no", commands: [] },
          ],
        },
      ] as Command[],
    }],
  };
  const map: MapDef = {
    id: "town",
    name: "Town",
    width: 8,
    height: 8,
    sheets: ["town"],
    ground: Array(64).fill("town.0"),
    events: [intro],
  };
  return {
    format: "rpgkit-project/v1",
    title: "text tokens",
    tileSize: 16,
    start: { map: "town", x: 2, y: 2, dir: "down" },
    playerName: "Red",
    initialGold: 250,
    // Declaring system.textTokens is the explicit opt-in: it lists the keys
    // the resolver answers (rpgkit-check warns on others) and switches {x:}
    // expansion on. Without it the braces print verbatim, like pre-{x:} text.
    system: { textTokens: ["map", "coins", "gold", "name", "nope"] },
    sheets: [{ id: "town", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}

function boot(hz = 60, withResolver = true): { sess: Session; s: SessionState } {
  const sess = createSession(fixtureProject(), hz, withResolver ? { textTokens: resolver } : {});
  return { sess, s: startSession(fixtureProject(), sess) };
}

function step(sess: Session, s: SessionState, input: SessionInput = { buttons: 0 }): SessionState {
  return stepSession(sess, s, input);
}

/** Fold until a text modal is open (the fixture opens one on frame 1). */
function openTextBox(sess: Session, s: SessionState): SessionState {
  for (let i = 0; i < 10 && s.interp.modal?.kind !== "text"; i++) s = step(sess, s);
  expect(s.interp.modal?.kind).toBe("text");
  return s;
}

describe("{x:} tokens through the session", () => {
  test("text and choices expand from live session state", () => {
    const { sess, s } = boot();
    let next = openTextBox(sess, s);
    expect(next.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Map town: Red has 7 coins and 250 G.", "Missing: ???."],
    });
    // Close the text box: the first confirm finishes the typewriter, the
    // second closes it; the choices box then opens on the next fold.
    next = step(sess, next, { buttons: 0, confirmEdge: true });
    next = step(sess, next, { buttons: 0, confirmEdge: true });
    for (let i = 0; i < 10 && next.interp.modal?.kind !== "choices"; i++) next = step(sess, next);
    expect(next.interp.modal).toMatchObject({
      kind: "choices",
      prompt: "town pick",
      options: ["250 G yes", "plain no"],
    });
  });

  test("without a resolver {x:} shows the fallback", () => {
    const { sess, s } = boot(60, false);
    const next = openTextBox(sess, s);
    expect(next.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Map ???: Red has ??? coins and ???.", "Missing: ???."],
    });
  });

  test("without the system.textTokens declaration {x:} stays literal (old documents)", () => {
    // The review's counterexample: a document authored before {x:} existed
    // does not declare system.textTokens. Even with a resolver registered,
    // the braces must print verbatim — the same bytes the pre-{x:} runtime
    // produced — so the schema change is purely additive.
    const p = fixtureProject();
    delete p.system;
    const sess = createSession(p, 60, { textTokens: resolver });
    let next = openTextBox(sess, startSession(p, sess));
    expect(next.interp.modal).toMatchObject({
      kind: "text",
      lines: [
        "Map {x:map}: Red has {x:coins} coins and {x:gold}.",
        "Missing: {x:nope}.",
      ],
    });
    next = step(sess, next, { buttons: 0, confirmEdge: true });
    next = step(sess, next, { buttons: 0, confirmEdge: true });
    for (let i = 0; i < 10 && next.interp.modal?.kind !== "choices"; i++) next = step(sess, next);
    expect(next.interp.modal).toMatchObject({
      kind: "choices",
      prompt: "{x:map} pick",
      options: ["{x:gold} yes", "plain no"],
    });
  });

  test("a resolver is never called for text that carries no {x:}", () => {
    const p = fixtureProject();
    p.maps[0]!.events![0]!.pages[0]!.commands = [{ op: "text", lines: ["Hi {name}, plain text."] }];
    const throwing: TextTokenResolver = () => { throw new Error("resolver must not run"); };
    const sess = createSession(p, 60, { textTokens: throwing });
    let s = startSession(p, sess);
    s = openTextBox(sess, s);
    expect(s.interp.modal).toMatchObject({ lines: ["Hi Red, plain text."] });
  });
});

describe("{x:} determinism", () => {
  test("a restored save opens the same expanded box", () => {
    // Saves are only valid with no modal open, so save at frame 0, restore,
    // and let the autorun page open the box on the restored state: the
    // expansion is a pure function of that state and must come out identical.
    const { sess, s } = boot();
    const envelope = encodeEnvelope(createSnapshot(s.mapId, s.move, s.interp, s.frame));
    const restored = restoreSessionEnvelope(sess, envelope);
    const open = openTextBox(sess, restored);
    expect(open.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Map town: Red has 7 coins and 250 G.", "Missing: ???."],
    });
  });

  test("the same tape replays byte-identically twice", () => {
    // A fixed tape: open the box, confirm it closed, then idle. Run it twice
    // from fresh sessions and compare the canonical JSON of the state
    // projection at every step (snapshots are invalid while a box is open,
    // so the projection carries the modal — and its expanded lines — too).
    const tape: SessionInput[] = [
      { buttons: 0 },
      { buttons: 0 },
      { buttons: 0, confirmEdge: true },
      { buttons: 0 },
      { buttons: 0 },
    ];
    const projection = (s: SessionState): string =>
      canonicalJson({
        mapId: s.mapId,
        frame: s.frame,
        move: s.move,
        sw: s.sw,
        modal: s.interp.modal,
      });
    const run = (): string[] => {
      const { sess, s } = boot();
      const out: string[] = [];
      let cur = s;
      for (const input of tape) {
        cur = step(sess, cur, input);
        out.push(projection(cur));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  test("the resolver runs once per token when the box opens, not per frame", () => {
    let calls = 0;
    const counting: TextTokenResolver = (key, v) => {
      calls++;
      return resolver(key, v);
    };
    const sess = createSession(fixtureProject(), 60, { textTokens: counting });
    let s = startSession(fixtureProject(), sess);
    s = openTextBox(sess, s);
    // Line 1 carries {x:map}, {x:coins}, {x:gold}; line 2 carries {x:nope}:
    // four calls at open.
    expect(calls).toBe(4);
    // Idle with the box still open: the modal keeps its expanded strings,
    // so the resolver must not run again.
    for (let i = 0; i < 5; i++) s = step(sess, s);
    expect(calls).toBe(4);
  });

  test("expansion is identical at 60 Hz and 30 Hz", () => {
    const linesAt = (hz: number): readonly string[] => {
      const { sess, s } = boot(hz);
      const open = openTextBox(sess, s);
      return (open.interp.modal as { lines: readonly string[] }).lines;
    };
    expect(linesAt(60)).toEqual(linesAt(30));
    expect(linesAt(60)).toEqual(["Map town: Red has 7 coins and 250 G.", "Missing: ???."]);
  });
});

describe("{x:} resolver view: the game's own ext state", () => {
  // Tuxemon keeps its party in the game-owned extension state; the resolver
  // must be able to read it through the view without being able to mutate
  // the live session.
  interface PartyMon { name: string; level: number }
  const partyResolver: TextTokenResolver = (key, view) => {
    const ext = view.ext as { party?: PartyMon[] } | undefined;
    const leader = ext?.party?.[0];
    if (key === "leader") return leader ? `${leader.name} Lv${leader.level}` : undefined;
    if (key === "partySize") return String(ext?.party?.length ?? 0);
    return undefined;
  };

  function partyProject(): Project {
    const p = fixtureProject();
    p.system = { textTokens: ["leader", "partySize"] };
    p.maps[0]!.events![0]!.pages[0]!.commands = [
      { op: "text", lines: ["Leader: {x:leader} ({x:partySize} mon)."] },
    ] as Command[];
    return p;
  }

  function bootParty(ext: JsonValue): { sess: Session; s: SessionState } {
    const p = partyProject();
    const sess = createSession(p, 60, {
      textTokens: partyResolver,
      extensions: { initial: ext },
    });
    return { sess, s: startSession(p, sess) };
  }

  test("the resolver reads a Tuxemon-style party from view.ext", () => {
    const { sess, s } = bootParty({ party: [{ name: "Aardling", level: 5 }, { name: "Rockitten", level: 4 }] });
    const open = openTextBox(sess, s);
    expect(open.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Leader: Aardling Lv5 (2 mon)."],
    });
    // The live ext state is untouched and still there.
    expect((open.ext as unknown as { party: PartyMon[] }).party[0]).toEqual({ name: "Aardling", level: 5 });
  });

  test("the view is a frozen snapshot: a resolver cannot mutate live state", () => {
    // The resolver tries to write through both banks. The ext snapshot is
    // deep-frozen, so the write throws (strict mode); the variable bank is a
    // copy, so its write lands on the copy. Either way the live session
    // state must be unchanged after the box opens.
    let extWriteThrew = false;
    let varWriteThrew = false;
    const malicious: TextTokenResolver = (key, view) => {
      try {
        (view.ext as unknown as { party: PartyMon[] }).party[0]!.name = "HACKED";
      } catch {
        extWriteThrew = true;
      }
      try {
        (view.variables as Record<string, number>).coins = 999;
      } catch {
        varWriteThrew = true;
      }
      return partyResolver(key, view);
    };
    const p = partyProject();
    const sess = createSession(p, 60, {
      textTokens: malicious,
      extensions: { initial: { party: [{ name: "Aardling", level: 5 }] } },
    });
    let s = startSession(p, sess);
    s = openTextBox(sess, s);
    expect(extWriteThrew).toBe(true); // deep-frozen snapshot
    expect(varWriteThrew).toBe(false); // shallow copy, not frozen
    expect((s.ext as unknown as { party: PartyMon[] }).party[0]!.name).toBe("Aardling");
    expect(s.sw.variables.coins).toBeUndefined();
    // The expanded text still came from the unmutated snapshot.
    expect((s.interp.modal as { lines: string[] }).lines[0]).toBe("Leader: Aardling Lv5 (1 mon).");
  });

  test("the same tape with ext replays byte-identically twice", () => {
    const tape: SessionInput[] = [
      { buttons: 0 },
      { buttons: 0 },
      { buttons: 0, confirmEdge: true },
      { buttons: 0, confirmEdge: true },
      { buttons: 0 },
    ];
    const projection = (s: SessionState): string =>
      canonicalJson({ mapId: s.mapId, frame: s.frame, sw: s.sw, ext: s.ext, modal: s.interp.modal });
    const run = (): string[] => {
      const { sess, s } = bootParty({ party: [{ name: "Aardling", level: 5 }] });
      const out: string[] = [];
      let cur = s;
      for (const input of tape) {
        cur = step(sess, cur, input);
        out.push(projection(cur));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe("{x:} extChoice prompt is an open-box snapshot", () => {
  // The review's probe: an extChoice prompt carrying {x:} must expand ONCE
  // when the box opens, not once per tick while it stays up (the candidate
  // re-ran the resolver every refresh: Expected 1, Received 6).
  function extChoiceProject(parallelTicker: boolean): Project {
    const p = fixtureProject();
    p.system = { textTokens: ["rev", "leader"] };
    const events: GameEvent[] = [
      {
        id: "pick",
        x: 1,
        y: 1,
        pages: [{
          trigger: "autorun",
          commands: [
            { op: "extChoice", call: "demo.party", args: {}, prompt: "Rev {x:rev}", cancel: true },
          ] as Command[],
        }],
      },
    ];
    if (parallelTicker) {
      // A separate parallel event advances `rev` every frame while the box
      // is up, so the test can prove the prompt keeps its open-frame value
      // while the extension's dynamic rows still refresh.
      events.push({
        id: "tick",
        x: 2,
        y: 1,
        pages: [{
          trigger: "parallel",
          commands: [{ op: "variable", id: "rev", set: { op: "add", value: 1 } }],
        }],
      });
    }
    p.maps[0]!.events = events;
    return p;
  }

  function partyChoiceExtensions(): ExtensionOptions {
    return {
      choices: {
        "demo.party": {
          options: (ctx) => [{ key: "a", label: `Row ${ctx.variables.rev ?? 0}`, enabled: true }],
        },
      },
    };
  }

  function bootExtChoice(p: Project, resolver: TextTokenResolver): { sess: Session; s: SessionState } {
    const sess = createSession(p, 60, {
      textTokens: resolver,
      extensions: partyChoiceExtensions(),
    });
    return { sess, s: startSession(p, sess) };
  }

  function openChoiceBox(sess: Session, s: SessionState): SessionState {
    for (let i = 0; i < 10 && s.interp.modal?.kind !== "choices"; i++) s = step(sess, s);
    expect(s.interp.modal?.kind).toBe("choices");
    return s;
  }

  test("the resolver runs once at open, not per idle tick", () => {
    let calls = 0;
    const counting: TextTokenResolver = (key, v) => {
      calls++;
      return key === "rev" ? String(v.variables.rev ?? 0) : undefined;
    };
    const { sess, s } = bootExtChoice(extChoiceProject(false), counting);
    let next = openChoiceBox(sess, s);
    expect(calls).toBe(1); // one {x:rev} token, expanded once at open
    expect((next.interp.modal as { prompt: string }).prompt).toBe("Rev 0");
    for (let i = 0; i < 5; i++) next = step(sess, next);
    expect(calls).toBe(1); // idle with the box up: no re-expansion
  });

  test("the prompt keeps its open-frame value while state changes; rows still refresh", () => {
    const resolver: TextTokenResolver = (key, v) =>
      key === "rev" ? String(v.variables.rev ?? 0) : undefined;
    const { sess, s } = bootExtChoice(extChoiceProject(true), resolver);
    let next = openChoiceBox(sess, s);
    const modal = next.interp.modal as { prompt: string; options: string[] };
    const openedAt = modal.prompt;
    expect(openedAt).toMatch(/^Rev \d+$/);
    // The parallel ticker keeps advancing rev while the box is up.
    for (let i = 0; i < 5; i++) next = step(sess, next);
    const later = next.interp.modal as { prompt: string; options: string[] };
    expect(later.prompt).toBe(openedAt); // snapshot: no retype
    // The extension's dynamic rows DO refresh (they are not the prompt).
    expect(later.options[0]).not.toBe(modal.options[0]);
  });

  test("a restored save opens the same expanded prompt", () => {
    const resolver: TextTokenResolver = (key, v) =>
      key === "rev" ? String(v.variables.rev ?? 0) : undefined;
    const p = extChoiceProject(false);
    const { sess, s } = bootExtChoice(p, resolver);
    const envelope = encodeEnvelope(createSnapshot(s.mapId, s.move, s.interp, s.frame));
    const restored = restoreSessionEnvelope(sess, envelope);
    const open = openChoiceBox(sess, restored);
    expect((open.interp.modal as { prompt: string }).prompt).toBe("Rev 0");
  });

  test("an attract rewind re-fold opens the same expanded prompt", () => {
    // The prompt lives in the modal, so a rewind that re-folds across the
    // open frame must reproduce it byte-for-byte (the per-tick re-expansion
    // bug made this depend on when the fold happened to run).
    const resolver: TextTokenResolver = (key, v) =>
      key === "rev" ? String(v.variables.rev ?? 0) : undefined;
    const p = extChoiceProject(false);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 3 / 60,
      textTokens: resolver,
      extensions: partyChoiceExtensions(),
    });
    controller.startPlay();
    let st = controller.state;
    for (let i = 0; i < 10 && st.interp.modal?.kind !== "choices"; i++) {
      controller.step(0);
      st = controller.state;
    }
    const opened = (st.interp.modal as { prompt: string }).prompt;
    expect(opened).toBe("Rev 0");
    // L rewinds the timeline; re-fold back across the open frame.
    controller.step(0x0100);
    for (let i = 0; i < 10 && st.interp.modal?.kind !== "choices"; i++) {
      controller.step(0);
      st = controller.state;
    }
    expect((st.interp.modal as { prompt: string }).prompt).toBe(opened);
  });
});
