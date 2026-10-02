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
// GameView bytes to all three. The immutable-session port adds 26,029 bytes
// to the ordinary Meadow bundle and 31,070 bytes to the QOA/WAV entries:
// bounded state metadata, opt-in interpreter/session caches, retained actor
// frames, stable dialog/battle paint paths, and generic-scene merge guards.
// Choice-row icons add the optional icon schema entry, the reducer's icon
// column and the DialogBox opt-in hook (the icon box itself is opt-in):
// 1,952 bytes to Meadow, 4,364 to Sunstone and 2,825 to the WAV fixture.
// The list of compatible earlier schema identities (twelve SHA-256 literals
// and the membership check the session and save decoder share) adds 1,099
// bytes to Meadow and the WAV fixture and 1,202 to Sunstone. Narrowing that
// list to one identity and naming the accepted identities in the refusal
// message saves 314 bytes in Meadow and the WAV fixture and 180 in Sunstone.
// Applying same-tick place/moveRoute requests in command order (with the
// publish-time target page) adds 2,745 shared interpreter/session bytes to
// all three. Sunstone's opted-in demo menu adds lazy tape providers, a global
// timelineFrame and a once-per-provider shared tape cache (2,461 bytes);
// Meadow and the WAV fixture do not opt into the demo menu.
// Saves that keep the current map's characters, compressed save codes and
// GameView's overlay slot leave Meadow unchanged (it never decodes a save).
// Sunstone, whose demo chapters decode codes, gains 28,977 bytes: 24,285 for
// the inflate half of the DEFLATE codec, validating, snapshotting and
// restoring the character table and route-parked parallels, and the overlay
// slot, less its shorter chapter codes (measured together); then 1,970 for
// the joint character-motion checks, 39 for the overlay's attract-aware held
// mask, 1,869 for the save-code length and depth bounds and 814 for counting
// envelope text in UTF-8 bytes (Meadow and the WAV fixture never decode
// one). The WAV fixture gains the overlay slot's 1,411 and the held-mask 39:
// 1,450.
// PocketJS #508's opt-in model-trace guards and #512's retired console-bridge
// cleanup add 323 shared bytes to each bundle.
// Hiding an erased event's actor in GameView adds 148 bytes to Sunstone and
// the WAV fixture (Meadow does not mount GameView).
// Re-measure after every shared-path change.
const EXPECTED_MEADOW_BYTES = 502_945;
const EXPECTED_SUNSTONE_QOA_BYTES = 807_210;
const EXPECTED_WAV_FIXTURE_BYTES = 642_754;

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
