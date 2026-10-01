// Game-owned extension state for showcase hall 5. Every handler is a pure
// transformation over reducer-owned JSON; no UI signal or host state enters
// the session, so save/load, replay, and rewind see the same choices.

import type { ExtensionOptions } from "../../src/engine/extensions.ts";
import type { JsonValue } from "../../src/engine/types.ts";

interface ShowcaseExtensionState {
  visits: number;
  completed: number;
  selections: string[];
  cancellations: number;
  lastChoice: string | null;
}

const INITIAL_STATE: ShowcaseExtensionState = {
  visits: 0,
  completed: 0,
  selections: [],
  cancellations: 0,
  lastChoice: null,
};

function stateOf(value: JsonValue): Readonly<ShowcaseExtensionState> {
  return value as unknown as ShowcaseExtensionState;
}

function jsonState(value: ShowcaseExtensionState): JsonValue {
  return value as unknown as JsonValue;
}

function validState(value: JsonValue): boolean | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "showcase extension state must be an object";
  }
  const state = value as unknown as Partial<ShowcaseExtensionState>;
  if (!Number.isSafeInteger(state.visits) || state.visits! < 0) return "visits must be a non-negative integer";
  if (!Number.isSafeInteger(state.completed) || state.completed! < 0) return "completed must be a non-negative integer";
  if (!Number.isSafeInteger(state.cancellations) || state.cancellations! < 0) {
    return "cancellations must be a non-negative integer";
  }
  if (!Array.isArray(state.selections) || !state.selections.every((entry) => typeof entry === "string")) {
    return "selections must be a string array";
  }
  if (state.lastChoice !== null && typeof state.lastChoice !== "string") {
    return "lastChoice must be a string or null";
  }
  return true;
}

export const SHOWCASE_EXTENSIONS: ExtensionOptions = {
  initial: jsonState(INITIAL_STATE),
  validate: validState,
  commands: {
    "showcase.begin_choice"(context) {
      const current = stateOf(context.ext);
      const visits = current.visits + 1;
      return {
        ext: jsonState({ ...current, visits }),
        writes: {
          "showcase.extensionVisits": visits,
          "showcase.availableGold": context.gold,
        },
      };
    },
    "showcase.complete_choice"(context) {
      const current = stateOf(context.ext);
      const completed = current.completed + 1;
      return {
        ext: jsonState({ ...current, completed }),
        writes: { "showcase.extensionRuns": completed },
      };
    },
  },
  choices: {
    "showcase.keepsake": {
      options(context) {
        const state = stateOf(context.ext);
        const returning = state.visits > 1;
        return [
          {
            key: "compass",
            label: returning ? `Compass (visit ${state.visits})` : "Compass",
            data: { keepsake: "compass", visit: state.visits },
          },
          {
            key: "lantern",
            label: returning ? "Lantern (unlocked)" : "Lantern (return once)",
            enabled: returning,
            data: { keepsake: "lantern", visit: state.visits },
          },
          {
            key: "crown",
            label: context.gold >= 20 ? "Golden Crown" : "Golden Crown (need 20g)",
            enabled: context.gold >= 20,
            data: { keepsake: "crown", visit: state.visits },
          },
        ];
      },
      resolve(context, _args, result) {
        const current = stateOf(context.ext);
        if (result.kind === "cancel") {
          return {
            ext: jsonState({
              ...current,
              cancellations: current.cancellations + 1,
              lastChoice: null,
            }),
            writes: {
              "showcase.resolvedIndex": -1,
              "showcase.resolvedCount": current.selections.length,
            },
          };
        }
        const selections = [...current.selections, result.key];
        return {
          ext: jsonState({ ...current, selections, lastChoice: result.key }),
          writes: {
            "showcase.resolvedIndex": result.index,
            "showcase.resolvedCount": selections.length,
          },
        };
      },
    },
  },
};
