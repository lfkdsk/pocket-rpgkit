import type { MapDef, Project, TileId } from "../../../src/engine/types.ts";

export const R2_MAP_ID = "r2-ui-field";
export const R2_SECOND_MAP_ID = "r2-ui-second";
export const R2_MAP_SIZE = { width: 64, height: 40 } as const;
export const PLAYER_START = { x: 15, y: 12 } as const;
export const CANOPY_NPC = { x: 19, y: 12 } as const;
export const WALKING_NPC = { x: 22, y: 14 } as const;
export const LATE_NPC = { x: 50, y: 35 } as const;
export const SECOND_NPC = { x: 7, y: 5 } as const;
export const ABOVE_ANIMATION = { x: 17, y: 11 } as const;
export const KV1_CONTROLLER = { x: PLAYER_START.x, y: PLAYER_START.y + 1 } as const;
export const KV1_SUBJECT = { x: PLAYER_START.x + 3, y: PLAYER_START.y } as const;

/** Representative positions from the original-world comparison, arranged
 *  on the second fixture map. `head` and `foot` describe opaque upper cells
 *  in the two rows touched by a 16x32 walker. */
export const OCCLUSION_CASES = [
  { id: "warehouse", x: 7, y: 9, head: false, foot: true },
  { id: "house-door", x: 10, y: 7, head: false, foot: false },
  { id: "mart-door", x: 19, y: 13, head: false, foot: false },
  { id: "trees-both", x: 8, y: 3, head: true, foot: true },
  { id: "head-only-south", x: 20, y: 16, head: true, foot: false },
  { id: "head-only-north", x: 24, y: 5, head: true, foot: false },
  { id: "mart-roof", x: 21, y: 9, head: false, foot: true },
  { id: "open-strip", x: 15, y: 12, head: false, foot: false },
  { id: "open-road", x: 5, y: 7, head: false, foot: false },
  { id: "route-tree", x: 12, y: 15, head: false, foot: true },
  { id: "route-tree-east", x: 34, y: 9, head: false, foot: true },
  { id: "route-open", x: 14, y: 12, head: false, foot: false },
  { id: "roof-north", x: 9, y: 2, head: true, foot: true },
] as const;

export const DEPTH_NORTH = { x: 28, y: 12 } as const;
export const DEPTH_SOUTH = { x: 28, y: 13 } as const;
const PERF_NPCS = [
  { id: "perf-npc-0", x: 60, y: 38 },
  { id: "perf-npc-1", x: 61, y: 38 },
  { id: "perf-npc-2", x: 62, y: 38 },
  { id: "perf-npc-3", x: 63, y: 38 },
] as const;

const ground: TileId[] = Array.from(
  { length: R2_MAP_SIZE.width * R2_MAP_SIZE.height },
  () => "fixture.0",
);

export const R2_MAP: MapDef = {
  id: R2_MAP_ID,
  name: "Animated walker field",
  width: R2_MAP_SIZE.width,
  height: R2_MAP_SIZE.height,
  sheets: ["fixture"],
  ground,
  upper: [[(CANOPY_NPC.y - 1) * R2_MAP_SIZE.width + CANOPY_NPC.x, "fixture.1"]],
  events: [
    {
      id: "late-npc",
      x: LATE_NPC.x,
      y: LATE_NPC.y,
      pages: [
        {
          trigger: "parallel",
          commands: [{ op: "switch", id: "show-late-npc", value: true }],
        },
        {
          condition: { switch: "show-late-npc" },
          trigger: "action",
          sprite: "walker",
          blocks: true,
          commands: [],
        },
      ],
    },
    {
      id: "canopy-npc",
      x: CANOPY_NPC.x,
      y: CANOPY_NPC.y,
      pages: [{ trigger: "action", sprite: "walker", blocks: true, commands: [] }],
    },
    {
      id: "walking-npc",
      x: WALKING_NPC.x,
      y: WALKING_NPC.y,
      pages: [{
        trigger: "action",
        sprite: "walker",
        blocks: true,
        moveRoute: {
          steps: ["moveRight", "moveLeft"],
          repeat: true,
          skippable: false,
        },
        commands: [],
      }],
    },
    {
      id: "to-second-map",
      x: PLAYER_START.x + 2,
      y: PLAYER_START.y,
      pages: [{
        trigger: "playerTouch",
        commands: [{ op: "transfer", map: R2_SECOND_MAP_ID, x: 5, y: 5, dir: "down" }],
      }],
    },
  ],
};

export const R2_SECOND_MAP: MapDef = {
  id: R2_SECOND_MAP_ID,
  name: "Actor transfer field",
  width: R2_MAP_SIZE.width,
  height: R2_MAP_SIZE.height,
  sheets: ["fixture"],
  ground: [...ground],
  upper: OCCLUSION_CASES.flatMap((entry) => [
    ...(entry.head ? [[(entry.y - 1) * R2_MAP_SIZE.width + entry.x, "fixture.1"] as [number, TileId]] : []),
    ...(entry.foot ? [[entry.y * R2_MAP_SIZE.width + entry.x, "fixture.1"] as [number, TileId]] : []),
  ]),
  events: [
    {
      id: "return-to-first-map",
      x: 4,
      y: 5,
      pages: [{
        trigger: "playerTouch",
        commands: [{ op: "transfer", map: R2_MAP_ID, x: PLAYER_START.x, y: PLAYER_START.y, dir: "down" }],
      }],
    },
    {
      id: "second-npc",
      x: SECOND_NPC.x,
      y: SECOND_NPC.y,
      pages: [{ trigger: "action", sprite: "walker", blocks: true, commands: [] }],
    },
    ...OCCLUSION_CASES.map((entry) => ({
      id: `occlusion-${entry.id}`,
      x: entry.x,
      y: entry.y,
      pages: [{ trigger: "action" as const, sprite: "walker", blocks: true, commands: [] }],
    })),
    {
      id: "depth-north",
      x: DEPTH_NORTH.x,
      y: DEPTH_NORTH.y,
      pages: [{ trigger: "action", sprite: "walker", dir: "up", blocks: true, commands: [] }],
    },
    {
      id: "depth-south",
      x: DEPTH_SOUTH.x,
      y: DEPTH_SOUTH.y,
      pages: [{ trigger: "action", sprite: "walker", dir: "left", blocks: true, commands: [] }],
    },
    ...PERF_NPCS.map((entry) => ({
      id: entry.id,
      x: entry.x,
      y: entry.y,
      pages: [{ trigger: "action" as const, sprite: "walker", blocks: true, commands: [] }],
    })),
  ],
};

export const R2_UI_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "R2 UI fixture",
  tileSize: 16,
  start: { map: R2_MAP_ID, x: PLAYER_START.x, y: PLAYER_START.y, dir: "down" },
  sheets: [{ id: "fixture", cols: 2, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  sprites: {
    walker: { kind: "walker", sheet: "walker-source", h: 32, cols: 3, rows: 4 },
  },
  items: [],
  maps: [R2_MAP, R2_SECOND_MAP],
};

/** Opt-in visual fixture used by kv1-ui-sim. Four action presses expose
 * appearance, built-in layer replacement/hiding, an extra map band, then a
 * viewport overlay without changing the default r2-ui fixture frames. */
export const KV1_UI_PROJECT: Project = {
  ...R2_UI_PROJECT,
  title: "KV1 runtime visuals",
  sprites: {
    ...R2_UI_PROJECT.sprites,
    alt: { kind: "image", src: "assets/walker-idle-3.png" },
  },
  maps: [{
    ...R2_MAP,
    events: [
      {
        id: "appearance-subject",
        x: KV1_SUBJECT.x,
        y: KV1_SUBJECT.y,
        pages: [{ trigger: "action", sprite: "walker", commands: [] }],
      },
      {
        id: "visual-controller",
        x: KV1_CONTROLLER.x,
        y: KV1_CONTROLLER.y,
        pages: [
          {
            trigger: "action",
            commands: [
              { op: "appearance", target: "player", sprite: "alt" },
              { op: "appearance", target: { event: "appearance-subject" }, sprite: "alt" },
              { op: "switch", id: "kv1.stage.1", value: true },
            ],
          },
          {
            condition: { switch: "kv1.stage.1" },
            trigger: "action",
            commands: [
              { op: "appearance", target: "player", opacity: 128 },
              { op: "appearance", target: { event: "appearance-subject" }, visible: false },
              { op: "layer", layer: "ground", variant: "void" },
              { op: "layer", layer: "upper", visible: false },
              { op: "switch", id: "kv1.stage.2", value: true },
            ],
          },
          {
            condition: { switch: "kv1.stage.2" },
            trigger: "action",
            commands: [
              { op: "layer", layer: "extra-canopy", variant: "on", visible: true },
              { op: "switch", id: "kv1.stage.3", value: true },
            ],
          },
          {
            condition: { switch: "kv1.stage.3" },
            trigger: "action",
            commands: [
              { op: "layer", layer: "screen-tint", variant: "blue", visible: true },
              { op: "switch", id: "kv1.stage.4", value: true },
            ],
          },
          {
            condition: { switch: "kv1.stage.4" },
            trigger: "action",
            commands: [],
          },
        ],
      },
    ],
  }],
};
