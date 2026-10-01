// Minimal project shared by the KAU1 entry and its procedural asset baker.

import type { MapDef, Project } from "../../../src/engine/types.ts";

export const MAP_ID = "kau1-field";
export const MAP_SIZE = { width: 4, height: 4 } as const;

export const MAP: MapDef = {
  id: MAP_ID,
  name: "Audio field",
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [{
    id: "audio-start",
    x: 0,
    y: 0,
    pages: [
      {
        trigger: "autorun",
        commands: [
          { op: "playBgm", id: "tone", volume: 35 },
          { op: "playSe", id: "tone", volume: 80, pitch: 125 },
          { op: "selfSwitch", key: "A", value: true },
        ],
      },
      {
        condition: { selfSwitch: "A" },
        trigger: "action",
        commands: [],
      },
    ],
  }],
};

export const PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "KAU1 audio host fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  audio: { tone: "audio:wav.tone" },
  maps: [MAP],
};
