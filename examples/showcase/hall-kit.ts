// Shared authoring helpers for the showcase lobby and its focused rooms.
// Each room stays small enough to read as an event-command example. The
// generated art gives every room its own palette; this file owns gameplay
// geometry and leaves the feature-specific command lists in halls/*.ts.

import type { Command, GameEvent, MapDef, TileId } from "../../src/engine/types.ts";

// One map pixel maps to one logical display pixel.  A 30x17 room therefore
// fills the showcase's 480x272 viewport without the old black side gutters.
export const HALL_WIDTH = 30;
export const HALL_HEIGHT = 17;
export const LOBBY_ID = "showcase-lobby";
export const HALL_DEMO = { x: 15, y: 8 } as const;
export const HALL_ENTRY = { x: 2, y: 14, dir: "up" as const };
export const HALL_EXIT = { x: 2, y: 15 } as const;

export interface HallDefinition {
  id: string;
  number: number;
  title: string;
  commands: readonly string[];
  demo: Command[];
  /** Extra actors or observers used by this room's demonstration. */
  events?: GameEvent[];
  /** The procedural stream cooker uses these two colours for the floor. */
  palette: readonly [string, string];
}

/** Short, player-facing copy shared by lobby signs and ambient visitors. */
export const HALL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "showcase-screen-effects": "A cottage garden for night tints, fades, weather, and camera moves.",
  "showcase-map-animations": "A waterside shrine where spell rings animate above and below the map.",
  "showcase-runtime-visuals": "A costume workshop for live sprites, layers, and passage changes.",
  "showcase-movement-controls": "A terraced park where characters wander, run, route, and approach.",
  "showcase-extensions": "An oracle's salon whose choices come from live game-owned state.",
  "showcase-battle": "A stone arena for a complete win, loss, or escape battle branch.",
  "showcase-shop": "A busy market with buying, selling, finite stock, and a shared wallet.",
  "hall-streaming": "A forest trail with streamed chunks, animated water, and tall walkers.",
  "hall-theme": "A portrait library where speakers and dialog themes change together.",
  "showcase-input-and-idle": "A small theater for locked-input scenes and world-idle gates.",
  "hall-save": "A post office that exports and verifies a real portable save code.",
  "hall-attract": "A formal garden for the guided tour, takeover, and deterministic rewind.",
  "hall-audio": "A listening room for music, ambience, fanfares, cues, fades, and replay.",
  "hall-registration": "A staffed counter where the built-in name scene updates every greeting.",
};

const HALL_VISITORS: Readonly<Record<string, readonly [string, string]>> = {
  "showcase-screen-effects": [
    "GUIDE: The lantern path still reads clearly after sunset.",
    "VISITOR: Wait for the lightning over the reflecting pond.",
  ],
  "showcase-map-animations": [
    "GUIDE: The fountain and spell circles share the water court.",
    "VISITOR: Some effects follow me; others stay on their tile.",
  ],
  "showcase-runtime-visuals": [
    "GUIDE: The mirrors make every costume change easy to compare.",
    "VISITOR: Even this workshop gate can change while we watch.",
  ],
  "showcase-movement-controls": [
    "GUIDE: The terraces keep each walking route easy to follow.",
    "VISITOR: Runners, wanderers, and followers all use the same map.",
  ],
  "showcase-extensions": [
    "GUIDE: The oracle reads choices supplied by the game itself.",
    "VISITOR: My favorite keepsake only appears when state allows it.",
  ],
  "showcase-battle": [
    "GUIDE: Every result returns safely to this training arena.",
    "VISITOR: I am keeping score from behind the brass rail.",
  ],
  "showcase-shop": [
    "GUIDE: The clerk remembers stock after every purchase.",
    "VISITOR: I compare prices before spending our shared gold.",
  ],
  "hall-streaming": [
    "GUIDE: Only the nearby forest chunks stay resident.",
    "VISITOR: The river keeps moving while the trail streams ahead.",
  ],
  "hall-theme": [
    "GUIDE: A portrait gives every line a clear speaker.",
    "VISITOR: I prefer the warm sunrise reading theme.",
  ],
  "showcase-input-and-idle": [
    "GUIDE: The house lights mark when the stage owns input.",
    "VISITOR: I wait for the scene to finish before taking my cue.",
  ],
  "hall-save": [
    "GUIDE: The counter handles export and import at one safe point.",
    "VISITOR: A save code fits in a letter and survives the trip.",
  ],
  "hall-attract": [
    "GUIDE: Leave the controls alone and the tour begins here.",
    "VISITOR: Taking over and rewinding never changes the recorded route.",
  ],
  "hall-audio": [
    "GUIDE: Each listening booth isolates a different channel.",
    "VISITOR: Music, ambience, fanfare, and cues can overlap cleanly.",
  ],
  "hall-registration": [
    "GUIDE: The registrar can update the name used by every dialog.",
    "VISITOR: I signed in once; the staff remembered me everywhere.",
  ],
};

const tile = (cell: number): TileId => `showcase.${cell}`;

function floor(width: number, height: number): TileId[] {
  return Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    return tile((x + y) % 2);
  });
}

function borderPassage(width: number, height: number): [number, "block"][] {
  const cells = new Set<number>();
  for (let x = 0; x < width; x++) {
    cells.add(x);
    cells.add((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    cells.add(y * width);
    cells.add(y * width + width - 1);
  }
  return [...cells].sort((a, b) => a - b).map((index) => [index, "block"]);
}

export function text(...lines: string[]): Command {
  return { op: "text", lines };
}

/** Pack a slash-separated command list into at most two schema-safe lines. */
function commandLabel(commands: readonly string[]): string[] {
  const lines: string[] = [];
  for (const command of commands) {
    const prefix = lines.length === 0 ? "Commands: " : "";
    const append = `${lines.length === 0 || lines[lines.length - 1] === prefix ? "" : " / "}${command}`;
    const current = lines[lines.length - 1];
    if (current !== undefined && current.length + append.length <= 52) lines[lines.length - 1] = current + append;
    else lines.push(`${lines.length === 0 ? prefix : ""}${command}`);
  }
  return lines.slice(0, 2);
}

export function hallMap(def: HallDefinition): MapDef {
  const visitors = HALL_VISITORS[def.id] ?? [
    `GUIDE: ${HALL_DESCRIPTIONS[def.id] ?? def.title}`,
    "VISITOR: The curator can repeat this demonstration at any time.",
  ];
  const events: GameEvent[] = [
    {
      id: "room-label",
      name: `${def.number}. ${def.title}`,
      x: 4,
      y: 15,
      pages: [{
        trigger: "action",
        sprite: "sign",
        blocks: true,
        commands: [text(
          `CURATOR: HALL ${def.number} — ${def.title}`,
          ...commandLabel(def.commands),
          "The curator in the center starts the demo.",
        )],
      }],
    },
    {
      id: "demo",
      name: `${def.title} demonstration`,
      x: HALL_DEMO.x,
      y: HALL_DEMO.y,
      pages: [{
        trigger: "action",
        sprite: "curator",
        blocks: true,
        commands: def.demo,
      }],
    },
    {
      id: "return-to-lobby",
      name: "Return to the feature lobby",
      x: HALL_EXIT.x,
      y: HALL_EXIT.y,
      pages: [{
        trigger: "playerTouch",
        commands: [{ op: "transfer", map: LOBBY_ID, x: 15, y: 9, dir: "down", fade: 0.15 }],
      }],
    },
    {
      id: "room-guide",
      name: `${def.title} guide`,
      x: 6,
      y: 8,
      pages: [{
        trigger: "action",
        sprite: "guide",
        blocks: true,
        dir: "right",
        commands: [text(visitors[0])],
      }],
    },
    {
      id: "room-visitor",
      name: `${def.title} visitor`,
      x: 24,
      y: 10,
      pages: [{
        trigger: "action",
        sprite: "alternate",
        blocks: true,
        dir: "left",
        commands: [text(visitors[1])],
      }],
    },
    ...(def.events ?? []),
  ];
  return {
    id: def.id,
    name: `${def.number}. ${def.title}`,
    width: HALL_WIDTH,
    height: HALL_HEIGHT,
    sheets: ["showcase"],
    ground: floor(HALL_WIDTH, HALL_HEIGHT),
    passage: borderPassage(HALL_WIDTH, HALL_HEIGHT),
    events,
  };
}

/** Evenly distribute the room doors over two rows without overlapping.
 * Keep this shared with the deterministic tour and tests as rooms are added. */
export function hallDoorPosition(
  index: number,
  total: number,
): { x: number; y: number; dir: "up" | "down" } {
  if (!Number.isInteger(index) || index < 0 || index >= total || total < 1) {
    throw new Error(`showcase hall door: invalid index ${index} of ${total}`);
  }
  const topCount = Math.ceil(total / 2);
  const top = index < topCount;
  const rowCount = top ? topCount : total - topCount;
  const column = top ? index : index - topCount;
  const x = rowCount === 1
    ? Math.floor(HALL_WIDTH / 2)
    : Math.round(2 + column * (HALL_WIDTH - 5) / (rowCount - 1));
  return top ? { x, y: 2, dir: "up" } : { x, y: 14, dir: "down" };
}

export function lobbyMap(halls: readonly HallDefinition[]): MapDef {
  const events: GameEvent[] = [
    {
      id: "welcome-sign",
      name: "Feature lobby directory",
      x: 14,
      y: 11,
      pages: [{
        trigger: "action",
        sprite: "sign",
        blocks: true,
        commands: [text(
          `CURATOR: FEATURE TOWN — ${halls.length} LIVE ROOMS`,
          "Each doorway has a sign describing its room.",
          "Every curator can repeat their demonstration.",
        )],
      }],
    },
    {
      id: "welcome",
      name: "Showcase guide",
      x: 16,
      y: 8,
      pages: [{
        trigger: "action",
        sprite: "guide",
        blocks: true,
        commands: [
          text("CURATOR: Welcome to Pocket RPG Kit.", `${halls.length} doors, ${halls.length} live features.`),
          {
            op: "choices",
            prompt: "What would you like to know?",
            options: [
              { text: "How to explore", commands: [text("Read a sign, then walk through its doorway.", "In each room, talk to the central curator.")] },
              { text: "Controls", commands: [text("DPAD walks. A confirms. B cancels.", "L rewinds. SELECT opens demo controls.")] },
              { text: "Begin", commands: [text("Every demonstration is safe to repeat.", "The return gate is beside each entrance.")] },
            ],
          },
        ],
      }],
    },
    ...halls.flatMap((hall, index): GameEvent[] => {
      const pos = hallDoorPosition(index, halls.length);
      // Signs stand in the gap beside each three-cell archway; the last arch
      // in a row has no gap to its right, so its sign stands inward of it.
      const last = pos.x === HALL_WIDTH - 3;
      const signX = last ? pos.x + 1 : pos.x + 2;
      const signY = pos.dir === "up" ? pos.y + (last ? 2 : 1) : pos.y - (last ? 3 : 1);
      return [
        {
          id: `door-${hall.id}`,
          name: `${hall.number}. ${hall.title}`,
          x: pos.x,
          y: pos.y,
          pages: [{
            trigger: "playerTouch",
            commands: [{ op: "transfer", map: hall.id, ...HALL_ENTRY, fade: 0.15 }],
          }],
        },
        {
          id: `sign-${hall.id}`,
          name: `${hall.title} information sign`,
          x: signX,
          y: signY,
          pages: [{
            trigger: "action",
            sprite: "sign",
            blocks: true,
            dir: pos.dir === "up" ? "down" : "up",
            commands: [text(
              `CURATOR: ${hall.number}. ${hall.title}`,
              HALL_DESCRIPTIONS[hall.id] ?? "A live Pocket RPG Kit demonstration.",
            )],
          }],
        },
      ];
    }),
  ];
  return {
    id: LOBBY_ID,
    name: "Pocket RPG Kit Feature Lobby",
    width: HALL_WIDTH,
    height: HALL_HEIGHT,
    sheets: ["showcase"],
    ground: floor(HALL_WIDTH, HALL_HEIGHT),
    passage: borderPassage(HALL_WIDTH, HALL_HEIGHT),
    events,
  };
}

export function hallCommands(halls: readonly HallDefinition[]): Record<string, readonly string[]> {
  return Object.fromEntries(halls.map((hall) => [hall.id, hall.commands]));
}
