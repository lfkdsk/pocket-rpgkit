// Real GameView fixture for the KRM3 built-in select-item scene.

import { mount } from "@pocketjs/framework";
import { SELECT_ITEM_SCENE_ID, selectItemRules } from "../../../src/engine/select-item.ts";
import type { Project } from "../../../src/engine/types.ts";
import { GameView } from "../../../src/ui/GameView.tsx";
import { SelectItemScene } from "../../../src/ui/select-item/SelectItemScene.tsx";
import { GAME_ASSETS } from "./assets-game.ts";
import { ITEMS, MAP, MAP_ID } from "./fixture-data.ts";

const project: Project = {
  format: "rpgkit-project/v1",
  title: "KRM3 select-item fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 8, y: 8, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: ITEMS,
  maps: [MAP],
};

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    scenes={{ [SELECT_ITEM_SCENE_ID]: selectItemRules }}
    sceneViews={{ [SELECT_ITEM_SCENE_ID]: SelectItemScene }}
  />
));
