// Shared authoring helpers for the showcase lobby and its twelve rooms.
// Each room stays small enough to read as an event-command example. The
// generated art gives every room its own palette; this file owns gameplay
// geometry and leaves the feature-specific command lists in halls/*.ts.

import type { Command, GameEvent, MapDef, TileId } from "../../src/engine/types.ts";

export const HALL_WIDTH = 20;
export const HALL_HEIGHT = 15;
export const LOBBY_ID = "showcase-lobby";

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
  const events: GameEvent[] = [
    {
      id: "room-label",
      name: `${def.number}. ${def.title}`,
      x: 2,
      y: 11,
      pages: [{
        trigger: "playerTouch",
        commands: [text(
          `HALL ${def.number}: ${def.title}`,
          ...commandLabel(def.commands),
          "Talk to the glowing curator to try it.",
        )],
      }],
    },
    {
      id: "demo",
      name: `${def.title} demonstration`,
      x: 10,
      y: 7,
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
      x: 2,
      y: 13,
      pages: [{
        trigger: "playerTouch",
        commands: [{ op: "transfer", map: LOBBY_ID, x: 10, y: 7, dir: "down", fade: 0.15 }],
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

function doorPosition(index: number): { x: number; y: number; dir: "up" | "down" } {
  const x = 2 + (index % 6) * 3;
  return index < 6 ? { x, y: 2, dir: "up" } : { x, y: 12, dir: "down" };
}

export function lobbyMap(halls: readonly HallDefinition[]): MapDef {
  const events: GameEvent[] = [
    {
      id: "welcome-sign",
      name: "Feature lobby directory",
      x: 10,
      y: 10,
      pages: [{
        trigger: "action",
        sprite: "sign",
        blocks: true,
        commands: [text(
          "FEATURE GALLERY — 12 LIVE ROOMS",
          "Walk onto a numbered portal to enter.",
          "Talk to each curator; every demo repeats.",
        )],
      }],
    },
    {
      id: "welcome",
      name: "Showcase guide",
      x: 10,
      y: 6,
      pages: [{
        trigger: "action",
        sprite: "guide",
        blocks: true,
        commands: [
          text("CURATOR: Welcome to Pocket RPG Kit.", "Twelve doors, twelve live features."),
          {
            op: "choices",
            prompt: "What would you like to know?",
            options: [
              { text: "How to explore", commands: [text("Walk onto a numbered door.", "In each room, talk to its glowing curator.")] },
              { text: "Controls", commands: [text("DPAD walks. A confirms. B cancels.", "L rewinds. SELECT returns to the tour.")] },
              { text: "Begin", commands: [text("Every demonstration is safe to repeat.", "The return gate is beside each entrance.")] },
            ],
          },
        ],
      }],
    },
    ...halls.map((hall, index): GameEvent => {
      const pos = doorPosition(index);
      return {
        id: `door-${hall.id}`,
        name: `${hall.number}. ${hall.title}`,
        x: pos.x,
        y: pos.y,
        pages: [{
          trigger: "playerTouch",
          sprite: "portal",
          commands: [{ op: "transfer", map: hall.id, x: 2, y: 12, dir: "up", fade: 0.15 }],
        }],
      };
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
