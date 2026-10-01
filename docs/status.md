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
| Event pages with `action`, `playerTouch`, `autorun` and `parallel` triggers; common events | Done | [The 46 commands](../README.md#the-46-commands) |
| Dialog: typewriter text, choices with 2–8 options (scrolling past 4) and a cancel branch | Done | |
| Dialog themes and speaker portraits | Done | [Themes and speaker portraits](../README.md#themes-and-speaker-portraits) |
| Switches, self switches, items, gold | Done | |
| Variables: set/add/sub, seeded random ranges, arithmetic against another variable | Done | Numbers only |
| Page and `if` conditions on switches, variables, self switches, items, gold, facing, appearance, tile-property overrides, `worldIdle`, `bgmPlaying`, or an extension predicate | Done | |
| Cross-event input lock (`lockInput` / `unlockInput`) | Done | |
| Map transfers with an optional fade and variable targets | Done | |
| Game extensions | Done | Namespaced pure commands (`ext`) and choice boxes whose rows come from an extension (`extChoice`); see [Game extensions and Battle Processing](../README.md#game-extensions-and-battle-processing) |
| Shops (RPG Maker MV-style buy and sell) | Done | |
| Text interpolation (`\V[n]`, `\N[n]`) and string values | Planned | |
| Step counter and region triggers | Planned | |
| Number input, item selection, scrolling text, timers | Planned | |

## Movement

| Feature | Status | Notes |
| --- | --- | --- |
| Player and NPC movement over the passage table, with one-sided entry/exit edges and NPC collision | Done | |
| Move routes | Done | Moves, turns, waits, deterministic `pathTo` and `approach` |
| Run-time movement control (`moveControl`) | Done | Autonomous mode, stop, bounded wander, and speed/run/frequency/collision/facing overrides. Projects that never use it run a separate loop and pay nothing per frame |
| Relocating the player or an event (`place`) | Done | |
| Followers and vehicles | Planned | |

## Presentation

| Feature | Status | Notes |
| --- | --- | --- |
| Large maps | Done | Streamed rendering, animated tiles, 16×16 and 16×32 walkers; see [Large-map streamed rendering](../README.md#large-map-streamed-rendering) and [Animated map tiles](../README.md#animated-map-tiles-and-1632-walkers) |
| Actor node pool sized to the current map | Done | NPC/event image nodes are allocated per current map and grow (never shrink) when a transfer lands on a busier map, so small maps no longer pre-build the project's global event maximum; growth rebinds existing nodes instead of rebuilding them |
| Map animations on a tile or following a character (`mapAnim` / `stopAnim`) | Done | [Map animations](../README.md#map-animations-mapanim--stopanim) |
| Run-time appearance, named visual layers, tile passage overrides | Done | Appearance covers sprite, opacity and visibility (`appearance`). Visual layers can be bands below or above characters, or screen overlays (`layer`). Tile passage overrides use `tileProperty`. Layer and tile-property overrides reset on every transfer |
| Screen effects | Done | Fade, composable named tints, flash, deterministic shake, camera scroll, character balloons, full-screen backdrops. All are saved and rewound with the session |
| Tuxemon-styled feature gallery | Done | A numbered town plaza connects thirteen themed rooms, with attributed pixel art, per-room screenshots and browser chapter cards; see the [gallery catalogue](../examples/showcase/README.md) |
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
| Save slots and save codes | Done | Slots use `data.fs` on desktop; the web falls back to save codes. Loaded snapshots are validated |
| Attract mode | Done | Plays a tape after 10 idle seconds; any button takes over, **L** rewinds 3 virtual seconds, using bounded keyframes |
| Demo controls and web deep links | Done | Opt-in chapter starts, safe map warp and 1×/2×/4× autoplay through [`pocket-rpgkit/ui/demo`](../README.md#demo-controls-pocket-rpgkituidemo); web chapter cards support preview images and descriptions, jump the running game without a reload, and retain query-link fallbacks. Desktop has the menu but no guest argv/environment launch bridge |
| Byte-identical replays on every host and simulation rate | Done | No wall clock and no `Math.random` in the engine |

## Maps and resources

| Feature | Status | Notes |
| --- | --- | --- |
| Large projects split into a map shell plus maps loaded on demand from the pak | Done | Faded transfers stage parse, validation, world compilation and passage compilation on separate reference ticks; see [Large projects](../README.md#large-projects-maps-as-on-demand-entries) |
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
| Large (sharded) projects in the editor | Done | Edits the map payloads of an existing `ProjectShell`: a virtual map list, lazy verified map reads, and saves that write only changed map files plus the shell. Desktop loose files and browser packs. Adding, duplicating or deleting maps, cross-map pickers, global sheet edges, play-test and proposal review need an inline project |
| Editing UI for the newer commands | Done | Movement control, presentation, map animations, shops, audio, extensions, battle setup and battle-result branches; see [Editor](../editor/README.md#event-command-and-condition-editing) and [`update-command`](edit-api.md#update-command) |

## Scripting and agent tools

| Feature | Status | Notes |
| --- | --- | --- |
| `rpgkit-edit` | Done | Edits inline and sharded projects from scripts and agents, JSON in and JSON out, with reversible patches and targeted shard writes. Available on the CLI and as MCP tools; see [Edit API reference](edit-api.md) |
| `rpgkit-check` | Done | Lint, input-lock audit, freeze scan, exploration coverage and schematic screenshots. Available on the CLI and as MCP tools; see [QA checks reference](qa-checks.md) |
| `rpgkit-check reach` | Done | Real-engine breadth-first search with a replayable witness for every reached map (a 60 Hz button tape replayed and verified at 60 Hz in a fresh session — no claim is made about other host frame rates); states dedupe on the engine's canonical state fingerprint, which zeroes the frame clock and rebases every absolute time anchor (a fiber's `since`, an animation's `start`) onto it, so persistent audio and other condition-relevant state are always in the key and same-elapsed-time states merge; a notFound map is a lead with frontier stats, not a proof. Frame/state/time budgets are execution limits (the search may run at most one 6-tick block past `maxFrames`); see [QA checks reference](qa-checks.md) |
| AI edit proposals reviewed in the editor | Done | Validated sidecar queue with ghost previews, per-hunk accept/reject, live conflict checks and crash-safe archival; currently limited to inline projects through the desktop bridge. See [Editor](../editor/README.md#what-it-does) |
| Natural-language box in the editor that drives a local agent | Done | Inline desktop projects only. Built-in TraeCLI and Claude Code adapters plus a custom command template run with a scrubbed environment, bounded process group, and per-launch authenticated loopback companion. Requests carry current map/cell/event context and can only create review proposals through a proposal-only MCP server; see [Editor](../editor/README.md) and [agent integration](edit-api.md#editor-local-agent-integration) |
| Explaining an event; health check with suggested fixes | Planned | |

## Hosts

| Host | Status | Notes |
| --- | --- | --- |
| Desktop (Linux, macOS) | Done | [Target matrix](../README.md#target-matrix) |
| Web (wasm) | Done | Per-game 1×–4× raster density with a 2× default, native-density text and integer device-pixel presentation. Static player pages mount host audio after a user gesture and provide mute/master-volume controls. [Play in the browser](../README.md#play-in-the-browser) |
| Headless simulator for tests | Done | |
| PSP | Partial | This repository does not gate it; a consuming app is admitted through PocketJS's `pocket check --target psp` |
