import { mount } from "@pocketjs/framework";
import { GameView, type MapAnimStats } from "../../../src/ui/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { KA1_PROJECT } from "./fixture-data.ts";

export interface Ka1Stats {
  below?: MapAnimStats;
  above?: MapAnimStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __ka1Stats: Ka1Stats | undefined;
}

const stats: Ka1Stats = {};
globalThis.__ka1Stats = stats;

mount(() => (
  <GameView
    project={KA1_PROJECT}
    assets={GAME_ASSETS}
    onMapAnimStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
