// Host audio is an explicit `pocket-rpgkit/ui/audio` entry. A game that only
// imports GameView keeps the WAV decoder, pak reader bridge and audio host SDK
// out of its dependency graph. Build both apps before running this test.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");
const AUDIO_JS = join(ROOT, "dist", "kau1-audio.js");

const preflight = existsSync(SUNSTONE_JS) && existsSync(AUDIO_JS)
  ? { ok: true as const }
  : {
      ok: false as const,
      reason: "run `bun run build:example sunstone kau1-audio` first",
    };
if (!preflight.ok) console.warn(`audio bundle isolation test skipped: ${preflight.reason}`);
const maybeTest = preflight.ok ? test : test.skip;

// KAU1's shared reducer/schema/effects-injection path combines with AI2's
// optional fiber trace and KB6's kept-alive scene presentation. Moving
// src/ui/audio out of the checkout and rebuilding still produces the same
// default bundle: host playback remains absent until an app explicitly
// imports the separate audio entry below. Rebasing PocketJS onto upstream
// main adds 10,219 shared bytes to Sunstone and 10,217 to this fixture from
// motion/MicroTS contracts, devtools, frame dispatch, and clock glue.
const EXPECTED_SUNSTONE_BYTES = 578_252;
const EXPECTED_AUDIO_FIXTURE_BYTES = 563_951;

const HOST_AUDIO_NEEDLES = [
  "// src/ui/audio/driver.ts",
  "function audioHost()",
  "audio: not a RIFF/WAVE file",
  "audio: WAV has no data chunk",
  "audio: WAV must be mono or stereo",
];

describe("host WAV playback remains opt-in", () => {
  maybeTest("pins the default and opt-in bundle sizes", () => {
    expect(statSync(SUNSTONE_JS).size).toBe(EXPECTED_SUNSTONE_BYTES);
    expect(statSync(AUDIO_JS).size).toBe(EXPECTED_AUDIO_FIXTURE_BYTES);
  });

  maybeTest("keeps the WAV decoder out of the default bundle", () => {
    const ordinary = readFileSync(SUNSTONE_JS, "utf8");
    const optedIn = readFileSync(AUDIO_JS, "utf8");
    for (const needle of HOST_AUDIO_NEEDLES) {
      expect(ordinary.includes(needle), `sunstone.js contains ${JSON.stringify(needle)}`).toBe(false);
      expect(optedIn.includes(needle), `kau1-audio.js lacks ${JSON.stringify(needle)}`).toBe(true);
    }
  });
});
