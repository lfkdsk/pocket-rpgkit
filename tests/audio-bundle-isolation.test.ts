// Host audio is an explicit `pocket-rpgkit/ui/audio` entry. A game that only
// imports GameView keeps the WAV/QOA decoders, pak reader bridge and audio host
// SDK out of its dependency graph. Build all three apps before this test.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MEADOW_JS = join(ROOT, "dist", "meadow.js");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");
const AUDIO_JS = join(ROOT, "dist", "kau1-audio.js");

const preflight = existsSync(MEADOW_JS) && existsSync(SUNSTONE_JS) && existsSync(AUDIO_JS)
  ? { ok: true as const }
  : {
      ok: false as const,
      reason: "run `bun run build:example meadow sunstone kau1-audio` first",
    };
if (!preflight.ok) console.warn(`audio bundle isolation test skipped: ${preflight.reason}`);
const maybeTest = preflight.ok ? test : test.skip;

// Meadow is the ordinary GameView-only control: it carries no audio, demo or
// battle code, only shared engine/UI growth (most recently 10,219 bytes from
// rebasing PocketJS onto upstream main). Sunstone opts into QOA music and the
// demo menu (chapter codes, tape suffixes, page hook); the small audio
// fixture opts into WAV playback. KV2's per-map actor pool adds shared
// GameView bytes to all three. Re-measure after every shared-path change.
const EXPECTED_MEADOW_BYTES = 451_424;
const EXPECTED_SUNSTONE_QOA_BYTES = 712_836;
const EXPECTED_WAV_FIXTURE_BYTES = 581_076;

const HOST_AUDIO_NEEDLES = [
  "// src/ui/audio/driver.ts",
  "// src/ui/audio/qoa.ts",
  "function audioHost()",
  "audio: not a RIFF/WAVE file",
  "audio: not a QOA file",
];

describe("host WAV/QOA playback remains opt-in", () => {
  maybeTest("pins the no-audio, QOA and WAV bundle sizes", () => {
    expect(statSync(MEADOW_JS).size).toBe(EXPECTED_MEADOW_BYTES);
    expect(statSync(SUNSTONE_JS).size).toBe(EXPECTED_SUNSTONE_QOA_BYTES);
    expect(statSync(AUDIO_JS).size).toBe(EXPECTED_WAV_FIXTURE_BYTES);
  });

  maybeTest("keeps both decoders out of the no-audio bundle", () => {
    const ordinary = readFileSync(MEADOW_JS, "utf8");
    const qoa = readFileSync(SUNSTONE_JS, "utf8");
    const wav = readFileSync(AUDIO_JS, "utf8");
    for (const needle of HOST_AUDIO_NEEDLES) {
      expect(ordinary.includes(needle), `meadow.js contains ${JSON.stringify(needle)}`).toBe(false);
      expect(qoa.includes(needle), `sunstone.js lacks ${JSON.stringify(needle)}`).toBe(true);
      expect(wav.includes(needle), `kau1-audio.js lacks ${JSON.stringify(needle)}`).toBe(true);
    }
    expect(qoa.includes('"sunstone-theme": "audio:qoa.music/sunstone-theme"')).toBe(true);
    expect(wav.includes('tone: "audio:wav.tone"')).toBe(true);
  });
});
