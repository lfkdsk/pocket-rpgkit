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
// The optional streamed tile loader (StreamedGameAssets.loadTile, used by the
// preview page's supplied sheets) adds 183 bytes to the streamed ground and
// upper layers in Sunstone and the WAV fixture; Meadow is unchanged.
// CJK-aware text layout (the line breaker, row flow and cached glyph
// measurer shared by the dialog, battle and save-menu boxes) adds 8,921 shared
// bytes to Sunstone and the WAV fixture and 8,983 to Meadow; merged with the
// demo change the three measure 514,512 (Meadow), 789,647 (Sunstone) and
// 652,604 (WAV fixture). Continuing long messages on further pages and
// wrapping list labels instead of cutting them (the page state in the
// reducer, the dialog paginator, row-window helpers) adds 1,489 bytes to
// Meadow, 3,357 to Sunstone and 2,926 to the WAV fixture.
// With the save changes, the tile loader and PocketJS #508/#512 merged in,
// the three measure 516,324 (Meadow), 822,635 (Sunstone) and 657,634 (WAV
// fixture).
// The additive world-layout schema keeps the immediately preceding schema
// identity compatible, adding one 64-byte hash literal (72 bundled bytes) to
// every engine consumer; world-layout validation remains out of these apps.
// The loop/break commands, the eventTouch trigger and the {v:} text token
// add shared interpreter/session bytes to every bundle: 718 for the token,
// 4,140 for compiling and running loop/break and scanning eventTouch pages
// (Sunstone 4,982: it also carries the save checks for the new
// instructions), and 2,887 for detecting bumps and refused steps.
// Replaceable interface words (engine/ui-text.ts: the shared English table
// and its merge/format helpers, 1,164-1,510 bytes; DialogBox's shop words,
// 669; GameView's legends, attract chrome and table hand-off, 1,402; the
// compatible schema identity, 72) add 1,905 bytes to Meadow and 3,653 to
// the WAV fixture; Sunstone's opted-in demo menu words and wrapping add
// 2,307 more (5,960). The long-translation wrapping (StatBar/name-input
// ladders, shop gold/legend wrap, demo error templates) adds 1,517 bytes
// to Meadow, 5,686 to Sunstone and 2,390 to the WAV fixture.
// The optional playerStep extension hook (a null check and two number
// reads per tick when unused) adds 1,218 shared bytes to each bundle. The
// attract controller GameView bundles gains the keyframe count cap,
// shared immutable keyframes, the reused rollback checkpoint and its
// success-path resync, plus the attractRewindOptions helper GameView
// forwards through: shared bytes in Sunstone and the WAV fixture (Meadow
// does not mount GameView); Sunstone's opted-in demo adds DemoOptions.rewind
// validation and the explicit four-field forwarding.
// The W3 cache fixes add the parsed-only compiled-layer rebuild in
// acquireSessionMap (shared engine code in all three), the staged-
// preparation trim in releaseSessionMapLayers, and the explicit
// blocked.failed flag plus the falsy-rejection normalizer in GameView
// (the two GameView bundles only).
// Reusing unchanged integer chunk windows adds 76 bytes to Meadow. The
// connected-world renderer is behind `pocket-rpgkit/ui/world`: its
// concrete modules are absent here, while GameView's generic factory seam
// adds about 4.6 KB to Sunstone and the WAV fixture. Merged, the three
// measure 525,365, 840,064 and 672,828.
// KRM2's additive event instructions, screen/timer state, compiler paths,
// save checks and schema identity add shared engine bytes. The generic
// GameView screen-presentation seam and host-action dispatcher add only to
// GameView apps. Numbered-picture/HUD JSX is isolated behind
// `pocket-rpgkit/ui/krm2` and is absent from all three bundles here (pinned
// separately by krm2-ui-bundle-isolation.test.ts). Together the measured
// sizes are 542,876, 871,523 and 691,900 bytes. Timer-aware immutable page
// and trigger-scan keys add 317 shared bytes to each bundle; keeping the demo
// warp toast inside the viewport and dismissing it before a modal then adds
// 173 bytes only to Sunstone: 543,193, 872,013 and 692,217 bytes.
// The W3 cache fixes and the world coordinate-contract promotion helper
// add shared GameView bytes, bringing main to 543,736, 873,965 and 694,169.
// Merging the interface-text branch (the uiText table, BoundedLine and the
// bounded SaveMenu/DialogBox/demo paths) adds the kit's replaceable words
// and the bounded-line machinery: the merged product measures 555,516,
// 898,897 and 708,561 bytes. Merging seamless-v1 (traversal identity,
// transfer provenance, sparse reducer state and the optional GameView
// resolver seam) brings them to 561,053, 905,748 and 714,453.
// KRM3V's additive reducer/save support and optional GameView seams bring the
// three input graphs to 569,421 (+8,368), 917,053 (+11,305) and 723,778
// (+9,325). Concrete parallax and item-icon components remain opt-in and are
// checked separately by krm3v-ui-bundle-isolation.test.ts.
// Deterministic seamless-handoff fatal cleanup (source-edge movement restore,
// abort guards before commit) adds 440 shared engine bytes to each graph.
// The per-tick prune of finished map animations and the empty-string
// parallax clear (both guarded no-ops when unused) add 103/228/103 bytes.
// The save-decode normalization of an empty-name parallax to none adds 236
// bytes to the sunstone graph only (its input graph includes the save decode
// path; meadow's and the WAV fixture's do not), so only the sunstone pin
// moves: 917,721 -> 917,957.
// Re-measure after every shared-path change.
const EXPECTED_MEADOW_BYTES = 569_964;
const EXPECTED_SUNSTONE_QOA_BYTES = 917_957;
const EXPECTED_WAV_FIXTURE_BYTES = 724_321;

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
