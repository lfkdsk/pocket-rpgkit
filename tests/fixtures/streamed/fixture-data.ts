// Shared authored data for the streamed GameView fixture. The project is
// intentionally wider/taller than 512px and transfers between two maps; its
// procedural render palette gives the sim tests semantic pixel landmarks.

import type { GameEvent, MapDef, Project, TileId } from "../../../src/engine/types.ts";

export const STREAM_CHUNK = 256;
export const FIELD_ID = "wide-field";
export const HARBOR_ID = "violet-harbor";
export const FIELD_SIZE = { width: 64, height: 40 } as const;
export const HARBOR_SIZE = { width: 40, height: 36 } as const;

export type Rgba = readonly [number, number, number, number];

export const FIELD_CHUNK_COLOURS: readonly Rgba[] = [
  [36, 92, 58, 255],
  [68, 132, 74, 255],
  [42, 104, 158, 255],
  [196, 156, 52, 255],
];
export const HARBOR_CHUNK_COLOURS: readonly Rgba[] = [
  [92, 44, 132, 255],
  [44, 108, 148, 255],
  [148, 70, 132, 255],
];
export const ROOF_COLOUR: Rgba = [245, 80, 170, 255];
export const PLAYER_COLOUR: Rgba = [248, 248, 248, 255];

const ground = (width: number, height: number): TileId[] =>
  Array.from({ length: width * height }, () => "fixture.0");

function transferEvent(): GameEvent {
  return {
    id: "harbor-gate",
    name: "Harbor gate",
    x: 61,
    y: 10,
    pages: [{
      trigger: "playerTouch",
      blocks: false,
      commands: [{ op: "transfer", map: HARBOR_ID, x: 2, y: 10, dir: "right" }],
    }],
  };
}

function returnEvent(): GameEvent {
  return {
    id: "field-gate",
    name: "Field gate",
    x: 3,
    y: 10,
    pages: [{
      trigger: "playerTouch",
      blocks: false,
      commands: [{ op: "transfer", map: FIELD_ID, x: 60, y: 10, dir: "right" }],
    }],
  };
}

function map(id: string, size: { width: number; height: number }, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: size.width,
    height: size.height,
    sheets: ["fixture"],
    ground: ground(size.width, size.height),
    events,
  };
}

export const STREAMED_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "Streamed chunk fixture",
  tileSize: 16,
  start: { map: FIELD_ID, x: 2, y: 10, dir: "right" },
  sheets: [{ id: "fixture", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [map(FIELD_ID, FIELD_SIZE, [transferEvent()]), map(HARBOR_ID, HARBOR_SIZE, [returnEvent()])],
};

/** Opt-in controller for streamed runtime-layer integration. The first
 * action selects the prepackaged sparse variant and hides upper paint; the
 * second returns both layers to their authored sources. */
export const STREAMED_KV1_PROJECT: Project = {
  ...STREAMED_PROJECT,
  title: "Streamed runtime layer fixture",
  maps: [
    map(FIELD_ID, FIELD_SIZE, [{
      id: "stream-layer-controller",
      x: 3,
      y: 10,
      pages: [
        {
          trigger: "action",
          commands: [
            { op: "layer", layer: "ground", variant: "sparse" },
            { op: "layer", layer: "upper", visible: false },
            { op: "switch", id: "stream.kv1.changed", value: true },
          ],
        },
        {
          condition: { switch: "stream.kv1.changed" },
          trigger: "action",
          commands: [
            { op: "layer", layer: "ground", variant: null },
            { op: "layer", layer: "upper", visible: null },
            { op: "switch", id: "stream.kv1.reset", value: true },
          ],
        },
        {
          condition: { switch: "stream.kv1.reset" },
          trigger: "action",
          commands: [],
        },
      ],
    }]),
    map(HARBOR_ID, HARBOR_SIZE, [returnEvent()]),
  ],
};
