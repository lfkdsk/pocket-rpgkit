// PocketJS bundle fixture for saving and loading through GameView's overlay
// slot. Sunstone's game runs as plain live play (no attract tape, no demo):
// START saves the running session into a compressed save code and SELECT
// loads the last code back with loadIntoView. The sim test proves the load
// resumes frame-for-frame and that L does not rewind. A test that boots with
// the global __ks2SaveAttractTape set runs the same overlay beside an
// attract tape instead, so a save can be taken while the demo plays.

import { mount } from "@pocketjs/framework";
import { BTN } from "@pocketjs/framework/input";
import { GameView } from "../../../src/ui/GameView.tsx";
import { loadIntoView, saveFromView } from "../../../src/ui/session-saves.ts";
import { encodeSaveCode } from "../../../src/engine/save.ts";
import type { GameViewOverlayConfig } from "../../../src/ui/demo-contract.ts";
import { buildGame } from "../../../examples/sunstone/game-data.ts";
import { GAME_ASSETS } from "../../../examples/sunstone/assets-game.ts";

export interface Ks2SaveFixtureApi {
  code: string | null;
  saves: number;
  loads: number;
  /** Code of the last refused save or load. */
  error: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __ks2SaveFixture: Ks2SaveFixtureApi | undefined;
  // eslint-disable-next-line no-var
  var __ks2SaveAttractTape: readonly number[] | undefined;
}

const api: Ks2SaveFixtureApi = { code: null, saves: 0, loads: 0, error: null };
globalThis.__ks2SaveFixture = api;

const saves: GameViewOverlayConfig = {
  create(host) {
    return {
      step(_buttons, pressed) {
        if (pressed & BTN.START) {
          const saved = saveFromView(host);
          if (saved.ok) {
            api.code = encodeSaveCode(saved.snapshot, host.session.content);
            api.saves++;
          } else {
            api.error = saved.error.code;
          }
          return { consumed: true };
        }
        if (pressed & BTN.SELECT && api.code !== null) {
          const loaded = loadIntoView(host, api.code);
          if (loaded.ok) api.loads++;
          else api.error = loaded.error.code;
          return { consumed: true, stateChanged: loaded.ok };
        }
        return { consumed: false };
      },
      isOpen: () => false,
      render: () => null,
    };
  },
};

const game = buildGame();

const attractTape = globalThis.__ks2SaveAttractTape;

mount(() => <GameView project={game.project} assets={GAME_ASSETS} attractTape={attractTape} overlay={saves} />);
