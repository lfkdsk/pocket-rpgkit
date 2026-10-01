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
| Map animations on a tile or following a character (`mapAnim` / `stopAnim`) | Done | [Map animations](../README.md#map-animations-mapanim--stopanim) |
| Run-time appearance, named visual layers, tile passage overrides | Done | Appearance covers sprite, opacity and visibility (`appearance`). Visual layers can be bands below or above characters, or screen overlays (`layer`). Tile passage overrides use `tileProperty`. Layer and tile-property overrides reset on every transfer |
| Screen effects | Done | Fade, composable named tints, flash, deterministic shake, camera scroll, character balloons, full-screen backdrops. All are saved and rewound with the session |
| Pictures (show / move / rotate / tint / erase) | Planned | |
| Weather particles | Planned | Colour overlays already work through screen layers and tints |

## Audio

| Feature | Status | Notes |
| --- | --- | --- |
| Sound effects (`playSe`; legacy `se`) | Done | Ordered deterministic cues and the opt-in PocketJS WAV bridge work; missing hosts or resources degrade to silence. See [Opt-in host audio](../README.md#opt-in-host-audio) |
| Background music, ambience and music effects (BGM / BGS / ME) | Partial | Playback, fades, pause/resume, saves/rewind, `bgmPlaying`, and battle BGM swap/restore work. The host bridge is WAV-only and ME duration is authored rather than read from media. See [Opt-in host audio](../README.md#opt-in-host-audio) |

## Scenes and menus

| Feature | Status | Notes |
| --- | --- | --- |
| Battle scenes and battle UI kit | Done | A game registers a battle scene; `battle` parks the event until it ends and runs its win/lose/escape branch. The kit provides state-driven battle UI blocks; see [Battle UI kit](../README.md#battle-ui-kit-pocket-rpgkituibattle) |
| The map world stays alive during battles | Done | Entering or leaving a battle does not rebuild the map. The map/dialog stay mounted but hidden; map clocks freeze by default, while battle audio can switch and restore without remounting its driver |
| Generic full-screen game scenes and a name-input screen | Planned | In progress |
| Menu and save access switches, game over, return to title | Planned | |

## Saves, rewind and demos

| Feature | Status | Notes |
| --- | --- | --- |
| Save slots and save codes | Done | Slots use `data.fs` on desktop; the web falls back to save codes. Loaded snapshots are validated |
| Attract mode | Done | Plays a tape after 10 idle seconds; any button takes over, **L** rewinds 3 virtual seconds, using bounded keyframes |
| Byte-identical replays on every host and simulation rate | Done | No wall clock and no `Math.random` in the engine |

## Maps and resources

| Feature | Status | Notes |
| --- | --- | --- |
| Large projects split into a map shell plus maps loaded on demand from the pak | Done | [Large projects](../README.md#large-projects-maps-as-on-demand-entries) |
| Packaged maps read as text through the host's native read, with a fallback | Done | [Host map source](../src/engine/README.md#host-map-source-on-demand-maps) |
| Endless generated world | Done | The `examples/wander` example |

## Editor

| Feature | Status | Notes |
| --- | --- | --- |
| Tile painting, passage overrides, one-way edges, undo/redo | Done | [Editor](../editor/README.md) |
| Editing events, pages, conditions and command trees | Done | Newer commands are shown read-only: screen effects, map animations, movement control, audio, extensions |
| Map properties; new, duplicate and delete maps | Done | |
| Play-test from the selected tile with a live debug panel | Done | Runs the unsaved document in the real `GameView`; the debug panel edits switches, variables, self switches, items and gold of the preview only and lists running pages and fibers. Unregistered extensions, battles and backdrops get visible stand-ins; see [Editor](../editor/README.md) |
| Large (sharded) projects and an editor in the browser | Planned | |
| Editing UI for the newer commands | Planned | |

## Scripting and agent tools

| Feature | Status | Notes |
| --- | --- | --- |
| `rpgkit-edit` | Done | Edits projects from scripts and agents, JSON in and JSON out, with reversible patches. Available on the CLI and as MCP tools; see [Edit API reference](edit-api.md) |
| `rpgkit-check` | Done | Lint, input-lock audit, freeze scan, exploration coverage and schematic screenshots. Available on the CLI and as MCP tools; see [QA checks reference](qa-checks.md) |
| `rpgkit-check reach` | Partial | Experimental: neither "reachable" nor "unreachable" is a proof. In progress: a rebuild that searches with the real engine and returns a replayable input tape for every map it reaches |
| AI edit proposals reviewed in the editor | Planned | In progress: ghost preview, accept or reject each hunk |
| Natural-language box in the editor that drives a local agent | Planned | |
| Explaining an event; health check with suggested fixes | Planned | |

## Hosts

| Host | Status | Notes |
| --- | --- | --- |
| Desktop (Linux, macOS) | Done | [Target matrix](../README.md#target-matrix) |
| Web (wasm) | Done | Per-game 1×–4× raster density with a 2× default, native-density text and integer device-pixel presentation; [Play in the browser](../README.md#play-in-the-browser) |
| Headless simulator for tests | Done | |
| PSP | Partial | This repository does not gate it; a consuming app is admitted through PocketJS's `pocket check --target psp` |
