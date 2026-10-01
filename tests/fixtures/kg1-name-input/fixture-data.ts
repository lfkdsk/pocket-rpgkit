// tests/fixtures/kg1-name-input/fixture-data.ts — the trivial map and the
// autorun name-input event shared by gen-assets.ts (bakes its chunk images)
// and kg1-name-input.tsx (mounts it). The map is never walked: the name
// input scene opens on frame 1.

import type { GameEvent, MapDef } from "../../../src/engine/types.ts";

export const MAP_ID = "kg1-name-field";
export const MAP_SIZE = { width: 4, height: 4 } as const;

export function nameInputEvent(args: Record<string, unknown> = {}): GameEvent {
  return {
    id: "kg1-name-input",
    x: 1,
    y: 1,
    pages: [
      {
        trigger: "autorun",
        commands: [
          { op: "scene", id: "rpgkit.nameInput", args: args as never },
          { op: "switch", id: "kg1-name-done", value: true },
        ],
      },
      {
        condition: { switch: "kg1-name-done" },
        trigger: "action",
        commands: [],
      },
    ],
  };
}

export const MAP: MapDef = {
  id: MAP_ID,
  name: MAP_ID,
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [nameInputEvent()],
};
