// @title Pocket RPG Kit — The Sunstone of Bramble Hollow
// examples/sunstone/sunstone.tsx — the complete three-map sample game with
// attract mode and opt-in demo controls. After 10 seconds without input it
// replays the frozen 539-frame winning playthrough (demo-tape.ts, generated
// by journey.ts); any button takes over on that frame, L rewinds 3 virtual
// seconds, and SELECT opens chapters, map warp and autoplay. On a host with data.fs, an
// attract-tape.json at the app data root replaces the built-in tape.
import { mount } from "@pocketjs/framework";
// In an app that depends on the published package these are
// "pocket-rpgkit/ui" / "pocket-rpgkit/host"; the in-repo example imports
// the sources relatively so the PocketJS pass-1 transform walks them.
import { GameView } from "../../src/ui/GameView.tsx";
import { createDemo } from "../../src/ui/demo/index.ts";
import { createAudioEffects } from "../../src/ui/audio/index.ts";
import { loadAttractTape } from "../../src/host/attract-tape.ts";
import { buildGame } from "./game-data.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { DEMO_TAPE_RUNS } from "./demo-tape.ts";
import { SUNSTONE_DEMO } from "./demo-chapters.ts";

const game = buildGame();
const AudioEffects = createAudioEffects(game.project.audio!);

mount(() => (
  <GameView
    project={game.project}
    assets={GAME_ASSETS}
    attractTape={loadAttractTape(DEMO_TAPE_RUNS).masks}
    demo={createDemo(SUNSTONE_DEMO)}
    effects={AudioEffects}
  />
));
