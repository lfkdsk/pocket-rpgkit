# Feature status

What Pocket RPG Kit can do today, area by area.

The implemented highlights can be explored together in the
[`examples/showcase` feature gallery](../examples/showcase/README.md).

- **Done**: on `main` and covered by tests.
- **Partial**: works within the limits noted.
- **Planned**: not on `main` yet. "In progress" means someone is working on it now.

The links point to where each feature is described in detail.

## Event system

| Feature | Status | Notes |
| --- | --- | --- |
| Event pages with `action`, `playerTouch`, `eventTouch`, `autorun` and `parallel` triggers; common events | Done | [The 49 commands](../README.md#the-49-commands); `eventTouch` fires when the player walks into a blocking event or the event's own step is refused by the player (RPG Maker Event Touch), see [Event Touch](../src/engine/README.md#event-touch) |
| Loops (`loop` / `break`) | Done | `break` leaves the innermost loop from nested `if`/`choices`/`battle`/`scene` blocks; a loop that never waits yields after 1,000 steps per tick instead of stalling. Labels / jump-to-label are not supported. See [Loops](../README.md#loops) |
| Dialog: typewriter text, choices with 2–8 options (scrolling past 4) and a cancel branch | Done | |
| Long text is never cut: dialog continues on further pages, options and labels wrap | Done | A message longer than four rows takes one confirm per page; pages are decided when the box opens and kept in reducer state (same at every rate and after rewind), cut at the 480 px design width. Choice prompts and options, shop names, icon-choice labels, battle menus, the battle message band and save-menu strings wrap and their boxes grow; a fixed battle command cell wraps to two rows, then steps down from 12 px to 10 px (one or two rows), and only a label that two 10 px rows cannot hold is clipped, with the focused cell scrolling it sideways. Limits: pages need GameView's paginator (a bare `DialogBox` or headless session shows one page); 10 px is the only smaller size, and an unfocused clipped cell shows its first characters. See [Long text is never cut](../README.md#long-text-is-never-cut) |
| Chinese (CJK) text in dialog, choices, shops, battle menus and the save menu | Partial | Rows break between CJK characters with simplified kinsoku, Latin words and numbers stay whole, labels wrap at their pixel width, the typewriter steps by code point. A per-app Noto Sans CJK SC subset holds only the characters the app displays (`tools/cjk-font.ts` reads its decoded strings, escapes included), and its license ships inside the pak and beside web and desktop builds. The preview and Studio play-test draw Chinese from a budgeted face (GB2312 level 1 and punctuation) baked at load. Latin-only apps bake no CJK atlas. Limits: Simplified Chinese glyphs only; every used font slot carries every character (about 776 bytes each in the atlases at density 1, about 1,552 resident on PSP, plus 138/276 for the 10 px slot in an app with the battle command grid); characters outside the preview budget show as boxes in the preview only; the kit's fixed words are English; no input method (name input is a Latin keyboard). See [Chinese (CJK) text](../README.md#chinese-cjk-text) |
| Dialog themes and speaker portraits | Done | [Themes and speaker portraits](../README.md#themes-and-speaker-portraits) |
| Choice icons: a character sprite left of each `choices` option label | Done | Opt-in `ChoiceIconBox` (`pocket-rpgkit/ui/choice-icons`, GameView `choiceIcons`); 1× icons in 24 px rows, 16×32 walkers lose their top 8 pixel rows; missing sprites draw a `?` and fail `rpgkit-check`; editable in the editor and `rpgkit-edit update-command`. See [Choice icons](../README.md#choice-icons) |
| Switches, self switches, items, gold | Done | |
| Variables: set/add/sub, seeded random ranges, arithmetic against another variable | Done | Numbers only |
| Page and `if` conditions on switches, variables, self switches, items, gold, facing, appearance, tile-property overrides, `worldIdle`, `bgmPlaying`, or an extension predicate | Done | |
| Cross-event input lock (`lockInput` / `unlockInput`) | Done | |
| Map transfers with an optional fade and variable targets | Done | |
| Game extensions | Done | Namespaced pure commands (`ext`) and choice boxes whose rows come from an extension (`extChoice`); see [Game extensions and Battle Processing](../README.md#game-extensions-and-battle-processing) |
| Shops (RPG Maker MV-style buy and sell) | Done | |
| Text interpolation of variables (`{v:<id>}`, RPG Maker `\V[n]`) | Done | Opt-in with `system.textVariables`; text, choices and `extChoice` prompts; expanded once when the box opens. See [Text tokens](../README.md#text-tokens) |
| Text interpolation of actor names (`\N[n]`) and text colour codes | Planned | Only the player's `{name}` today |
| Step counter and region triggers | Planned | |
| Number input, item selection, scrolling text, timers | Planned | |

## Movement

| Feature | Status | Notes |
| --- | --- | --- |
| Player and NPC movement over the passage table, with one-sided entry/exit edges and NPC collision | Done | |
| Move routes | Done | Moves, turns, waits, deterministic `pathTo` and `approach` |
| Run-time movement control (`moveControl`) | Done | Autonomous mode, stop, bounded wander, and speed/run/frequency/collision/facing overrides. Projects that never use it run a separate loop and pay nothing per frame |
| Relocating the player or an event (`place`) | Done | Routes, turns, and controls a fiber publishes after a `place` on the same tick are kept, including for an NPC whose page that tick switched on. See [same-tick order](../src/engine/README.md#p1-session-multi-map-fold) |
| Followers and vehicles | Planned | |

## Presentation

| Feature | Status | Notes |
| --- | --- | --- |
| Large maps | Done | Streamed rendering, animated tiles, 16×16 and 16×32 walkers; see [Large-map streamed rendering](../README.md#large-map-streamed-rendering) and [Animated map tiles](../README.md#animated-map-tiles-and-1632-walkers) |
| Actor node pool sized to the current map | Done | NPC/event image nodes are allocated per current map and grow (never shrink) when a transfer lands on a busier map, so small maps no longer pre-build the project's global event maximum; growth rebinds existing nodes instead of rebuilding them |
| Map animations on a tile or following a character (`mapAnim` / `stopAnim`) | Done | [Map animations](../README.md#map-animations-mapanim--stopanim) |
| Run-time appearance, named visual layers, tile passage overrides | Done | Appearance covers sprite, opacity and visibility (`appearance`). Visual layers can be bands below or above characters, or screen overlays (`layer`). Tile passage overrides use `tileProperty`. Layer and tile-property overrides reset on every transfer |
| Screen effects | Done | Fade, composable named tints, flash, deterministic shake, camera scroll, character balloons, full-screen backdrops. All are saved and rewound with the session |
| Tuxemon-styled feature gallery | Done | A town plaza connects fourteen themed halls through numbered stone archways, including a Registration Desk, with per-hall thumbnails and browser chapter cards. Every prop is cut from a measured source rectangle and every path, pond and paving edge uses Tuxemon transition tiles, both pixel-tested; limits: terrain areas must stay two cells apart and rugs are rectangles. See the [gallery catalogue](../examples/showcase/README.md) |
| Pictures (show / move / rotate / tint / erase) | Planned | |
| Weather particles | Planned | Colour overlays already work through screen layers and tints |

## Audio

| Feature | Status | Notes |
| --- | --- | --- |
| Sound effects (`playSe`; legacy `se`) | Done | Ordered deterministic cues and the opt-in PocketJS WAV/streaming-QOA bridge work; missing hosts or resources degrade to silence. See [Opt-in host audio](../README.md#opt-in-host-audio) |
| Background music, ambience and music effects (BGM / BGS / ME) | Partial | Playback, fades, pause/resume, saves/rewind, `bgmPlaying`, battle BGM swap/restore, WAV and credit-driven QOA playback work on the web and desktop hosts (desktop on Linux needs ALSA). ME duration is still authored rather than read from media. The showcase has a Sound Studio room. See [Opt-in host audio](../README.md#opt-in-host-audio) |
| Build-time QOA encoding | Done | Deterministic interleaved s16 PCM to host-playable mono/stereo QOA at 11.025, 22.05 or 44.1 kHz; callers decode Ogg/MP3 first. See [Opt-in host audio](../README.md#opt-in-host-audio) |

## Scenes and menus

| Feature | Status | Notes |
| --- | --- | --- |
| Battle scenes and battle UI kit | Done | A game registers a battle scene; `battle` parks the event until it ends and runs its win/lose/escape branch. The kit provides state-driven battle UI blocks; see [Battle UI kit](../README.md#battle-ui-kit-pocket-rpgkituibattle) |
| The map world stays alive during battles | Done | Entering or leaving a battle does not rebuild the map. The map/dialog stay mounted but hidden; map clocks freeze by default, while battle audio can switch and restore without remounting its driver |
| Generic full-screen game scenes and a name-input screen | Done | A game registers `SceneRules` by id; `scene` parks the event until the scene completes and runs `onDone`/`onCancel`, with atomic writes to variables, switches, items, gold and the player name. The built-in name-input scene (`rpgkit.nameInput`) is an MV-style grid editor with held-key repeat. Scenes freeze the world by default and keep the map mounted but hidden, like battles. Limitation: the name-input grid recreates its cell nodes on every active host frame (the UI framework freezes dynamic styles at mount for list-created components), so an open name-input scene pays that churn each frame; scene-free projects are unaffected |
| Menu and save access switches, game over, return to title | Planned | |

## Saves, rewind and demos

| Feature | Status | Notes |
| --- | --- | --- |
| Save slots and save codes | Done | Slots use `data.fs` on desktop; the web falls back to save codes. Loaded snapshots are validated. Save codes are DEFLATE-compressed (about 2× shorter for a small game, 4–6× for a large one) and the older uncompressed codes still load. See [Saves and save codes](../README.md#saves-and-save-codes) |
| Saves keep the current map's characters | Done | A save records where every character on the current map stands and faces, its running and patrol move routes with their progress (including a path search in flight), the wander RNG, a route running on the player and a post-transfer fade-in, so a load continues frame for frame mid-scene. Loads refuse character fields that disagree with each other (a step off the map, a pixel position away from the tile) and save data too large (over 16 MiB of UTF-8 envelope JSON) or too deeply nested. Saves made before this still load; their characters start again from the map |
| Loading a save into a running GameView | Done | The `overlay` prop gives a game's menu live session access; `saveFromView` / `loadIntoView` (`pocket-rpgkit/ui/saves`) save and load with typed error codes and leave the game untouched on refusal. It turns on no attract controller, so L does not rewind; beside a demo, a save records the buttons the demo was holding. See [Saves and save codes](../README.md#saves-and-save-codes) |
| Sharded projects and saves across schema updates | Done | Shells and saves made under an earlier schema version load as long as every change since then only added optional fields, commands or conditions; a change to existing behaviour refuses them until a migration exists (none ships yet). Today only the version just before optional choice icons is accepted besides the current one; older versions predate behaviour changes and are refused with a message naming the accepted versions. Saves are rewritten under the current version. See [Schema identities](../src/data/CHANGELOG.md#schema-identities) |
| Attract mode | Done | Plays a tape after 10 idle seconds; any button takes over, **L** rewinds 3 virtual seconds, using bounded keyframes |
| Demo controls and web deep links | Done | Opt-in chapter starts, safe map warp and 1×/2×/4× autoplay through [`pocket-rpgkit/ui/demo`](../README.md#demo-controls-pocket-rpgkituidemo); chapters can share one recorded tape by window, load it lazily from a provider that is resolved once, and resume on the recording's global frame; web chapter cards support preview images and descriptions, jump the running game without a reload, and retain query-link fallbacks. Desktop has the menu but no guest argv/environment launch bridge |
| Byte-identical replays on every host and simulation rate | Done | No wall clock and no `Math.random` in the engine |

## Runtime performance

| Feature | Status | Notes |
| --- | --- | --- |
| Immutable reducer-state fast path | Done | Opt-in copy-on-write banks and bounded identity caches preserve ordinary event ordering, saves and rewind; see [Opt-in immutable-state fast path](../README.md#opt-in-immutable-state-fast-path) |
| Retained and incremental game UI | Done | Viewport windows, actor frames, dialog leaves and battle widgets reuse stable nodes and update only changed paint inputs |

## Maps and resources

| Feature | Status | Notes |
| --- | --- | --- |
| Large projects split into a map shell plus maps loaded on demand from the pak | Done | Faded transfers stage parse, validation, world compilation and passage compilation on separate reference ticks; see [Large projects](../README.md#large-projects-maps-as-on-demand-entries) |
| World placement, component, seam and opening data | Partial | The optional project-level layout contract, signed world/local transforms and semantic validation are ready and content-identity-bound; multi-map rendering and seamless handoff remain planned. See [World-layout data](../README.md#world-layout-data) |
| Reversible compact map entries | Done | `rpgkit-map/1` dictionaries/RLE tile layers and repeated event keys; the repository auto-detects compact or JSON entries, while `auto` cooking keeps only smaller encodings. See [Large projects](../README.md#large-projects-maps-as-on-demand-entries) |
| Packaged maps read as text through the host's native read, with a fallback | Done | [Host map source](../src/engine/README.md#host-map-source-on-demand-maps) |
| Lazy indexed images | Done | General and battle image components can load one-tile CLUT8+PackBits entries on demand through a bounded LRU and free a battle's working set on exit; legacy eager `ui:img` sources remain supported. See [Battle UI kit](../README.md#battle-ui-kit-pocket-rpgkituibattle) |
| Endless generated world | Done | The `examples/wander` example |

## Editor

| Feature | Status | Notes |
| --- | --- | --- |
| Tile painting, passage overrides, one-way edges, undo/redo | Done | Tile layers and per-map passage work for inline and sharded maps; global sheet-edge editing is inline-only. [Editor](../editor/README.md) |
| Editing events, pages, conditions and command trees | Done | Every command and condition kind in the current project schema is editable; see [event command and condition editing](../editor/README.md#event-command-and-condition-editing) |
| Map properties; new, duplicate and delete maps | Done | Inline projects; a sharded session keeps the catalog structure fixed |
| Play-test from the selected tile with a live debug panel | Done | Inline projects run the unsaved document in the real `GameView`; the debug panel edits switches, variables, self switches, items and gold of the preview only and lists running pages and fibers. Unregistered extensions, battles and backdrops get visible stand-ins; sharded sessions save and reload the game instead. See [Editor](../editor/README.md) |
| Editor in the browser | Done | Opens local JSON, a self-contained sharded pack, or the bundled Sunstone and Meadow documents; Save uses browser-local storage, Download exports JSON or a complete replacement pack, and storage failures are visible. No project data is uploaded. See [Editor](../editor/README.md#in-the-browser) |
| Responsive editor chrome | Done | Header actions collapse behind **MORE** below 616 px; measured text fitting, clipped inspector hit regions and a persistent status bar keep the editor readable from 400×240 upward. See [What it does](../editor/README.md#what-it-does) |
| Follow-along tutorial | Done | [Editor tutorial](editor-tutorial.md) builds an NPC, a second map and a play-test from launch to save, with regenerable screenshots and a guard test |
| Studio: a browser-native editor (DOM + canvas) | Partial | Map painting (brush, rectangle, fill, eraser, eyedropper; ground, upper, passage and one-way edge layers), event/page/condition/command-tree editing with forms, map create/duplicate/delete/properties, undo/redo with a history panel, schema + `rpgkit-check` problems with jump-to, light/dark themes, local PNGs for any sheet or sprite id, an Agent panel that reviews a local agent's proposals (desktop app only). In Chrome and Edge it opens a project folder (shell plus map files) and saves the changed files back in place, one save at a time (a second Save waits for the first; a save that finishes after another project was opened reports the folder it wrote and does not mark the open project saved); a failed write puts back the files already replaced, but folder saves are not crash-atomic. The folder's shell must be `project.json`, `game.json` or its only top-level JSON file. Opening checks size and count limits before reading (32 MiB project files, 64 MiB packs, 64 MiB folders measured as the pack Studio edits, 8 MiB per map, 1,024 maps, 4,096 events per map, 16 MiB / 8,192 px PNGs). Every Studio edit is an `editor/api` operation. Limits: sharded packs keep their map catalog and sheet edges fixed. See [Studio](studio.md) |
| Studio drag and drop | Done | Drag a map in the map list to reorder the maps (one `move-map` operation; Alt+↑/↓ does the same from the keyboard), drag a command in the command tree to another place in the same list or into or out of a branch (one transaction of `delete-command` + `insert-command`), and drag an event on the canvas to move it (one `update-event`). A drop line, the dragged row or a ghost of the event with its target cell and coordinates show where it will land; Esc cancels; each drop is one undo step. Limits: sharded packs keep their map order (it is their fixed map index). See [Studio: Maps](studio.md#layout) and [Events](studio.md#events) |
| Studio keyboard shortcuts panel | Done | Press `?` (or the toolbar help button) for the grouped shortcut reference, including keyboard zoom (`=`/`+` and `-`), map-list `Home`/`End`, and drag gestures. See [Studio: Keyboard shortcuts](studio.md#keyboard-shortcuts) |
| Studio project art | Done | A project folder's own PNGs are drawn on the canvas: `art/sheets/<sheet id>.png` (or `sheets/<id>.png`), each image sprite's `src`, each walker sprite's `sheet`, else `art/sprites/<sprite id>.png`, relative to the shell's folder. Studio reads them when it opens the folder (browser and desktop), carries them as the optional `assets` of `rpgkit-edit/sharded-pack-v1`, and so a downloaded pack keeps its art and opening such a pack shows it again. Older packs and readers are unaffected. Limits: 4,096 images, 16 MiB each, 32 MiB together; animations are not drawn; a single project JSON file brings no art. See [Studio: Art](studio.md#art) |
| Studio play-test | Done | Play runs the open, unsaved document in the real engine, embedded from the site's `preview` page over `rpgkit-preview/v1`: start at the selected cell and facing, the project start or a bundled example's chapter; Reload with the latest document at the same place, Restart, Stop; a live readout of map, position, facing, frame, running pages and the open message; Esc hands the keyboard back. Sharded packs are put together into one inline document. The game draws the project's own sheets and sprites (folder art and local picks), sent with the document over the protocol's optional `art` messages; the rest keeps the editor's stand-in art, and the game plays the same either way. Limits: documents over the protocol's 4 MiB message limit are refused with the reason; art over 1,024 images or 32 MiB of pixels plays with stand-ins; animated tiles, map animations and backdrops always use stand-ins. See [Studio: Play-test](studio.md#play-test) |
| Studio host interface | Done | Files, storage, export, local art, checks, agents, the play-test connection and preferences go through `StudioHost`, and each host reports what it can do and why not. The web page uses the browser host, the desktop app its desktop host, and tests an in-memory host. A test scans every Studio script and page, `index.html` included, and allows those browser APIs (iframes and `postMessage` included) only in the two host files and their boot scripts; each page's pre-paint theme script is its host's, injected at build time. See [How it is built](studio.md#how-it-is-built) |
| Studio desktop app (Electron) | Partial | Studio in an Electron window (`studio-desktop/`, its own package and lockfile): project files and folders opened from native dialogs and saved in place through `editor/api/file.ts` (staged, rechecked, map files before the shell, rolled back on a failed rename, under `rpgkit-edit`'s lock), local agents whose edits come back as proposals reviewed in an Agent panel (single-file projects only), `rpgkit-check` engine checks (`locks`, `freeze`, `reach`) in the problems list, menus, Open Recent, a prompt before closing with unsaved changes, and the play-test. Sandboxed page with a strict CSP; the main process keeps real paths and confines folder access. Linux: built, packaged and tested end to end with Playwright. macOS: a GitHub Actions workflow builds a universal dmg and zip, signed and notarized when the signing secrets are set (not yet run with them); without them it builds unsigned. No Windows package, no auto-update. See [Studio desktop](studio-desktop.md) |
| PocketJS editor edits through `editor/api` | Done | Every PocketJS editor change (paint stroke, edge stroke, event, page, map and accepted proposal) is one `editor/api` operation run on the in-memory revision, and undo/redo replays its reversible `rpgkit-edit/patch-v1` edit, as in Studio and `rpgkit-edit`. A refused operation leaves the document and history unchanged and shows `EDIT REFUSED` in the status bar. `tests/editor-api-equivalence.test.ts` drives the same edit sequence through both editors and checks identical patches, undo/redo stacks and saved bytes. See [Protocols: edit protocol](protocols.md#2-edit-protocol--rpgkit-edit) |
| Large (sharded) projects in the editor | Done | Edits the map payloads of an existing `ProjectShell`: a virtual map list, lazy verified map reads, and saves that write only changed map files plus the shell. Desktop loose files and browser packs. Adding, duplicating or deleting maps, cross-map pickers, global sheet edges and proposal review need an inline project. Play-test works on sharded projects: Studio puts the pack together into one document and plays it (see Studio play-test above); the PocketJS editor's in-editor play-test with its debug panel is inline-only, and a sharded session there saves and reloads the game instead. `tools/editor-sharded-quickjs-check.sh` opens, paints and saves a sharded project in the real desktop QuickJS guest through the filesystem companion and checks the written files |
| Editing UI for the newer commands | Done | Movement control, presentation, map animations, shops, audio, extensions, battle setup and battle-result branches, loops (`<op>@body`) and `break`, the `eventTouch` trigger; see [Editor](../editor/README.md#event-command-and-condition-editing) and [`update-command`](edit-api.md#update-command) |

## Scripting and agent tools

| Feature | Status | Notes |
| --- | --- | --- |
| Protocol reference | Done | [Protocols](protocols.md) indexes the data, edit, QA, proposal, preview and save formats and the version/compatibility rules; the edit section states inline atomicity, sharded per-file publish with best-effort rollback (not crash-atomic), and the `validate`/map-id-rename all-shard exceptions |
| `rpgkit-edit` | Done | Edits inline and sharded projects from scripts and agents, JSON in and JSON out, with reversible patches and targeted shard writes. Available on the CLI and as MCP tools; see [Edit API reference](edit-api.md) |
| `rpgkit-check` | Done | Lint, input-lock audit (including causally linked automatic release events), freeze scan, exploration coverage and schematic screenshots. Walker build-source paths are not treated as runtime tile sheets; absent ids in partial audio tables remain located warnings. CLI dynamic checks and shots can load a trusted TypeScript/JavaScript `SessionOptions` module for game-owned extensions, scenes and battles; JSON/MCP calls retain the generic fallbacks. See [QA checks reference](qa-checks.md) |
| `rpgkit-check reach` | Done | Real-engine breadth-first search with a replayable witness for every reached map (a 60 Hz button tape replayed and verified at 60 Hz in a fresh session — no claim is made about other host frame rates); states dedupe on the engine's canonical state fingerprint, which zeroes the frame clock and rebases every absolute time anchor (a fiber's `since`, an animation's `start`) onto it, so persistent audio and other condition-relevant state are always in the key and same-elapsed-time states merge; a notFound map is a lead with frontier stats, not a proof. Frame/state/time budgets are execution limits (the search may run at most one 6-tick block past `maxFrames`); see [QA checks reference](qa-checks.md) |
| Importing RPG Maker MV/MZ projects | Partial | `bun tools/rpgmaker-import <project> --out <dir>` converts `data/*.json` into an `rpgkit-project/v1` document: maps with all four tile layers composed per cell (autotiles A1–A5 drawn from their quarter pieces, animated water, shadows, star tiles as the upper layer) into generated 16 px sheets with MV's four-direction passage; events, page conditions, Event Touch, move routes, structured Loop/Break Loop and live `\V[n]` text variables, with a coverage report per construct and a table of every MV/MZ command. Limits: labels/jumps are dropped, plugins and scripts become visible placeholders, battles a placeholder `battle` command, no actors/classes/battle system, audio not converted, encrypted projects refused. Tested on two self-written projects (`tests/fixtures/rpgmaker`). See [Importing RPG Maker projects](rpgmaker-import.md) |
| AI edit proposals reviewed in the editor | Done | Validated sidecar queue with ghost previews, per-hunk accept/reject, live conflict checks and crash-safe archival; currently limited to inline projects through the desktop bridge. See [Editor](../editor/README.md#what-it-does) |
| Natural-language box in the editor that drives a local agent | Done | Inline desktop projects only. Built-in TraeCLI and Claude Code adapters plus a custom command template run with a scrubbed environment, bounded process group, and per-launch authenticated loopback companion. Requests carry current map/cell/event context and can only create review proposals through a proposal-only MCP server; see [Editor](../editor/README.md) and [agent integration](edit-api.md#editor-local-agent-integration) |
| Explaining an event; health check with suggested fixes | Planned | |

## Web embedding

| Feature | Status | Notes |
| --- | --- | --- |
| `rpgkit-preview/v1` postMessage protocol | Done | Embed the real engine in another web page: `load` a project document, `start` at a tile or chapter, read `state`, inject `input`, `stop`; optionally send the project's own sheet and sprite images first (`art`, offered by pages whose `ready` lists the `art` feature; 1,024 images, 32 MiB of pixels). Origin-allowlisted, versioned, and bounded in UTF-8 bytes (a lone surrogate counts as the 3-byte U+FFFD, as `TextEncoder` encodes it): 4 MiB message, 64 chapters, 1 MiB snapshot, 36000-frame tape; over-budget input refused as `too-large` before any expensive work, and an oversized string is only scanned until the budget is exceeded; a present `requestId` must be a non-empty bounded string and notification errors stay contained. See [Protocols](protocols.md#5-preview-protocol--rpgkit-previewv1) |
| Preview host app and reference frontend | Done | The site's `preview` player page is the host (`?embed` shows only its game screen, for framing pages such as Studio); `preview-demo.html` pastes a document and plays it. The frontend accepts replies only from the embedded host window (origin **and** source checked), so same-origin spoofs are ignored. Zero cost to other games: the protocol lives entirely in the preview app's own bundle |

## Hosts

| Host | Status | Notes |
| --- | --- | --- |
| Desktop (Linux, macOS) | Done | [Target matrix](../README.md#target-matrix) |
| Guest code uses only what the QuickJS guest provides | Done | A test type-checks every app, test fixture and package export and refuses globals or built-in members the desktop QuickJS realm lacks (`structuredClone`, `TextEncoder`, `setTimeout`, …) and non-guest imports; the allowlist is measured on the desktop host. See [Guest globals](../README.md#guest-globals) |
| Web (wasm) | Done | Per-game 1×–4× raster density with a 2× default, native-density text and integer device-pixel presentation. Static player pages mount host audio after a user gesture and provide mute/master-volume controls. [Play in the browser](../README.md#play-in-the-browser) |
| Headless simulator for tests | Done | |
| PSP | Partial | This repository does not gate it; a consuming app is admitted through PocketJS's `pocket check --target psp` |
