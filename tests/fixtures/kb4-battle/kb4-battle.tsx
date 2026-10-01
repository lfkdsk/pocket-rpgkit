// tests/fixtures/kb4-battle/kb4-battle.tsx — sim fixture proving KB4 (the
// state-driven, rewindable battle UI kit in src/ui/battle) end to end
// through the real GameView -> Battle Processing pipeline: a battle starts
// on frame 1 (autorun) and Kb4BattleScene (scene.tsx) renders every frame
// straight off SessionState.scene.state.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import type { Project } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { battleEvent, MAP, MAP_ID } from "./fixture-data.ts";
import { kb4BattleRules } from "./rules.ts";
import { Kb4BattleScene } from "./scene.tsx";

declare global {
  // eslint-disable-next-line no-var
  var __kb4Setup: Record<string, unknown> | undefined;
  // eslint-disable-next-line no-var
  var __kb4FrameStrip: boolean | undefined;
}

const setup = globalThis.__kb4Setup ?? {};
globalThis.__kb4Setup = undefined;
const frameStrip = globalThis.__kb4FrameStrip ?? false;
globalThis.__kb4FrameStrip = undefined;

const project: Project = {
  format: "rpgkit-project/v1",
  title: "kb4 battle fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{ ...MAP, events: [battleEvent(setup)] }],
};

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    battle={kb4BattleRules}
    battleScene={(props) => <Kb4BattleScene {...props} frameStrip={frameStrip} />}
  />
));
