// The complete feature-gallery project. Feature rooms are split by subject
// so each file remains a readable command example; this module is the one
// project source consumed by both the app and the deterministic asset cooker.

import type { Project } from "../../src/engine/types.ts";
import { hallMap, lobbyMap, type HallDefinition } from "./hall-kit.ts";
import { PRESENTATION_HALLS } from "./halls/presentation.ts";
import { MOTION_HALLS } from "./halls/motion.ts";
import { INTERACTIVE_HALLS } from "./halls/interactive.ts";
import { SYSTEM_HALLS } from "./halls/system.ts";

export const SHOWCASE_HALLS: readonly HallDefinition[] = [
  ...PRESENTATION_HALLS,
  ...MOTION_HALLS,
  ...INTERACTIVE_HALLS,
  ...SYSTEM_HALLS,
].sort((a, b) => a.number - b.number);

export function buildShowcaseProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Pocket RPG Kit Feature Gallery",
    tileSize: 16,
    start: { map: "showcase-lobby", x: 15, y: 10, dir: "up" },
    system: {
      messageBlocksPlayer: true,
      inventory: { maxPerItem: 9, maxKinds: 8 },
    },
    initialGold: 80,
    audio: {
      "town-theme": "audio:wav.showcase-town",
      "coin-chime": "audio:wav.showcase-coinecho",
      "bark-fanfare": "audio:wav.showcase-bark",
      "ice-ambience": "audio:wav.showcase-ice",
    },
    sheets: [
      {
        id: "showcase",
        cols: 2,
        rows: 1,
        pak: "showcase-stream",
        defaultPassage: "pass",
      },
      { id: "generated-walker", cols: 3, rows: 4, pak: "showcase-actors" },
      { id: "generated-alternate", cols: 3, rows: 4, pak: "showcase-actors" },
    ],
    items: [
      { id: "potion", name: "Spark Potion", sprite: "showcase.0", price: 12 },
      { id: "ether", name: "Clockwork Ether", sprite: "showcase.1", price: 20 },
      { id: "showcase-token", name: "Gallery Token", sprite: "showcase.1", price: 40, sellable: false },
    ],
    sprites: {
      curator: { kind: "image", src: "generated:curator" },
      guide: { kind: "image", src: "generated:guide" },
      sign: { kind: "image", src: "generated:sign" },
      runner: { kind: "walker", sheet: "generated-walker", h: 32, cols: 3, rows: 4 },
      alternate: { kind: "walker", sheet: "generated-alternate", h: 32, cols: 3, rows: 4 },
    },
    animations: [
      {
        id: "showcase-pulse",
        sheet: "generated:showcase-pulse",
        frameW: 64,
        frameH: 64,
        frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        frameDuration: 0.1,
      },
      {
        id: "showcase-ring",
        sheet: "generated:showcase-ring",
        frameW: 64,
        frameH: 64,
        count: 10,
        frameDuration: 0.12,
        loop: true,
      },
    ],
    maps: [lobbyMap(SHOWCASE_HALLS), ...SHOWCASE_HALLS.map(hallMap)],
  };
}
