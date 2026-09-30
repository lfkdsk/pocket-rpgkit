// tests/battle-ui-bundle-isolation.test.ts — KB4 (src/ui/battle) is an
// independent module: a game that never registers battle/battleScene must
// not pay for it. examples/sunstone never imports src/ui/battle (it only
// imports GameView.tsx directly, never the game passes a `battle` prop),
// so tools/build.ts's pass-1 reachability walk (every RELATIVE import from
// the entry) excludes the whole module by construction. This test pins
// that: dist/sunstone.js's byte size is unchanged from a build with
// src/ui/battle/ removed from the checkout entirely (verified by hand
// while writing this test — see the exact size below), and none of KB4's
// distinctive identifiers/strings leak into the bundle text.
//
// Requires `bun run build:example sunstone` to have run first (same
// preflight every other *-sim.test.ts uses).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");

const preflight = existsSync(SUNSTONE_JS)
  ? { ok: true as const }
  : { ok: false as const, reason: `missing ${SUNSTONE_JS} — run \`bun run build:example sunstone\`` };
if (!preflight.ok) console.warn(`battle-ui bundle isolation test skipped: ${preflight.reason}`);
const maybeTest = preflight.ok ? test : test.skip;

// Recorded by building sunstone twice — once with src/ui/battle/ present,
// once with it moved out of the checkout — and diffing dist/sunstone.js:
// identical both times (tools/build-example.ts never mentions FIXTURES
// when resolving an EXAMPLES entry, so kb4-battle joining FIXTURES cannot
// affect it either). The number itself moves with GameView.tsx (shared by
// every game, battle or not): GameView now registers a "back" action while
// a scene is active, a few dozen bytes GameView.tsx costs every game
// equally, kb4-battle included or not. It also moved when battles and
// extensions started sharing the session's items and gold (the engine's
// shared write-back path); re-verified with src/ui/battle/ moved out: equal.
// PR #1's persistent text/choice/shop branches add 426 bytes to the shared
// DialogBox implementation; this is the measured post-build Sunstone bundle.
const EXPECTED_BYTES = 429_204;

describe("KB4 does not reach games that never opt into battle", () => {
  maybeTest("sunstone's built bundle size is unchanged", () => {
    expect(statSync(SUNSTONE_JS).size).toBe(EXPECTED_BYTES);
  });

  maybeTest("sunstone's bundle text contains none of KB4's distinctive identifiers", () => {
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of [
      "shakeOffsetX",
      "frameIndexAt",
      "faintPose",
      "flashOpacity",
      "barFillWidth",
      "kb4-battle-scene",
      "CommandGrid",
    ]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });
});
