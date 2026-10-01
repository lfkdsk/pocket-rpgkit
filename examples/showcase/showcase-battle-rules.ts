// Pure, game-owned battle reducer for showcase hall 6. Kept separate from
// the TSX scene so generators and engine-only tests never load a JSX runtime.

import type { BattleCompletion, BattleResult, BattleRules } from "../../src/engine/battle.ts";
import type { JsonValue } from "../../src/engine/types.ts";

const BTN_RIGHT = 0x0020;
const BTN_LEFT = 0x0080;

export interface ShowcaseBattleSetup {
  playerHp?: number;
  enemyHp?: number;
}

export interface ShowcaseBattleState {
  nowTick: number;
  lastButtons: number;
  phase: "command" | "message" | "done";
  commandIndex: number;
  playerHp: number;
  playerMaxHp: number;
  enemyHp: number;
  enemyMaxHp: number;
  turns: number;
  message: string;
  messageStart: number;
  readyTick: number;
  afterMessage: "command" | "done";
  pending: BattleResult | null;
  ext: JsonValue;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function positiveHp(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function showcaseBattleState(value: JsonValue): Readonly<ShowcaseBattleState> {
  return value as unknown as ShowcaseBattleState;
}

function jsonState(value: ShowcaseBattleState): JsonValue {
  return value as unknown as JsonValue;
}

function beginMessage(
  state: ShowcaseBattleState,
  message: string,
  afterMessage: "command" | "done",
  pending: BattleResult | null = null,
): void {
  state.phase = "message";
  state.message = message;
  state.messageStart = state.nowTick;
  state.readyTick = state.nowTick + Math.max(12, message.length);
  state.afterMessage = afterMessage;
  state.pending = pending;
}

function finish(state: ShowcaseBattleState, result: Exclude<BattleResult, "draw">, message: string): void {
  if (result === "win") state.enemyHp = 0;
  if (result === "lose") state.playerHp = 0;
  beginMessage(state, message, "done", result);
}

export const showcaseBattleRules: BattleRules = {
  start(ext, rawSetup) {
    const setup = record(rawSetup);
    const playerHp = positiveHp(setup.playerHp, 12);
    const enemyHp = positiveHp(setup.enemyHp, 8);
    return {
      ext,
      state: jsonState({
        nowTick: 0,
        lastButtons: 0,
        phase: "command",
        commandIndex: 0,
        playerHp,
        playerMaxHp: playerHp,
        enemyHp,
        enemyMaxHp: enemyHp,
        turns: 0,
        message: "",
        messageStart: 0,
        readyTick: 0,
        afterMessage: "command",
        pending: null,
        ext,
      }),
    };
  },

  step(rawState, input, ticks) {
    const previous = showcaseBattleState(rawState);
    const state: ShowcaseBattleState = { ...previous, nowTick: previous.nowTick + ticks };
    const pressed = input.buttons & ~previous.lastButtons;
    state.lastButtons = input.buttons >>> 0;

    if (state.phase === "done") return jsonState(state);
    if (state.phase === "message") {
      if (state.nowTick >= state.readyTick && input.confirmEdge) {
        if (state.afterMessage === "done") state.phase = "done";
        else {
          state.phase = "command";
          state.message = "";
        }
      }
      return jsonState(state);
    }

    if (input.upEdge || input.downEdge) {
      state.commandIndex = state.commandIndex < 2 ? state.commandIndex + 2 : state.commandIndex - 2;
    }
    if ((pressed & BTN_LEFT) !== 0 || (pressed & BTN_RIGHT) !== 0) {
      state.commandIndex = state.commandIndex % 2 === 0 ? state.commandIndex + 1 : state.commandIndex - 1;
    }

    if (input.cancelEdge) {
      state.turns++;
      finish(state, "escape", "You leave the arena safely.");
      return jsonState(state);
    }
    if (!input.confirmEdge) return jsonState(state);

    state.turns++;
    if (state.commandIndex === 0) {
      const damage = Math.min(5, state.enemyHp);
      state.enemyHp -= damage;
      if (state.enemyHp === 0) {
        finish(state, "win", `Your strike deals ${damage} damage.\nThe training shade falls!`);
      } else {
        const counter = Math.min(3, state.playerHp);
        state.playerHp -= counter;
        if (state.playerHp === 0) finish(state, "lose", "The shade's counter knocks you down.");
        else beginMessage(state, `You deal ${damage} damage.\nThe shade answers for ${counter}.`, "command");
      }
    } else if (state.commandIndex === 1) {
      finish(state, "lose", "You yield. The curator ends the bout.");
    } else if (state.commandIndex === 2) {
      const healed = Math.min(2, state.playerMaxHp - state.playerHp);
      state.playerHp += healed;
      beginMessage(state, healed > 0 ? `You guard and recover ${healed} HP.` : "You hold a perfect guard.", "command");
    } else {
      finish(state, "escape", "You dash through the arena gate.");
    }
    return jsonState(state);
  },

  done(rawState): BattleCompletion | null {
    const state = showcaseBattleState(rawState);
    if (state.phase !== "done" || state.pending === null) return null;
    return {
      ext: state.ext,
      result: state.pending,
      writes: {
        "showcase.battleResult": state.pending,
        "showcase.battleTurns": state.turns,
      },
      switches: { [`showcase.battle.${state.pending}`]: true },
    };
  },
};
