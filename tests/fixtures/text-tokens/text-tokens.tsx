// tests/fixtures/text-tokens/text-tokens.tsx — sim fixture proving the
// {x:} text-token resolver end to end through the real GameView on the
// deterministic wasm sim host (tests/text-tokens-ui-sim.test.ts). The
// autorun page opens a text box whose {x:} tokens the session resolver
// answers from the game's ext state, then an extChoice whose prompt
// carries one. The default boot is the live createSession path; setting
// __textTokensAttract before boot runs the same project through GameView's
// AttractController path instead.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import type { ExtensionOptions } from "../../../src/engine/extensions.ts";
import type { TextTokenResolver, TextTokenView } from "../../../src/engine/player-name.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { PARTY, fixtureProject } from "./fixture-data.ts";

declare global {
  // eslint-disable-next-line no-var
  var __textTokensAttract: boolean | undefined;
}

const project = fixtureProject();

const resolver: TextTokenResolver = (key: string, view: TextTokenView): string | undefined => {
  const ext = view.ext as { party?: { name: string; level: number }[] } | undefined;
  const leader = ext?.party?.[0];
  if (key === "leader") return leader ? `${leader.name} Lv${leader.level}` : undefined;
  if (key === "partySize") return String(ext?.party?.length ?? 0);
  if (key === "rev") return String(view.variables.rev ?? 0);
  return undefined;
};

const extensions: ExtensionOptions = {
  initial: { party: PARTY },
  choices: {
    "demo.party": {
      options: (ctx) => {
        const party = (ctx.ext as { party: { name: string }[] }).party;
        return party.map((mon, index) => ({ key: `p${index}`, label: mon.name, enabled: true }));
      },
    },
  },
};

const attract = globalThis.__textTokensAttract === true;
// A long all-zero tape keeps the attract timeline running for the whole
// test (an empty tape reaches its end immediately); the autorun page opens
// the boxes without any input.
const attractTape = attract ? new Array<number>(600).fill(0) : null;

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    extensions={extensions}
    textTokens={resolver}
    {...(attractTape ? { attractTape } : {})}
  />
));
