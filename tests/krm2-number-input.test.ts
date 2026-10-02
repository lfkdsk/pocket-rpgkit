// tests/krm2-number-input.test.ts — built-in RPG Maker number input rules.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import type { ExtensionReadContext } from "../src/engine/extensions.ts";
import {
  NUMBER_INPUT_SCENE_ID,
  numberInputRules,
  numberInputText,
  type NumberInputState,
} from "../src/engine/number-input.ts";
import type { JsonValue, VariableValue } from "../src/engine/types.ts";

function context(variables: Record<string, VariableValue> = {}): ExtensionReadContext {
  return {
    ext: null,
    switches: {},
    variables,
    items: {},
    gold: 0,
    playerName: "Hero",
  };
}

function start(
  variables: Record<string, VariableValue> = {},
  args: JsonValue = { variable: "score", digits: 4 },
): NumberInputState {
  const started = numberInputRules.start({ marker: 1 }, args, 123, context(variables));
  if (started === null) throw new Error("number input did not start");
  return started.state as unknown as NumberInputState;
}

function step(
  state: NumberInputState,
  edges: { confirm?: boolean; cancel?: boolean; up?: boolean; down?: boolean; left?: boolean; right?: boolean } = {},
  buttons = 0,
  ticks = 1,
): NumberInputState {
  return numberInputRules.step(state as unknown as JsonValue, {
    buttons,
    confirmEdge: edges.confirm === true,
    cancelEdge: edges.cancel === true,
    upEdge: edges.up === true,
    downEdge: edges.down === true,
    leftEdge: edges.left === true,
    rightEdge: edges.right === true,
  }, ticks) as unknown as NumberInputState;
}

describe("KRM2 built-in number input", () => {
  test("exports the registered scene id and requires a variable destination", () => {
    expect(NUMBER_INPUT_SCENE_ID).toBe("rpgkit.numberInput");
    expect(numberInputRules.start(null, { digits: 4 }, 0, context())).toBeNull();
    expect(numberInputRules.start(null, { variable: "", digits: 4 }, 0, context())).toBeNull();
  });

  test("prefills a numeric variable, clamps it, and renders leading zeroes", () => {
    let state = start({ score: 42 });
    expect(state).toMatchObject({ variable: "score", digits: 4, value: 42, cursor: 0, phase: "edit" });
    expect(numberInputText(state)).toBe("0042");

    state = start({ score: -12 });
    expect(state.value).toBe(0);
    expect(numberInputText(state)).toBe("0000");

    state = start({ score: 100_000 }, { variable: "score", digits: 4 });
    expect(state.value).toBe(9_999);
    expect(numberInputText(state)).toBe("9999");

    state = start({ score: "not numeric" });
    expect(state.value).toBe(0);
  });

  test("digits clamp to 1..8 and non-integers use the one-digit default", () => {
    expect(start({}, { variable: "score", digits: 0 }).digits).toBe(1);
    expect(start({}, { variable: "score", digits: 9 }).digits).toBe(8);
    expect(start({}, { variable: "score", digits: 3.5 }).digits).toBe(1);
    expect(start({}, { variable: "score" }).digits).toBe(1);
    const eight = start({ score: 12_345_678 }, { variable: "score", digits: 8 });
    expect(numberInputText(eight)).toBe("12345678");
    expect(numberInputText(eight)).toHaveLength(8);
  });

  test("up/down wrap the selected digit and left/right wrap the cursor", () => {
    let state = start({ score: 123 }, { variable: "score", digits: 3 });
    state = step(state, { up: true });
    expect(state.value).toBe(223);
    state = step(state, { down: true });
    expect(state.value).toBe(123);

    state = step(state, { right: true });
    expect(state.cursor).toBe(1);
    state = step(state, { down: true });
    expect(state.value).toBe(113);
    state = step(state, { left: true });
    expect(state.cursor).toBe(0);
    state = step(state, { left: true });
    expect(state.cursor).toBe(2);
    state = step(state, { right: true });
    expect(state.cursor).toBe(0);

    state = start({ score: 900 }, { variable: "score", digits: 3 });
    state = step(state, { up: true });
    expect(state.value).toBe(0);
    state = step(state, { down: true });
    expect(state.value).toBe(900);
  });

  test("cancel is swallowed; confirm completes and writes a number", () => {
    let state = start({ score: 42 });
    state = step(state, { cancel: true });
    expect(state.phase).toBe("edit");
    expect(numberInputRules.done(state as unknown as JsonValue)).toBeNull();

    state = step(state, { confirm: true });
    expect(state.phase).toBe("done");
    expect(numberInputRules.done(state as unknown as JsonValue)).toEqual({
      ext: { marker: 1 },
      writes: { score: 42 },
    });
  });

  test("all held directions repeat identically at 60/30/20/4 Hz", () => {
    const cases = [
      { button: BTN.RIGHT, edge: { right: true }, pick: (s: NumberInputState) => [s.cursor, s.value] },
      { button: BTN.LEFT, edge: { left: true }, pick: (s: NumberInputState) => [s.cursor, s.value] },
      { button: BTN.UP, edge: { up: true }, pick: (s: NumberInputState) => [s.cursor, s.value] },
      { button: BTN.DOWN, edge: { down: true }, pick: (s: NumberInputState) => [s.cursor, s.value] },
    ] as const;

    for (const held of cases) {
      const outcomes = ([60, 30, 20, 4] as const).map((hz) => {
        const ticks = 60 / hz;
        let state = start({ score: 0 }, { variable: "score", digits: 8 });
        state = step(state, held.edge, held.button, ticks);
        for (let frame = 0; frame < hz; frame++) {
          state = step(state, {}, held.button, ticks);
        }
        return {
          selected: held.pick(state),
          holdDir: state.holdDir,
          holdTicks: state.holdTicks,
        };
      });
      for (const outcome of outcomes.slice(1)) expect(outcome).toEqual(outcomes[0]);
    }
  });

  test("releasing a held direction clears repeat phase", () => {
    let state = start({}, { variable: "score", digits: 4 });
    state = step(state, { right: true }, BTN.RIGHT);
    for (let tick = 0; tick < 29; tick++) state = step(state, {}, BTN.RIGHT);
    expect(state.cursor).toBe(1);
    state = step(state);
    expect(state).toMatchObject({ cursor: 1, holdDir: 0, holdTicks: 0 });
    for (let tick = 0; tick < 30; tick++) state = step(state);
    expect(state.cursor).toBe(1);
  });
});
