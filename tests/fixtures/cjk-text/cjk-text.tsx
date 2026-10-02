// tests/fixtures/cjk-text/cjk-text.tsx — sim fixture for Chinese text in
// the kit's boxes (tests/cjk-text-sim.test.ts): the real GameView runs the
// fixture's autorun dialog, choice and shop (fixture-data.ts). fonts.json
// beside this entry adds the Noto Sans CJK SC subset as the fallback face.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import type { Project } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { ITEMS, MAP, MAP_ID } from "./fixture-data.ts";

const project: Project = {
  format: "rpgkit-project/v1",
  title: "CJK text fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: ITEMS,
  maps: [MAP],
};

mount(() => <GameView project={project} assets={GAME_ASSETS} />);
