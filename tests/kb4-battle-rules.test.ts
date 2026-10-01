// tests/kb4-battle-rules.test.ts — reducer-level proof for the demo
// BattleRules behind the KB4 sim fixture (tests/fixtures/kb4-battle/):
// pure start()/step()/done(), no sim host, no render. tests/kb4-battle-
// sim.test.ts then proves the same rules render correctly through the
// real GameView pipeline; this file is the fast, exhaustive check of the
// state machine itself (command grid, skill submenu, guard, escape,
// win/lose), mirroring tests/battle.test.ts's own style for KB2.

import { describe, expect, test } from "bun:test";
import type { BattleInput } from "../src/engine/battle.ts";
import type { ExtensionReadContext } from "../src/engine/extensions.ts";
import type { JsonValue } from "../src/engine/types.ts";
import {
  demoState,
  enemyEffect,
  enemyHpTween,
  kb4BattleRules,
  messageRevealed,
  playerEffect,
  playerHpTween,
  SKILLS,
  type DemoBattleState,
} from "../tests/fixtures/kb4-battle/rules.ts";

/** The demo rules read nothing from the session; start() still gets the
 *  read-only context every BattleRules implementation receives. */
const CONTEXT: ExtensionReadContext = { ext: null, switches: {}, variables: {}, items: {}, gold: 0, playerName: "Player" };

const BTN_UP = 0x0010;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_LEFT = 0x0080;
const BTN_LTRIGGER = 0x0100;
const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;
void BTN_LTRIGGER;

// Each call stands for one discrete host frame with a fresh press (this
// suite never holds a button across two calls except LEFT/RIGHT, which the
// ruleset edge-detects itself from `buttons` — see the "held direction"
// test), so up/down/confirm/cancel edges are derived straight from the
// mask, exactly like GameView derives them for a live frame.
function input(buttons: number, edges: Partial<BattleInput> = {}): BattleInput {
  return {
    buttons,
    confirmEdge: (buttons & BTN_CIRCLE) !== 0,
    cancelEdge: (buttons & BTN_CROSS) !== 0,
    upEdge: (buttons & BTN_UP) !== 0,
    downEdge: (buttons & BTN_DOWN) !== 0,
    ...edges,
  };
}

/** Step until the current beat's gate is open (a caller-supplied number of
 *  reference ticks, always generous relative to any message length here),
 *  then confirm once to advance past it. */
function clearBeat(state: JsonValue, ticks = 200): JsonValue {
  const waited = kb4BattleRules.step(state, input(0), ticks);
  return kb4BattleRules.step(waited, input(BTN_CIRCLE), 1);
}

function boot(setup: JsonValue = {}, seed = 0x1234_5678): JsonValue {
  const started = kb4BattleRules.start(null, setup, seed, CONTEXT);
  if (!started) throw new Error("kb4BattleRules.start returned null");
  return started.state;
}

/** From a fresh start(), clear the intro beat and land on the command grid. */
function toCommand(setup: JsonValue = {}, seed = 0x1234_5678): JsonValue {
  return clearBeat(boot(setup, seed));
}

describe("kb4BattleRules: start/lifecycle", () => {
  test("start() opens on an intro beat naming both fighters", () => {
    const state = demoState(boot({ playerName: "Ash", enemyName: "Gary" }));
    expect(state.phase).toBe("beat");
    expect(state.message).toBe("A wild Gary appears!");
    expect(state.player.name).toBe("Ash");
    expect(state.enemy.name).toBe("Gary");
  });

  test("start() with setup.skip returns null (KB2 resumes the fiber immediately)", () => {
    expect(kb4BattleRules.start(null, { skip: true }, 1, CONTEXT)).toBeNull();
  });

  test("the intro beat clears onto the command grid at commandIndex 0", () => {
    const state = demoState(toCommand());
    expect(state.phase).toBe("command");
    expect(state.commandIndex).toBe(0);
  });

  test("a beat cannot be confirmed away before its gate opens", () => {
    const intro = boot();
    const early = kb4BattleRules.step(intro, input(BTN_CIRCLE), 1);
    expect(demoState(early).phase).toBe("beat");
  });

  test("is a pure function: the same state/input/ticks always steps identically", () => {
    const state = toCommand();
    const a = kb4BattleRules.step(state, input(BTN_UP), 1);
    const b = kb4BattleRules.step(state, input(BTN_UP), 1);
    expect(a).toEqual(b);
    // The input state itself must never be mutated in place (a rewind
    // replays it from a frozen snapshot).
    expect(state).toEqual(toCommand());
  });
});

describe("kb4BattleRules: command grid navigation", () => {
  test("up/down flips row (Fight<->Guard, Skill<->Run), wrapping through the other row", () => {
    let state = toCommand();
    state = kb4BattleRules.step(state, input(BTN_UP), 1);
    expect(demoState(state).commandIndex).toBe(2); // Guard
    state = kb4BattleRules.step(state, input(BTN_DOWN), 1);
    expect(demoState(state).commandIndex).toBe(0); // back to Fight
  });

  test("left/right flips column within the row (raw BTN.LEFT/RIGHT, not a BattleInput edge)", () => {
    let state = toCommand();
    state = kb4BattleRules.step(state, input(BTN_RIGHT), 1);
    expect(demoState(state).commandIndex).toBe(1); // Skill
    state = kb4BattleRules.step(state, input(BTN_LEFT), 1);
    expect(demoState(state).commandIndex).toBe(0); // Fight
  });

  test("held direction does not repeat without a fresh press edge", () => {
    let state = toCommand();
    state = kb4BattleRules.step(state, input(BTN_RIGHT), 1);
    // Still held next frame: lastButtons already has BTN_RIGHT, so `pressed`
    // (buttons & ~lastButtons) is 0 and the index must not move again.
    state = kb4BattleRules.step(state, input(BTN_RIGHT), 1);
    expect(demoState(state).commandIndex).toBe(1);
  });
});

describe("kb4BattleRules: Fight and HP/effect derivation", () => {
  test("Fight deals instant damage; the enemy tween/effect only exist during that beat", () => {
    const command = toCommand({ enemyHp: 999, enemyName: "Target" });
    const before = demoState(command).enemy.hp;
    const attacked = kb4BattleRules.step(command, input(BTN_CIRCLE), 1);
    const state = demoState(attacked);
    expect(state.phase).toBe("beat");
    expect(state.enemy.hp).toBeLessThan(before); // damage already committed
    expect(state.message).toMatch(/^Rockitten used Tackle!\nDealt \d+ damage\.$/);

    const tween = enemyHpTween(state);
    expect(tween.from).toBe(before);
    expect(tween.to).toBe(state.enemy.hp);
    expect(enemyEffect(state).kind).toBe("shake");
    expect(playerEffect(state).kind).toBe("none"); // only the enemy was hit

    // Outside a beat targeting it, a fighter's tween settles (from === to):
    // the presentation layer never needs an "is this actor mid-beat" branch.
    // The enemy survives (999 hp), so clearing its hit beat immediately
    // opens the enemy's own retaliation beat; clear that too to land back
    // on the command grid.
    const settled = demoState(clearBeat(clearBeat(attacked)));
    expect(settled.phase).toBe("command");
    const idleTween = enemyHpTween(settled);
    expect(idleTween.from).toBe(idleTween.to);
    expect(enemyEffect(settled).kind).toBe("none");
  });

  test("messageRevealed grows with nowTick and caps at the message length", () => {
    const command = toCommand({ enemyHp: 999 });
    const attacked = demoState(kb4BattleRules.step(command, input(BTN_CIRCLE), 1));
    const total = attacked.message.length;
    const mid = demoState(kb4BattleRules.step(kb4BattleRules.step(command, input(BTN_CIRCLE), 1), input(0), 3));
    expect(messageRevealed(mid)).toBe(Math.min(total, 3));
    const done = demoState(kb4BattleRules.step(kb4BattleRules.step(command, input(BTN_CIRCLE), 1), input(0), 999));
    expect(messageRevealed(done)).toBe(total);
  });

  test("a one-hit kill (enemyHp <= Tackle's minimum roll) chains faint -> win message -> win", () => {
    // Tackle deals 4 + [0,2]; enemyHp 4 guarantees a kill on any roll.
    let state = toCommand({ enemyHp: 4 });
    state = kb4BattleRules.step(state, input(BTN_CIRCLE), 1); // Fight
    expect(demoState(state).enemy.hp).toBe(0);
    expect(demoState(state).afterBeat).toBe("checkEnemyFaint");

    state = clearBeat(state);
    expect(demoState(state).message).toBe("Budaye fainted!");
    expect(enemyEffect(demoState(state)).kind).toBe("faint");
    expect(demoState(state).afterBeat).toBe("winMessage");

    state = clearBeat(state);
    expect(demoState(state).message).toBe("You win!");
    expect(demoState(state).afterBeat).toBe("win");
    expect(demoState(state).phase).toBe("beat");

    state = clearBeat(state);
    expect(demoState(state).phase).toBe("done");
    expect(demoState(state).pending).toBe("win");

    const completion = kb4BattleRules.done(state);
    expect(completion).not.toBeNull();
    expect(completion!.result).toBe("win");
    expect(completion!.writes).toEqual({ "kb4.result": "win", "kb4.turns": 1 });
    expect(completion!.switches).toEqual({ "kb4.result.win": true });
  });

  test("done() is null before the battle settles into phase 'done'", () => {
    expect(kb4BattleRules.done(toCommand())).toBeNull();
  });

  test("a fully-elapsed faint effect holds its sunk, transparent end pose (never re-appears)", () => {
    let state = toCommand({ enemyHp: 4 });
    state = kb4BattleRules.step(state, input(BTN_CIRCLE), 1);
    state = clearBeat(state); // -> faint beat
    // Step deep past the faint window without confirming: still "faint".
    const overshot = demoState(kb4BattleRules.step(state, input(0), 5_000));
    expect(overshot.phase).toBe("beat");
    expect(enemyEffect(overshot).kind).toBe("faint");
  });
});

describe("kb4BattleRules: skill submenu", () => {
  test("Skill opens the list at index 0, including the disabled 'Overload' row", () => {
    let state = toCommand();
    state = kb4BattleRules.step(state, input(BTN_RIGHT), 1); // -> Skill cell
    state = kb4BattleRules.step(state, input(BTN_CIRCLE), 1);
    expect(demoState(state).phase).toBe("skills");
    expect(demoState(state).skillIndex).toBe(0);
    expect(SKILLS.map((s) => s.name)).toEqual(["Ember", "Slash", "Overload"]);
    expect(SKILLS[2]!.disabled).toBe(true);
  });

  test("up/down clamp at the list bounds instead of wrapping", () => {
    let state = kb4BattleRules.step(
      kb4BattleRules.step(toCommand(), input(BTN_RIGHT), 1),
      input(BTN_CIRCLE),
      1,
    );
    state = kb4BattleRules.step(state, input(BTN_UP), 1);
    expect(demoState(state).skillIndex).toBe(0); // already at top
    for (let i = 0; i < 5; i++) state = kb4BattleRules.step(state, input(BTN_DOWN), 1);
    expect(demoState(state).skillIndex).toBe(SKILLS.length - 1); // clamped, not wrapped
  });

  test("confirming the disabled skill is a no-op; confirming an enabled one attacks", () => {
    let state = kb4BattleRules.step(
      kb4BattleRules.step(toCommand({ enemyHp: 999 }), input(BTN_RIGHT), 1),
      input(BTN_CIRCLE),
      1,
    );
    // Move to "Overload" (index 2) and confirm: no turn spent, no beat.
    state = kb4BattleRules.step(state, input(BTN_DOWN), 1);
    state = kb4BattleRules.step(state, input(BTN_DOWN), 1);
    expect(demoState(state).skillIndex).toBe(2);
    const beforeHp = demoState(state).enemy.hp;
    state = kb4BattleRules.step(state, input(BTN_CIRCLE), 1);
    expect(demoState(state).phase).toBe("skills"); // stayed open
    expect(demoState(state).enemy.hp).toBe(beforeHp);

    // Back to "Ember" and confirm: a real Ember attack (power 5, [5,7] dmg).
    state = kb4BattleRules.step(state, input(BTN_UP), 1);
    state = kb4BattleRules.step(state, input(BTN_UP), 1);
    state = kb4BattleRules.step(state, input(BTN_CIRCLE), 1);
    expect(demoState(state).phase).toBe("beat");
    expect(demoState(state).message).toMatch(/^Rockitten used Ember!/);
    expect(demoState(state).enemy.hp).toBeLessThan(beforeHp);
  });

  test("BTN.CROSS backs out of the skill list without spending a turn", () => {
    let state = kb4BattleRules.step(
      kb4BattleRules.step(toCommand({ enemyHp: 999 }), input(BTN_RIGHT), 1),
      input(BTN_CIRCLE),
      1,
    );
    expect(demoState(state).phase).toBe("skills");
    state = kb4BattleRules.step(state, input(BTN_CROSS), 1);
    expect(demoState(state).phase).toBe("command");
    expect(demoState(state).turn).toBe(0);
  });
});

describe("kb4BattleRules: Guard halves the next hit", () => {
  test("guarding=true roughly halves the same rng draw as guarding=false", () => {
    const base: DemoBattleState = demoState(toCommand({ enemyHp: 999 })) as DemoBattleState;
    const beat = (guarding: boolean): DemoBattleState => ({
      ...base,
      guarding,
      phase: "beat",
      beatStart: 0,
      beatDuration: 1,
      afterBeat: "enemyTurn",
    });
    const guarded = demoState(kb4BattleRules.step(beat(true) as unknown as JsonValue, input(BTN_CIRCLE), 1));
    const unguarded = demoState(kb4BattleRules.step(beat(false) as unknown as JsonValue, input(BTN_CIRCLE), 1));
    const guardedDmg = base.player.hp - guarded.player.hp;
    const unguardedDmg = base.player.hp - unguarded.player.hp;
    // Same rng seed/state going in (`beat()` only changes `guarding`), so
    // the raw roll is identical; guarding must floor-halve it.
    expect(guardedDmg).toBe(Math.max(1, Math.floor(unguardedDmg / 2)));
    expect(guarded.guarding).toBe(false); // consumed on use
  });
});

describe("kb4BattleRules: Run (escape)", () => {
  test("succeeding sets pending 'escape'; failing gives the enemy its turn instead", () => {
    // Two seeds: findEscapeSeed brute-forces one of each outcome so the test
    // does not depend on the exact escape-roll constant staying at 50%.
    function afterRun(seed: number): DemoBattleState {
      let state = toCommand({}, seed);
      state = kb4BattleRules.step(state, input(BTN_DOWN), 1); // -> Guard
      state = kb4BattleRules.step(state, input(BTN_RIGHT), 1); // -> Run
      return demoState(kb4BattleRules.step(state, input(BTN_CIRCLE), 1)) as DemoBattleState;
    }
    let escaped: DemoBattleState | null = null;
    let failed: DemoBattleState | null = null;
    for (let seed = 1; seed < 200 && (!escaped || !failed); seed++) {
      const after = afterRun(seed);
      if (after.afterBeat === "escape" && !escaped) escaped = after;
      if (after.afterBeat === "enemyTurn" && !failed) failed = after;
    }
    expect(escaped).not.toBeNull();
    expect(escaped!.message).toBe("Got away safely!");
    expect(failed).not.toBeNull();
    expect(failed!.message).toBe("Couldn't escape!");

    const settled = demoState(clearBeat(escaped as unknown as JsonValue));
    expect(settled.phase).toBe("done");
    expect(settled.pending).toBe("escape");
  });
});
