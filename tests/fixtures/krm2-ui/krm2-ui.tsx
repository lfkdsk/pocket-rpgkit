// Real GameView fixture for the KRM2 timer/banner/picture and number editor.

import { mount } from "@pocketjs/framework";
import { NUMBER_INPUT_SCENE_ID, numberInputRules } from "../../../src/engine/number-input.ts";
import type { Project } from "../../../src/engine/types.ts";
import { GameView } from "../../../src/ui/GameView.tsx";
import { krm2ScreenPresentation } from "../../../src/ui/krm2/index.ts";
import { NumberInputScene } from "../../../src/ui/number-input/NumberInputScene.tsx";
import { GAME_ASSETS } from "./assets-game.ts";
import { MAP, MAP_ID } from "./fixture-data.ts";

const project: Project = {
  format: "rpgkit-project/v1",
  title: "KRM2 visual fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 30, y: 18, dir: "down" },
  system: { mapNameDisplay: true },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [MAP],
};

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    screenPresentation={krm2ScreenPresentation}
    scenes={{ [NUMBER_INPUT_SCENE_ID]: numberInputRules }}
    sceneViews={{ [NUMBER_INPUT_SCENE_ID]: NumberInputScene }}
  />
));
