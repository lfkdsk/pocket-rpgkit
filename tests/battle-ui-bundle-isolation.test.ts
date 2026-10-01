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
// KP1's opt-in startup phase marks are shared GameView/session code and remain
// inert unless a benchmark host installs the global hook; they do not add a
// dependency on the separately checked battle identifiers below.
// Bounded rewind keyframes add 6,488 bytes of shared AttractController code;
// the distinctive-identifier assertion still proves the opt-in battle UI is
// absent.
// The worldIdle condition adds 1,820 bytes of shared session/interpreter code;
// it remains independent of the opt-in battle UI identifiers checked below.
// KB6's keep-mounted world and battle scene reuse add 2,150 bytes of shared
// GameView code (display toggles, the active-accessor gates, the battle
// keep-alive latch); the opt-in battle UI identifiers below stay absent.
// Extension-driven choices and KV1's generic runtime appearance, named-layer
// and tile-property paths, KM1 runtime movement controls (with a separately
// compiled 12,980-byte legacy movement loop so projects without controls skip
// the controlled per-frame path), KA1's state-driven map animation layer and
// its interpreter support, the 525-byte optional native FS text read, and
// KS1's shared screen-effect/camera/balloon presentation path are shared
// GameView/session/interpreter code. KS1 adds 28,383 bytes to the previously
// measured 525,552-byte bundle. The opt-in onFiberStart fiber trace
// (rpgkit-check's explore coverage) adds 273 bytes of shared
// interpreter/session code: four optional call sites in the trigger scan
// plus the WorldOptions/SessionOptions threading. It is inert when no
// session installs it. KB6 fix 1's host-portable JSON clone fast path adds
// 2,257 bytes of shared engine code: it replaces per-property defineProperty calls with
// ordinary assignment while retaining the __proto__ data-key guard. The
// distinctive battle identifiers below remain absent. KAU1's deterministic
// audio state/commands and generic effects injection point are also shared;
// its separately imported WAV host adapter remains absent (pinned by
// audio-bundle-isolation.test.ts). Rebasing PocketJS onto upstream main adds
// 10,219 shared bytes: motion framework/contracts (4,634), MicroTS contract
// (2,191), devtools (2,163), frame dispatch (741), and clock/contract glue
// (490). The exact combined size is re-measured after every shared-path
// change.
// Sunstone's opt-in demo configuration, three chapter save codes and live
// page hook combine with KAU1's shared audio/effects state path. Demo and
// audio isolation are pinned separately; the identifiers below continue to
// prove that the Sunstone bundle does not pull in battle UI.
const EXPECTED_BYTES = 686_415;

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

  maybeTest("sunstone's bundle contains no editor proposal-review code", () => {
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of ["proposal-session.json", "proposal-review", "PROPOSALS ("]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });

  maybeTest("editor playtest and debugger code do not reach the game bundle", () => {
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of [
      "editor-playtest-root",
      "editor-playtest-debug-panel",
      "PLAYTEST STOPPED",
      "LIVE STATE  F",
      "Preview fallback: unregistered extension",
      "PLAYTEST_SHEET_REFS",
    ]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains editor-only ${JSON.stringify(needle)}`).toBe(false);
    }
  });
});
