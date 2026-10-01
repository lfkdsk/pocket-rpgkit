// Minimal end-to-end opt-in audio fixture. Importing this isolated module and
// passing it as GameView.effects is the explicit bundle boundary.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import { createAudioEffects } from "../../../src/ui/audio/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { PROJECT } from "./fixture-data.ts";

const AudioEffects = createAudioEffects(PROJECT.audio!);

mount(() => (
  <GameView
    project={PROJECT}
    assets={GAME_ASSETS}
    effects={AudioEffects}
  />
));
