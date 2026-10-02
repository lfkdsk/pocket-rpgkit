// tests/fixtures/rmi-play/placeholder-battle.ts — the visible stand-in for
// RPG Maker's Battle Processing in imported projects. The importer turns
// each Battle Processing command into the kit's `battle` op with setup
// { troop, name, canEscape, canLose } and keeps the If Win / If Escape /
// If Lose branches; this rule set shows "a battle against <name> would
// happen here" and lets the player pick the outcome the branches need.
// Rows: Win, then Escape when canEscape, then Lose when canLose (without
// canLose MV's defeat is Game Over, which the placeholder does not offer).

import type { BattleRules, BattleResult } from "../../../src/engine/battle.ts";
import type { JsonValue } from "../../../src/engine/types.ts";

export interface PlaceholderBattleState {
  name: string;
  options: BattleResult[];
  index: number;
  chosen: BattleResult | null;
  /** The game's extension state, handed back unchanged on completion. */
  ext: JsonValue;
}

function setupOf(raw: JsonValue): { name: string; canEscape: boolean; canLose: boolean } {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const name = typeof o.name === "string" && o.name.length > 0
    ? o.name
    : `troop ${typeof o.troop === "number" ? o.troop : "?"}`;
  return { name, canEscape: o.canEscape === true, canLose: o.canLose === true };
}

export function placeholderState(state: JsonValue): PlaceholderBattleState {
  return state as unknown as PlaceholderBattleState;
}

export const placeholderBattleRules: BattleRules = {
  start(ext, rawSetup) {
    const setup = setupOf(rawSetup);
    const options: BattleResult[] = ["win"];
    if (setup.canEscape) options.push("escape");
    if (setup.canLose) options.push("lose");
    const state: PlaceholderBattleState = { name: setup.name, options, index: 0, chosen: null, ext };
    return { ext, state: state as unknown as JsonValue };
  },
  step(raw, input) {
    const s = placeholderState(raw);
    if (s.chosen) return raw;
    let index = s.index;
    if (input.downEdge) index = (index + 1) % s.options.length;
    if (input.upEdge) index = (index + s.options.length - 1) % s.options.length;
    const chosen = input.confirmEdge ? s.options[index]! : null;
    if (index === s.index && chosen === null) return raw;
    return { ...s, index, chosen } as unknown as JsonValue;
  },
  done(raw) {
    const s = placeholderState(raw);
    return s.chosen ? { ext: s.ext, result: s.chosen } : null;
  },
};
