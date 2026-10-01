# pocket-rpgkit

A reusable 2D tile-RPG runtime and the **`rpgkit-project/v1`** data format,
built on [PocketJS](https://github.com/pocket-nexus/pocketjs). It contains
the parts an RPG-Maker-style game needs without any specific game:

- **pure-TS engine** (`src/engine/`) — tile movement and collision, the
  event interpreter (pages, triggers, 47 commands), map-character motion,
  multi-map sessions, deterministic extension state and battle scenes,
  deterministic save snapshots. No host imports, no
  wall clock, no `Math.random`: a session is one pure fold per virtual
  frame, so a button tape replays byte-for-byte on every host;
- **Solid UI components** (`src/ui/`) — `GameView`, a complete game screen
  for a project (chunked maps, scripted/follow camera, NPCs, dialog, screen
  fades/tints/flashes/shakes, character balloons, cutscene backdrops, and
  optional attract mode), plus the blocks it is made of: `DialogBox`,
  `PlayerSprite`, `ChunkLayer`, `StreamedChunkLayer`, `AnimatedTiles`,
  `SaveMenu`, `Panel`.
  The framed ones take a
  colour theme, and `DialogBox` shows speaker portraits;
- **attract mode** (`src/engine/attract.ts`) — after 10 idle seconds a
  recorded playthrough replays from a clean world; any button takes over
  on that very frame, **L** rewinds 3 virtual seconds, and **SELECT** hands
  the session back to the demo (or opens the optional demo menu). Demo and player input are one u16 stream,
  so rewind undoes the player's moves exactly like the tape's. Runtime-only,
  bounded keyframes make a long-tape rewind fold only a short suffix;
- **host adapters** (`src/host/`) — the `data.fs` save slot store and the
  attract-tape override loader;
- **build-time asset pipelines** (`tools/lib/`) — tile sheets to baked
  512px PSM_4444 canvases and chunks, or 256px CLUT8+RLE streamed chunks,
  one-image CLUT8+PackBits entries loaded only when shown, native animated-tile
  atlases, 16×16 or 16×32 static walker frames, and the `GameAssets` manifest
  a game mounts;
- **the format** (`src/data/schema.json`, v1; changes recorded in
  `src/data/CHANGELOG.md`);
- **five examples** (`examples/`), each a PocketJS app with its own art
  and tests on the wasm sim host (below);
- **a map/event editor, in preview** (`editor/`): paints tiles, edits event
  footprints/pages/conditions/command trees, and runs the unsaved document
  through the production game view with a live state debugger
  ([below](#editor-preview)).

What is done, partial or still planned is tracked area by area in
[docs/status.md](docs/status.md).

## Examples

### `examples/showcase` — Pocket RPG Kit Feature Gallery

![The Tuxemon-styled feature town and themed rooms](docs/screenshots/showcase-overview.png)

One walkable miniature monster-RPG town collects the kit's presentation,
animation, movement, extension, battle, shop, streaming, theme, save,
deterministic-replay, audio and scene features in fourteen repeatable halls.
The Registration Desk uses the built-in name-input scene and addresses the
player by that name in later dialogue. Its
[room-by-room catalogue](examples/showcase/README.md) links each demonstration
to its authoring source and the separately licensed Tuxemon assets.

| | |
| --- | --- |
| ![Sunstone attract takeover](tests/goldens/sunstone-attract.700.png) | ![Grown village, snow biome](tests/goldens/grow.2028.png) |
| **`examples/sunstone`** — *The Sunstone of Bramble Hollow*, a three-map RPG (village → forest → cave: key chest, rune stone, thorn and iron gates, the relic). Idle for 10 s and it plays itself from a frozen 539-frame winning tape; press any button to take over mid-demo, **L** to rewind, or **SELECT** for chapters, map warp and autoplay speed. | **`examples/grow`** — four settlements grow to the right from one seeded rule set (roads, homes, fields, residents) through grass, mud, sand and snow. Scrub the timeline (**L/R**, touch, or mouse drag) to any tick — each is a pure re-grow — **SQUARE** for a new seed, **CIRCLE** to walk into the finished village, which is played as a generated `rpgkit-project/v1` document. |

On the macOS desktop host (`bun run desktop sunstone`, `bun run desktop
grow`; Metal, captured on an Apple M5 Pro):

| | |
| --- | --- |
| ![Sunstone takeover on macOS](docs/screenshots/macos-sunstone-takeover.png) | ![Grow on macOS](docs/screenshots/macos-grow-growing.png) |

### `examples/wander` — an endless world that grows as you walk

| | |
| --- | --- |
| ![Wander at 960x544: a grown town beside a snow border](tests/goldens/wander.960.2100.png) | ![Wander on macOS: a snow town, walking to a clicked tile](docs/screenshots/macos-wander.png) |
| A grown town beside a snow border (sim golden) | On the macOS desktop host (`bun run desktop wander`), walking to a clicked tile |

An unbounded 2D world streams in and out of memory around the walker.
Nothing about it is stored: every 32×32-tile chunk is a pure function of
the seed and its coordinates (tested byte-identical in any generation
order, after eviction, and at (±100000, ±100000)), so the only state is a
cache. Biomes are low-frequency 2D noise cut into snow, grass, mud and
sand, with grow's transition / blend / fringe seam art on every border;
woods and meadows are grow's coordinate-hashed Ninja stamps.

- **Regions and gates.** Every 96×96-tile region holds at most one town,
  placed by hashed jitter with a chance by biome, and grown with grow's
  rules in 2D (plaza, main and cross street, road-facing lots and a back
  lane, the biome's work plot, one resident per house walking a road
  route). Each shared region edge has a hashed gate that both sides
  compute identically; each region runs its own trunk road from its town
  (or a signposted crossroads) to its gates, so roads meet across region
  borders without any global state.
- **Growth.** When a town first enters the growth ring ahead of the
  walker it grows over a few seconds — roads, then houses, fields,
  residents — and its state at *t* seconds after discovery is "every cell
  born by then". A bounded Bloom filter remembers what was seen; a region
  met again shows complete.
- **Rings.** The render ring (viewport plus overscan) is the only thing
  mounted, as pooled native nodes with a hard cap (whole-stamp trees and
  houses, 256 and 64 px fills, 16 px seams and roads). The load ring
  generates chunks, the unload ring (load + hysteresis) evicts them, and a
  hard LRU cap and byte estimate bound the cache. Generation is a work
  queue ordered by distance to the focus (the walker plus a lead) and
  alignment with the heading, spent in slices under a per-tick budget; an
  unready chunk shows its biome's fill and fills in when it arrives.
- **Walking.** The kit's unchanged engine plays a sliding 3×3-chunk window
  emitted as a normal `rpgkit-project/v1` document. Entering a new chunk
  re-centres it (a floating origin): the next window is built in budgeted
  slices and the session state is translated, so positions stay small and
  exact and nothing on screen moves. Houses, fences, props and tree trunks
  block; canopies are walked under; residents walk their routes.
- **Attract.** An auto-wander driver (A* over the window, preferring
  roads) walks from town to town by itself. Any d-pad or face button takes
  over; ten idle seconds hand the walk back. **SQUARE** grows a new seed,
  **TRIANGLE** toggles fast travel, **SELECT** hands back at once, and a
  tap walks to the tapped tile. The HUD shows the seed, world
  coordinates, the chunk minimap (rendered / resident / queued / evicted,
  with the load and unload rings) and the residency counters.

Generation, discovery and the window swap all happen per 60 Hz reference
tick, so the world, its residency and the auto-wander trajectory are
identical at 60/30/20/4 Hz. The example bakes no new terrain: it points at
grow's PNGs in place (`../grow/assets/...`) and adds only whole-stamp and
64 px fill composites of them (`bun examples/wander/gen-assets.ts`).

**`examples/meadow`** is the minimal example: one 20×12 map and four
events proving the package boots, renders, replays deterministically,
and round-trips on the PocketJS wasm sim host.

Everything runs on a fixed 60 Hz virtual-time reference: a host at 30,
20 or 4 Hz folds 2, 3 or 15 reference ticks per frame, so the world at a
given virtual moment is the same at every rate (the journey tests drive
each example's winning run at 60/30/20/4 Hz and compare milestones).

The runtime pins PocketJS with a git submodule at
`vendor/pocketjs` (commit recorded in `git submodule status`).

## Play in the browser

The examples and the editor run in the browser at
**<https://lfkdsk.github.io/pocketjs-rpgkit/>**. Each page runs its bundle on
the PocketJS core compiled to WebAssembly: the same bundle and core the sim
tests use. On a game page, click the game (it also takes the keyboard when the
page loads), then use the arrow keys and **A**/**Enter**/**Z** to confirm.
Each page lists the rest of its controls. Grow's timeline also takes a mouse
or touch drag, and phones get on-screen buttons.

The [browser editor](https://lfkdsk.github.io/pocketjs-rpgkit/editor/) can
open a local `rpgkit-project/v1` JSON file or start from the bundled Sunstone
and Meadow projects. **Save** keeps the current document in this browser's
local storage, **Download** writes a JSON file, and a refresh restores the
locally saved document. Project data is not uploaded. Storage errors are
shown on the page; use Download for a durable copy. The browser editor uses
the bundled example art and inline project documents: it does not import
assets or edit large sharded projects.

To build the site locally (no dev server; any static file server works):

```sh
bun run build:wasm                      # once: the wasm core
bun run web                             # dist/web: landing page, examples and editor
python3 -m http.server -d dist/web 8000 # then open http://localhost:8000/
bun tools/web-verify.ts                 # optional: play every page in headless Chrome
```

`bun run web` builds every app in `APPS` (`tools/build-example.ts`), including
the editor, and `bun run web grow` builds one named app. Each app is resolved
against the `web-app` target from its `pocket.json`. Card text, preview images
and controls come from `web.json`. An example without an entry still gets a
card: its `pocket.json` title, default controls, and a preview rendered from
its own bundle. Every URL is relative, so the site works under any path.
`.github/workflows/pages.yml` publishes `dist/web` to GitHub Pages on every
push to `main`. Player pages mount the PocketJS audio
host before the game starts, load their AudioWorklet relative to the page,
and expose mute and master-volume controls. Browsers start the audio clock on
the first key or pointer gesture, as required by their autoplay policies.

Web builds use a 2× raster density by default so fonts and vector assets are
baked and drawn at two physical samples per logical pixel. Set
`rasterDensity` on a game's `web.json` entry to choose an integer from 1
through 4:

```json
{
  "games": {
    "meadow": {
      "rasterDensity": 2
    }
  }
}
```

Density changes the browser build only. Desktop, PSP and other targets keep
the density from their own target contract. A 1× PNG without an `@2x` variant
is still sampled with nearest-neighbour filtering, so pixel-art tiles and
walkers stay hard-edged; fonts and available density-specific assets gain the
extra detail. The backing framebuffer uses `density²` as many pixels, and
font/vector entries make the pak larger, so 2× is the recommended balance.
Use 1× for lower-powered browsers, and reserve 3× or 4× for projects that have
measured the extra memory and raster cost.

The player also snaps its presentation scale to a multiple of the raster
density. Consequently each backing-store sample occupies a whole number of
device pixels whenever the viewport can fit at native density, including on
fractional-DPR displays. A window too small to fit one native-density frame
falls back to a fitted presentation instead of overflowing.

A game that vendors this kit builds its own site the same way, for example
Alpine Post:

```sh
bun vendor/pocket-rpgkit/tools/web.ts --project-root . alpine-post
```

The site also serves **`preview-demo.html`**, the reference frontend for the
`rpgkit-preview/v1` postMessage protocol: paste any `rpgkit-project/v1`
document and play it in the embedded host — load, start at a tile, read
state, inject input, stop. See [Protocols](#protocols).

## Quick start

```sh
git clone --recurse-submodules https://github.com/lfkdsk/pocketjs-rpgkit.git
cd pocket-rpgkit
bun install
bun test                 # reducer/format/controller suites; sim cases skip
bun run build:wasm       # one-time: compile the vendored sim core
bun run build:example    # build showcase and the other examples, editor and test fixtures into dist/
bun test                 # full suite incl. sim journeys and pixel goldens
bunx tsc --noEmit        # typecheck, exit 0
bun run desktop sunstone # build for the desktop host and open a window
                         # (also: grow, wander, meadow; needs a Rust toolchain)
bun run web              # the browser site in dist/web (see above)
```

On a Mac, `bun run package:macos sunstone` (or `grow`, `wander`, `meadow`) makes a
double-clickable `dist/macos/<Name>.app` plus a zip to hand around: the
desktop host, the example's bundle and pak, an icon cropped from its
golden frame, and the licenses. It is built for the Mac's own
architecture and ad-hoc signed, not notarized, so a downloaded copy opens
the first time with right-click > Open (or Privacy & Security > Open
Anyway). A game that vendors this kit packages itself with
`bun vendor/pocket-rpgkit/tools/package-macos.ts --project-root .`
(`--name`, `--icon <png>`, `--icon-crop x,y,w,h` to taste).

`bun run build:example sunstone` builds one example. `bun run gen-assets`
regenerates every example's baked art from its `assets/src/` (and then the
editor's tile cells from those sheets); the cookers are deterministic and
reproduce the committed PNGs byte for byte.

## Editor (preview)

`editor/` is a map/event editor for `rpgkit-project/v1` documents and a
PocketJS app on both the desktop host and the
[browser site](https://lfkdsk.github.io/pocketjs-rpgkit/editor/). It opens the
Sunstone and Meadow documents (`examples/*/data/*.json`) and paints them with
those examples' own Kenney tile sheets. The browser can also **Open** a local
inline project; **Save** keeps it in that browser, **Download** exports JSON,
and a refresh restores the locally saved copy. Nothing is uploaded.

For editing in a browser there is also **Studio**
([`docs/studio.md`](docs/studio.md),
[hosted](https://lfkdsk.github.io/pocketjs-rpgkit/studio/)): a DOM + canvas
editor with a zoomable canvas, tile palette, inspector forms and a history
panel. Studio edits through the `editor/api` operations that `rpgkit-edit`
runs; this PocketJS editor still uses its own reducers and undo/redo in
`editor/engine/model.ts` (moving it onto `editor/api` is planned). The two
share the file formats, schema validation and the save serializer, and a
test in `tests/studio-session.test.ts` checks that the same edits save to
identical bytes in both. This PocketJS editor is the one that also runs on
devices.

What it does today:

- paint ground tiles by click or drag; the first header button cycles
  ground, sparse upper (star), passage, and event modes; right click or
  shift+click erases tiles;
- paint per-cell `passage` overrides (pass/block) and toggle one-sided
  sheet `dirEdges` enter/exit edges, with corner markers and edge arrows;
- select and drag full multi-cell event footprints; create, copy, delete,
  resize and name events;
- add, delete, copy and reorder pages; edit triggers, sprites, facing,
  blocking, autonomous/basic route motion, and flat/compound conditions;
- inspect recursive command trees with visible `if`, choices, battle and
  scene branches; structurally edit the built-in authoring commands while
  preserving `shop`, `ext`, `battle`, `scene`, and advanced route payloads
  read-only;
- pick a transfer command's destination on the canvas (PICK button, then
  click a cell on any map);
- map inspector: rename (following `start.map` and every transfer),
  resize, edit sheets, and create/duplicate/delete maps (delete lists
  every transfer reference with a pageable command location and asks for a
  second confirm); inspector-local notices keep crop lists and save errors
  visible;
- review AI edit proposals for inline desktop projects from **PROPOSALS**:
  inspect author/rationale and
  per-hunk conflict state, locate each hunk, preview proposed tiles as
  translucent art and event changes as color-coded boxes, then accept or
  reject one hunk or accept every clean hunk; one accept action is one undo
  step and rejection never edits the document;
- ask a configured local agent for a proposal from the natural-language box
  for an inline desktop project;
  the request carries the current map and explicit cell/event selection, and
  the agent's MCP server permits proposal creation but no direct project edit;
- undo/redo, one step per tile stroke or event/map transaction, 64 steps
  deep (header buttons or Cmd+Z / Cmd+Shift+Z);
- switch between a document's maps; the palette shows the sheets the
  current map declares;
- open a sharded `ProjectShell` with a virtualized map catalog, load maps on
  demand into a bounded clean-map cache, and save only dirty shards plus the
  refreshed shell after host acknowledgement;
- save through the schema validator (`src/data/schema.json`): an invalid
  export is refused with its first error, an unedited one saves back byte
  for byte, and an edit reuses untouched event/source spans without a
  whole-file reformat;
- PLAY the current in-memory document (unsaved edits included) through the
  production `GameView`, starting at the last selected cell or the authored
  project start; STOP/Escape/START returns without replacing editor state or
  undo history;
- open a live debugger for switches, variables, current-map self switches,
  items, gold, active pages and fiber command addresses; FRESH/LAST chooses
  whether the next run inherits the previous run's switches and variables;
- visibly degrade missing game registrations: unknown extensions are
  disabled, battles use a deterministic win/escape preview, unregistered
  scenes use a visible placeholder, and screen backdrops use placeholders
  instead of crashing the editor.

Not yet: common-event lists, asset import, or sheet-level `dirBlock` /
`defaultPassage` editing. The grow example's generated settlement is not
wired in: its sheet is synthesized by its cooker rather than cut from a
source PNG.

```sh
bun run editor                    # Sunstone, on a working copy in dist/editor/
bun run editor meadow             # Meadow
bun run editor sunstone --file my-map.json   # another file (seeded if missing)
bun run editor --agent traecli       # default built-in local-agent adapter
bun run editor --agent claude        # Claude Code adapter
bun run editor --agent-config editor/agent-config.example.json
bun run editor --file game/data/project.json # existing sharded ProjectShell
bun run editor --build-only       # bundle + release host, no window
```

The desktop launcher builds `dist/<target>/editor.{js,pak}` and the Rust host,
then opens the window with the `rpgkit-editor` companion and `--file`: the
host forwards the real mouse and keyboard and writes each save to that
file, by default a working copy in `dist/editor/` seeded from the
example (the example games build their documents from code, and
`bun run gen-assets` rewrites `data/*.json`).
The launcher also bridges `<project.json>.proposals/` into the editor's
sandboxed `data.fs` and writes review decisions back while the window is
open. Fully reviewed proposals move to the sidecar's `archive/` directory.
A sharded project (a `ProjectShell` with separate map files) instead uses a
confined file companion that sends only the shell at first, answers map reads
lazily, and commits changed shards before the refreshed shell; proposal
review and local-agent requests are unavailable in that session.
For an inline project, the same launcher owns the optional local-agent process
and sends only its proposal results back to the editor. Adapter and custom
command details are in the
[agent integration reference](docs/edit-api.md#editor-local-agent-integration).
The website supplies its own browser companion for pointer and keyboard
input, local storage, Open and Download. It also opens a self-contained
`rpgkit-edit/sharded-pack-v1` file and downloads a complete replacement pack;
it cannot overwrite a local directory. Without a companion (the bare wasm
sim, or a browser other than the website) the editor runs from buttons behind
a visible banner.
`bun run build:editor` builds the sim bundle alone; the editor's tests include
`tests/editor-model.test.ts`, `tests/editor-sim.test.ts`, the proposal review
golden in `tests/editor-proposal-sim.test.ts`, the offline local-agent flow in
`tests/editor-agent-sim.test.ts`, the two-size event
inspector/runtime round trip in `tests/editor-event-sim.test.ts`, and the
real-GameView play/debug goldens in `tests/editor-playtest-sim.test.ts`.
[`docs/editor-tutorial.md`](docs/editor-tutorial.md) follows one small
scenario — a villager NPC, a second map, and a play-test — from launch to
save, with regenerable screenshots and a guard test. More in
[`editor/README.md`](editor/README.md); the tile art's licenses are in the
examples' `ATTRIBUTION.md` files.

## Scripting and agents

`rpgkit-edit` exposes the editor's pure model as a stable JSON-in/JSON-out
interface. It is meant for scripts and coding agents that should edit project
documents without joining the running game or editor process. Every request
parses and validates the input document first. Every effective project mutation is
validated again, returns JSON Pointer changes with before/after values and an
`rpgkit-edit/patch-v1` reversible patch. Inline projects are atomically
replaced as one file. Sharded updates stage and conflict-check all outputs,
then publish changed shards before the shell manifest with best-effort
rollback; they are not crash-atomic across files.
`--dry-run` follows the same path but never writes. The full parameter,
output, error-code and MCP reference for every subcommand is
[`docs/edit-api.md`](docs/edit-api.md).

```sh
# Discover stable map/event/page/command addresses.
bun run rpgkit-edit list-maps --file game/data/project.json
bun run rpgkit-edit list-events --file game/data/project.json \
  --json '{"map":"village"}'
bun run rpgkit-edit list-commands --file game/data/project.json \
  --json '{"map":"village","event":"elder","page":0}'

# Preview one edit. stdout is exactly one JSON result.
bun run rpgkit-edit paint-rect --file game/data/project.json --dry-run \
  --json '{"map":"village","layer":"ground","x":4,"y":6,"width":3,"height":2,"tile":"town.43"}' \
  > preview.json

# Apply that exact patch later (use direction:"reverse" to undo it).
jq '{patch:.patch}' preview.json > apply.json
bun run rpgkit-edit save --file game/data/project.json --json @apply.json
```

For human-reviewed AI work on an inline project, group typed edit operations
into explicit hunks and create a proposal instead of mutating the project:

```json
{
  "id": "agent-welcome-path-1",
  "title": "Clarify the welcome path",
  "rationale": "Guide the player toward the elder without changing collision.",
  "author": "local-agent",
  "hunks": [
    {
      "id": "entrance-tiles",
      "summary": "Brighten two entrance tiles",
      "operations": [
        {
          "command": "paint-rect",
          "args": {
            "map": "village",
            "layer": "ground",
            "x": 4,
            "y": 6,
            "width": 2,
            "height": 1,
            "tile": "town.43"
          }
        }
      ]
    }
  ]
}
```

```sh
bun run rpgkit-edit propose --file game/data/inline-project.json \
  --json @welcome-proposal.json
bun run rpgkit-edit list-proposals --file game/data/inline-project.json
bun run rpgkit-edit show-proposal --file game/data/inline-project.json \
  --json '{"id":"agent-welcome-path-1"}'
bun run rpgkit-edit withdraw-proposal --file game/data/inline-project.json \
  --json '{"id":"agent-welcome-path-1"}'
```

`propose --dry-run` returns the complete validated proposal without writing
the project or sidecar. A normal `propose` writes exactly one JSON file to
`<project.json>.proposals/`; it still never edits the project. Operations
inside one hunk run in order and may depend on one another. Every hunk starts
from the same proposal base, and paths may not overlap across hunks, so the
editor can review them independently. The stored `baseHash` is the project's
semantic SHA-256 at creation time.

The editor compares every hunk's recorded `before` values with the live
document. Unrelated changes remain clean even when the whole-document hash is
stale; a changed target value becomes a conflict and disables acceptance.
Accepted/rejected decisions are stored on each hunk. A partially reviewed
proposal stays in the pending directory; once every hunk has a decision it
moves to `archive/`. An agent can poll `show-proposal`: read
`result.proposal.hunks[].decision.status` for `accepted` or `rejected`, and
`result.archived` for completion. Rejections are persisted independently of
unsaved document edits. For acceptance, the desktop bridge rechecks the hunk
against the latest host file, applies it there with a byte-checked atomic
write, and only then records the decision. Unrelated external edits survive;
same-target drift resets the queued acceptance so it can be regenerated.
The bridge publishes an explicit managed-save capability and the host file's
semantic hash separately from the guest-writable review session. SAVE waits for
a queued acceptance to reach
that host revision, then sends an exact-source compare-and-swap request through
the editor's isolated `data.fs`; the bridge performs the replacement under the
same project lock as direct edits and acceptance. A stale full-document write
is refused, including when the bridge preserved an external edit; reload the
editor to continue from that merged document. Sidecar transitions use
tokenized per-proposal locks, independent concurrent decisions merge, and an
interrupted pending-to-archive transition is repaired on load.
If bridge initialization fails after publishing the capability, managed SAVE
fails closed; companions without that marker retain their legacy save channel.

The command set is `open`, `list-maps`, `list-events`, `list-pages`,
`list-commands`, `update-map`, `add-map`, `duplicate-map`, `delete-map`,
`paint-tile`, `paint-rect`, `fill-region`, `paint-passage`, `paint-cells`,
`paint-edges`, `add-event`,
`update-event`, `delete-event`, `add-page`, `update-page`, `delete-page`,
`insert-command`, `delete-command`, `update-command`, `validate`, `save`,
`propose`, `list-proposals`, `show-proposal`, and `withdraw-proposal`.
Mutations use the same tile strokes, event/page transactions, recursive
command addresses and field parsers as the visual editor. Project read/edit
commands through `save` support inline documents and sharded `ProjectShell`
projects, except that `add-map`, `duplicate-map`, `delete-map`, and
`paint-edges` refuse a shell with `UNSUPPORTED_FOR_SHELL`. Proposal creation, assessment, and editor review currently require
an inline project; a shell receives a clear `READ_ONLY_PROJECT_SHELL` error.
Shell-only
discovery reads no map payloads; ordinary map operations load and validate
only the selected shard. `validate` and a map-id rename read every shard,
because validation covers the complete project and renames rewrite transfers
everywhere. Effective mutations write only changed shards plus the refreshed
shell. Shell patches use `/shards/<escaped-entry>/...` and `/shell/...`
logical JSON Pointer paths and remain reversible with `save`. Run the complete
CLI-to-interpreter example with:

```sh
bun tools/rpgkit-edit/example-sunstone.ts \
  --output dist/rpgkit-edit/sunstone-agent-task.json
```

It copies Sunstone, adds a village greeter through seven CLI operations, and
then loads the saved JSON in the runtime interpreter to prove that three
dialogues appear, ten gold is awarded, and self switch A makes the reward
one-shot.

The same operations are available as MCP tools over stdio, without an SDK
dependency. Use an absolute script path because MCP clients may launch from a
different working directory; pass absolute project paths to tools for the same
reason.

```sh
# TraeCLI / TraeX. Inspect it with `traecli mcp list` or `/mcp` in the TUI.
traecli mcp add rpgkit-edit -- bun /absolute/path/to/pocket-rpgkit/tools/rpgkit-edit/mcp.ts \
  --root /absolute/path/to/game-project

# Claude Code (project-local registration).
claude mcp add --scope project rpgkit-edit -- \
  bun /absolute/path/to/pocket-rpgkit/tools/rpgkit-edit/mcp.ts \
  --root /absolute/path/to/game-project
```

The server implements MCP initialization, ping, `tools/list`, and
`tools/call`. stdout is reserved for newline-delimited JSON-RPC; domain errors
are returned as structured tool errors, while malformed requests use standard
JSON-RPC error codes. Proposal lifecycle uses
`rpgkit_proposal_create`, `rpgkit_proposals_list`,
`rpgkit_proposal_show`, and `rpgkit_proposal_withdraw`; these are separate
from project-editing tools because proposal creation and withdrawal touch only
the sidecar queue. Their parameters, responses, errors, and full lifecycle
examples are in the [edit API reference](docs/edit-api.md#ai-proposal-lifecycle).

## QA checks

`rpgkit-check` runs the same QA tools over any `rpgkit-project/v1` document,
from the CLI or as MCP tools mounted on the editing server. Each check's
parameters, output fields, finding codes and exit codes are documented in
[`docs/qa-checks.md`](docs/qa-checks.md):

```sh
bun run rpgkit-check lint    --file game/data/project.json
bun run rpgkit-check locks   --file game/data/project.json
bun run rpgkit-check freeze  --file game/data/project.json
bun run rpgkit-check reach   --file game/data/project.json
bun run rpgkit-check explore --file game/data/project.json
bun run rpgkit-check shot    --file game/data/project.json --json '{"map":"village","x":4,"y":6}'
```

`lint` is a static health check (dead pages, missing references, empty
choices). `locks` proves every `lockInput` is released on the real engine,
`freeze` scans for maps that lock input or park a blocking fiber forever, and
`explore` walks the game headlessly and reports which event pages never ran.
`shot` renders schematic PNGs of a map's passability and events.

`reach` proves map reachability with a **replayable witness**: it searches
over real engine states (walk to triggerable events, ride out dialogs, choices,
battles and transfers, branch per choice option, restore snapshots at
branches), and every map it reports as reached carries a button-mask tape the
tool itself replays in a fresh session to verify the arrival. A map reported
as `notFound` means the search spent its budgets (`--max-frames` /
`--max-states` / `--max-seconds`) without finding a witness — a **lead, not a
proof** — and the report lists the frontier (which inbound transfers' source
pages never ran). The same run also performs deterministic structural checks:
transfers to missing maps, landings on non-standable tiles, orphan maps, and
dynamic (variable-target) transfers. Witnesses are 60 Hz tapes recorded in
constant 6-tick blocks (edges on block boundaries); each witness is replayed
and verified at 60 Hz in a fresh session — the tool makes no claim about
other host frame rates. The frame budget is an execution limit: the search
may run at most one 6-tick block past `--max-frames`.

## Protocols

The kit speaks a small set of versioned protocols so that different
frontends — the editor, the CLI, web pages, AI agents — can all read and
write the same projects. [`docs/protocols.md`](docs/protocols.md) is the
one-page reference:

- **`rpgkit-project/v1`** — the project data format; `src/data/schema.json`
  is normative, `src/data/CHANGELOG.md` records every change.
- **`rpgkit-edit`** — JSON-in/JSON-out project editing with reversible
  `rpgkit-edit/patch-v1` patches ([Edit API reference](docs/edit-api.md)).
- **`rpgkit-check`** — QA checks over any project document
  ([QA checks reference](docs/qa-checks.md)).
- **`rpgkit-preview/v1`** — `postMessage` messages that embed the real engine
  in another web page: `load` a project document, `start` at a tile or
  chapter, read `state`, inject `input`, `stop`. The site ships a host page
  and a [reference frontend](https://lfkdsk.github.io/pocketjs-rpgkit/preview-demo.html)
  (`preview-demo.html`): paste a project JSON and play it.

## The format in one screen

A project document (`"format": "rpgkit-project/v1"`) names a `start` tile,
tile `sheets`, `items`, and `maps`. Sheets may define symmetric `dirBlock`
edges and independent one-sided `dirEdges.enter` / `dirEdges.exit` masks. A
map has a dense row-major `ground`
array of `"sheet.cell"` tile ids (`null` is a blocking void), a sparse
`upper` star layer drawn above characters, sparse `passage` overrides, and
`events`. Each event owns ordered **pages**; the active page is the
highest-index page whose condition holds. A page names one trigger, an
optional sprite, motion (`moveType` or an authored `moveRoute`), and a
command list. Optional `moveSpeed`, `moveFrequency`, `directionFix`,
`through`, and `facingMode` fields tune that motion. `src/data/schema.json`
is normative and `src/engine/types.ts` carries the matching TypeScript types.

### Large projects: maps as on-demand entries

Small games keep using an inline `project.maps` array. A large game can use
`splitProjectMaps(project)` from `tools/lib/map-project.ts` to emit a small
`ProjectShell` plus one independently addressable entry per map. The shell
replaces `maps` with `mapIndex`; every index record carries the map id,
dimensions, entry name and SHA-256. Both output order and bytes are stable, so
importers can write `files` directly to independent files or addressable pak
data entries.

Entries default to canonical JSON. Large importers can select the reversible
`rpgkit-map/1` transport, or let the splitter choose it only when smaller:

```ts
const split = splitProjectMaps(project, { entryEncoding: "auto" });
// "json" keeps the historical format; "compact" encodes every map.
for (const file of split.files) writePakData(file.path, file.bytes);
```

The compact encoder dictionaries tile ids, chooses sparse/RLE/raw spellings
per layer, and replaces repeated event/command object keys with a per-map key
table. `decode(encode(map))` has the same canonical JSON as the input. This is
an entry transport only: `ProjectShell`, `MapDef`, saves, `mapManifestHash`,
and `MAP_SCHEMA_HASH` keep their existing meanings. `auto` uses `.rkm` entry
names by default even when a small individual map stays JSON; entries identify
themselves by content, not by their extension. Run
`tools/slim-map-quickjs-bench.sh` to compare JSON and compact first-visit cost
inside PocketJS's desktop QuickJS guest. This narrow benchmark uses an
in-memory `readText` source and intentionally excludes filesystem I/O and
checksum verification, isolating parse, compact decode, and repository
structural validation.

At runtime, pass the shell and a repository together:

```ts
import { readFileSync } from "@pocketjs/framework/fs";
import { createMapRepository } from "pocket-rpgkit/engine";

const repository = createMapRepository(project.mapIndex, {
  read: (entry) => readFileSync(entry),
  readText: (entry) => readFileSync(entry, "utf8"),
});

mount(() => <GameView
  project={project}
  maps={repository}
  assets={{ ...GAME_ASSETS, maxActors: MAX_ACTORS_ON_ANY_MAP }}
/>);
```

The splitter fully validates every map. Both canonical JSON and compact output
escape non-ASCII characters as JSON `\uXXXX` sequences, making each entry
stable ASCII bytes. `createMapRepository` (and its historical
`createJsonMapRepository` name) parses either transport automatically after
reading it. When a source provides `readText`, the repository prefers it and
skips guest-side byte decoding. Otherwise `read` remains the compatible path:
bytes use bounded 8 KiB `String.fromCharCode` chunks, and a hand-authored entry
containing bytes above `0x7f` falls back to strict UTF-8 decoding. Entry
SHA-256 remains the digest of the exact encoded UTF-8 bytes; text sources
re-encode their string for the same check without canonicalizing or
normalizing it. A synchronous source is trusted like the application bundle
and skips the entry SHA-256 by default;
pass `{ verify: true }` as the third argument to recheck it. A source with
`prepare` defaults to checksum verification because it normally crosses a
network boundary. Runtime loading checks compilation-critical structure by
default because the splitter already performed the full schema check; pass
`{ validate: "full" }` as the third argument for untrusted authoring inputs.
The splitter-emitted `mapManifestHash` is likewise used directly as the
trusted package's save/content identity. A shell without that field is hashed
at startup; pass `verifyMapManifest: true` in `createSession` options to
recompute and compare a declared hash when accepting an untrusted or mutable
shell. Index shape, duplicate ids/entries and the start-map reference are
validated in both modes.

`rpgkit-edit` strictly checks a declared manifest before editing and verifies
every shard it opens. After an effective mutation it refreshes changed shard
checksums, `mapSchemaHash`, and `mapManifestHash`, then writes only the changed
shards plus the shell.

Because the runtime trusts a declared hash, an application that packages a
`ProjectShell` must verify its freshness at build or test time. After writing
the shell, read it back and call `assertShellManifestFresh` (exported from
`pocket-rpgkit/engine`); it recomputes the manifest hash and throws with both
the declared and computed digests on any mismatch, catching stale or
hand-edited shells before release:

```ts
import { readFileSync } from "node:fs";
import { assertShellManifestFresh } from "pocket-rpgkit/engine";

assertShellManifestFresh(JSON.parse(readFileSync("dist/project-shell.json", "utf8")));
```

`splitProjectMaps` already self-checks its output, so a shell that went
straight from the splitter to disk always passes; the check guards every
later mutation. Hand-authored shells without a declared `mapManifestHash` are
hashed at startup and have no build identity to verify.

`createSession(project, hz, { maps: repository })` synchronously validates and compiles
only the starting map. A transfer acquires its destination, then evicts the
old parsed map, interpreter world and passage table. These caches and the
view's current-map actor list are derived data: they are absent from reducer
state, replay hashes and saves. For a shell project, save envelopes carry the
shell manifest and map-schema identities; `restoreSessionEnvelope` rejects a
different content build before acquiring the saved map, or reacquires that
map if it was evicted. Shells and saves from an earlier schema whose changes
since were purely additive still load (`MAP_SCHEMA_COMPATIBLE_HASHES`; see
[Schema identities](src/data/CHANGELOG.md#schema-identities); today that is
only the schema just before optional choice icons, and older ones are refused
with an error naming the accepted identities), and the next save is stamped
with the current identity. A non-zero transfer fade lets the standard synchronous
repository prepare one fixed unit per reference tick (read/optional byte decode/parse,
validation, then world/passage compilation); the map is still published on
the original fully-black tick. A zero-fade transfer keeps its single-frame
synchronous acquire.

A browser source may return `undefined` from `read` and implement async
`prepare(entry)`. Keep the start entry ready before mounting. On a later miss,
`GameView` pauses input and simulation, calls `prepare`, and retries the exact
same host frame; `onMapLoading(mapId | null)` can drive a loading indicator.
Fetch completion order therefore never enters simulation state. Custom
repositories must give `acquire` the same synchronous validated contract as
`createJsonMapRepository`. A source with `prepare` must keep the bytes for any
resident map synchronously readable: attract-mode rollback can reacquire an
earlier resident map within the same host frame.

### The 47 commands

| op | purpose |
| --- | --- |
| `text` | typewriter dialog lines |
| `choices` | prompt with 2-8 option branches (a scrolling box past 4), an optional cancel branch, and optional per-option sprite icons ([Choice icons](#choice-icons)) |
| `switch` | set a global switch |
| `variable` | set/add/sub, a seeded random range, or arithmetic against another variable (copy/add/sub/mul/div/mod) |
| `selfSwitch` | set the event-local A/B/C/D flag |
| `if` | condition over switch/variable/selfSwitch/item/gold/facing, effective appearance, explicit tile-property overrides, derived `worldIdle`, current `bgmPlaying`, or a registered `ext` predicate, with `else` |
| `transfer` | swap maps at x/y/dir, with an optional fade; map/x/y/dir may be `{ "variable": "id" }` |
| `moveRoute` | route the player, this event, or a named event through moves, turns, waits, deterministic `pathTo`, and `approach` |
| `moveControl` | change a target's autonomous mode, stop it, start bounded wandering, or override speed/run/frequency/collision/facing settings |
| `appearance` | change a player's/event's walking sprite, opacity, or visibility; optionally save a new player reset baseline |
| `layer` | show/hide a named visual layer or select one of its prepackaged variants for this map visit |
| `tileProperty` | replace one cell's passage and/or one-sided entry/exit edge masks for this map visit |
| `screenFade` | fade the complete presentation out to a colour (default opaque black) or back in, independently of transfer |
| `screenTint` | tween a named composable RGBA screen-tint layer (a zero-alpha target removes it) |
| `screenFlash` | flash an RGBA colour at 0..255 intensity, then decay to transparent |
| `screenShake` | deterministic horizontal shake with pixel strength, cycles/second speed, and duration |
| `camera` | scroll focus to an absolute tile, the player, this event, or a named event; targeting the player restores live follow |
| `balloon` | show a project animation above the player/event for a duration or until explicitly cleared |
| `screenBackdrop` | show or close a named full-screen layer variant for cutscenes and menus |
| `wait` | virtual-time pause (seconds, compiled against `simulationHz`) |
| `gold` | add/sub gold |
| `item` | add/remove an item count |
| `se` | emit a sound cue the host drains |
| `playBgm` | start or replace looping background music with optional volume and pitch |
| `fadeoutBgm` | fade BGM to silence over virtual seconds, then remove it |
| `stopBgm` / `pauseBgm` / `resumeBgm` | control the current BGM without consulting host time |
| `playBgs` / `fadeoutBgs` | start ambient background sound or fade it to silence independently of BGM |
| `playMe` | play a duration-authored music effect while BGM is suspended, then resume BGM |
| `playSe` | emit a transient sound effect by logical audio id (`se` remains compatible) |
| `saveBgm` / `replayBgm` | snapshot and restore BGM id, volume, pitch, and virtual position |
| `erase` | remove this event for the rest of the map visit |
| `exit` | end this fiber |
| `common` | run a common event's command list |
| `lockInput` / `unlockInput` | cross-event input lock; freezes the mover and action but not autorun/parallel |
| `place` | relocate the player, `"this"`, or a named event to a tile, optionally facing a direction |
| `shop` | MV-style buy/sell over gold and item counts, from an `id`-namespaced goods list with per-good price/sellPrice/stock/condition overrides |
| `mapAnim` | play a project frame animation on a tile or following the player/a named event (`follow:false` pins it to the execution tile), above or below characters, looping or once; `wait` parks the fiber until one playthrough completes (one-shot) or until `stopAnim` stops the instance (looping) |
| `stopAnim` | stop one map animation instance by id, every instance of an animation name, or all live map animations |
| `ext` | call a namespaced, game-registered pure command with JSON arguments |
| `extChoice` | open a scrolling choice box whose live rows and optional selection effect come from a namespaced pure extension |
| `battle` | park the event in a game-registered battle scene, then run its optional win/lose/escape branch |
| `scene` | park the event in a game-registered scene by namespaced id (PC, journal, name input, …), then run its optional onDone/onCancel branch; the scene can write variables, switches, items, gold and the player name |

Every timed screen command uses virtual seconds and has optional `wait`.
Waiting parks only the issuing fiber while other event fibers and the map keep
running. `screenFade` holds a completed fade-out until a later fade-in;
`screenTint.layer` lets daylight, weather, and game-specific effects coexist
without sharing state. A `balloon.icon` names a `project.animations` entry;
omitting the icon clears that target, while omitting duration makes the icon
persistent. A waited balloon requires an icon and a positive finite duration;
`duration: 0` clears the target's balloon. `screenBackdrop` resolves a `GameAssets.layers` entry whose
placement is `screen` and sits above the map but below dialogs. Tint and flash
also sit below dialogs; the independent fade sits above them.

Screen state is part of saves and attract rewind. Transfer retains fade,
named tints, and backdrop, but clears flash, shake, scripted camera, and
character balloons. A backdrop blocks player movement/action and makes
`worldIdle` false while autorun/parallel fibers can close it. A default-frozen
battle pauses map presentation clocks and owns the visible scene; with
`scene.worldContinues:true` those clocks advance in the background. Camera
focus is saved in world pixels, clamped against the current viewport at
render time, then shake offsets only the map/world plane, never HUD/dialogs or
screen overlays.

`moveControl` takes the same `"player"` / `"this"` / `{event:id}` target as
`moveRoute`; a route can apply the same `MoveControl` inline with a
`{control: ...}` step. Page movement defaults are speed grade 5, frequency
grade 5, `directionFix:false`, `through:false`, and
`facingMode:"followMovement"`. Speed uses RPG Maker MV's 1-6 grades; `run`
adds one effective grade capped at 6. Frequency uses MV's 1-5 cadence grades
on the fixed reference-tick clock: grade `n` waits `30 × (5 - n)` reference
ticks between autonomous decisions.

Control settings (including `stop`) persist for the current map visit and
round-trip through saves. An NPC page switch clears all of that NPC's
overrides; a map transfer clears player and NPC overrides. Motion priority is
forced route, runtime autonomous override, page patrol, then page autonomous
motion. `stop` cancels the active route and suppresses its page patrol until a
new route or motion-mode control resumes it; use `moveType:"static"` to stop
wandering. `wander` may constrain its random steps to an optional non-empty
tile rectangle. Player wander makes `worldIdle` false; NPC wander does not.
Input lock or any open dialog pauses player wander, and any open dialog pauses
runtime NPC wander.

`through` bypasses terrain and character bodies, but never map bounds, and
touch triggers still fire. `directionFix` prevents every facing change.
`facingMode:"locked"` and `"scripted"` intentionally share Tuxemon's runtime
behavior here: movement does not turn the actor, while explicit face steps
still do; `"followMovement"` turns with movement.

`appearance` uses the same targets as `moveRoute`: `"player"`, `"this"`, or
`{ "event": "id" }`. A string `sprite` resolves through the project's
`sprites` and `GameAssets.npcSrc`; `null` restores the authored page sprite
or the player's reset baseline. `opacity` is an integer from 0 through 255
(255 is equivalent to `null`), and `visible` is independent of collision.
Player changes cross map transfers and enter saves; `saveDefault:true`
remembers the supplied player sprite as the baseline that a later
`sprite:null` restores; `saveDefault:true` with `sprite:null` clears the
saved baseline. An event change belongs to
the issuing active page and is discarded on its next page change. The
`appearance` condition compares the resulting sprite key, not opacity or
visibility.

`layer` stores only `{visible, variant}` in reducer state. The immutable art
is declared under `GameAssets.layers`: `ground` and `upper` can replace the
built-in bands; `below` and `above` add world-space bands; `screen` draws a
colour/image overlay above the world and below dialog. Map variants use eager
`chunks`/`columns` or streamed `refs`/`columns`/`chunkPx`; a screen variant
uses `color`, `image`, and optional `opacity`. Every variant is cooked and
packed at build time. Switching one rebinds existing nodes (and, for a
streamed layer, only its viewport-resident textures); hiding keeps its node
and texture pools warm. `null` restores an asset default. Unknown variants
are content errors when rendered.

`tileProperty` addresses the current map by tile `x`,`y`. `passage` replaces
the cell's authored pass/block opinion; `enter` and `exit` replace the blocked
direction list for that half of a crossing after passage is applied. An empty
list explicitly opens all directions, while `null` removes that field's
runtime override. Player movement, NPC routes, and path search all read the
same derived table. The matching condition tests fields in the explicit
runtime override (`null` means absent), so a command followed by `if` observes
its write in the same reference tick.

Layer and tile-property overrides are per map visit: every transfer, including
a same-map transfer, clears them. Player appearance is project-wide; event
appearance is per visit and page-bound. All three are ordinary reducer state,
so saves and attract rewind restore them deterministically and old saves that
omit them retain their old defaults. A battle scene freezes map fibers by
default, so these commands resume with their owning fiber after battle; modal
and `worldIdle` behavior is otherwise identical to every other instant
command.

`choices`, `extChoice`, and `shop` share one 4-row scrolling box
(`ui/list-window.ts` picks the window from the live cursor; a label past 24
characters truncates with an ellipsis). A shop sells any owned item at
floor(the item's own `price` / 2)
unless a goods entry for it overrides that shop's `sellPrice`, and refuses a
purchase past `system.inventory.maxPerItem` (default 99) or `maxKinds` (default
unlimited). A goods entry's `stock` is a finite quantity that shop carries,
persisted per shop `id` + item id: a buy decrements it and a sell-back at that
same shop increments it; a `condition` (the page-condition clause shape) hides
the row while it does not hold. An item's effective sell price of 0, or its own
`sellable:false`, makes it unsellable everywhere; `shop.sellList` controls
whether such a row still lists dimmed (`"disable"`, default, MV parity) or is
omitted (`"hide"`, Tuxemon parity).

Triggers: `action` (confirm on the faced or occupied tile),
`playerTouch` (on cell entry), `autorun` (blocking, restarts after it
finishes), `parallel` (concurrent fiber per active page). An event may
occupy a rectangle (`w`/`h`, default 1×1): touch fires on entry into any
cell and action fires when the faced or occupied cell is inside it. A page
condition may use the flat fields or `all: Condition[]` (AND); a
`{kind:"facing", dir}` clause gates by the player's facing and makes a
touch page re-fire on a turn in place. `{kind:"worldIdle", negate?}` is
true only at a freely controllable map safe point: there is no blocking
event, input lock, modal, player route, pending transfer/battle, fade, active
scene, fatal overlay, or host-owned menu. It is derived when the condition is
read and adds no save field; `negate:true` inverts it. Parallel fibers and
attract/demo input ownership alone do not make the world busy.
`{kind:"bgmPlaying", id?, negate?}` tests any or one named BGM and is false
while that BGM is paused or suspended behind an ME.
Switch/variable ids prefixed `local.` reset on every map entry; a page `dir`
sets the character's initial facing. Conditions compile to forward jumps; no
command can express a loop, and the runtime backstops a hand-crafted cyclic
program with a fatal interpreter error instead of hanging the frame loop.
Within one reference tick, parallel fibers run in ascending event-key order
before the blocking main fiber. Main can therefore observe an earlier
parallel write, while a parallel cannot observe a main write made later in
that tick. `worldIdle` follows the same point-in-time rule: page gates are
sampled during trigger scanning, while an `if` reads the live state at its
instruction. An unlock performed after the scan can therefore enable a page
on the next reference tick, and a later condition branch in the same tick
already sees the unlock.

### Game extensions and Battle Processing

Game-specific party, quest or combat data stays out of the generic event
vocabulary. Register namespaced pure handlers when creating a session and
keep their JSON state in `SessionState.ext`:

```ts
const session = createSession(project, simulationHz(), {
  maps: repository, // optional for inline projects
  extensions: {
    initial: { party: [] },
    commands: {
      "game.add_member": (ctx, args) => ({
        ext: addMember(ctx.ext, args),
        writes: { "party.size": partySize(ctx.ext) + 1 },
      }),
    },
    conditions: {
      "game.party_ready": (ctx) => partyReady(ctx.ext),
    },
    choices: {
      "game.choose_member": {
        options: (ctx) => party(ctx.ext).map((member) => ({
          key: member.id,          // stable logical identity across refreshes
          label: member.name,
          enabled: member.ready,  // defaults to true
          data: { id: member.id },
        })),
        resolve: (ctx, _args, result) => result.kind === "select"
          ? { ext: selectMember(ctx.ext, result.data) }
          : undefined,
      },
    },
    // Optional encode/decode and validate hooks cover saves and restores.
  },
  battle: battleRules,
});
```

An extension command receives read-only ext/switch/variable/item/gold data
and a `random()` function backed by the session's saved mulberry32 cursor.
It returns replacement `ext`, variable `writes`, and/or per-item `items` and
wallet `gold` replacements. An extension condition is read-only and has no
random API. Item and gold results update the same `SessionState.sw` backpack
and wallet used by authored item/gold commands and shops; a later command or
condition in the same tick sees the committed values. Call names must contain
a namespace (`game.action`).

An `extChoice` command has the shape
`{ op:"extChoice", call, args, prompt, cancel?, write? }`. `prompt` is at
most 52 characters; the `write` variable ids match `^[A-Za-z0-9_.-]+$`. Its
registered
`choices[call].options(readContext, args)` provider returns rows shaped
`{ key, label, enabled?, data? }`. The provider receives no random function
and is evaluated from live state on every reference tick while the box is
open. Keys must be non-empty and unique, and must identify the same logical
row across refreshes: a retained key keeps the cursor when rows reorder. If
the selected key disappears, its old numeric position is clamped into the
new list and that frame cannot also confirm the newly exposed row. A false
`enabled` value leaves a row navigable but renders it dim and makes confirm a
no-op. `data` defaults to `null`, must be JSON, and is opaque to the kit.
A non-cancellable list must always contain at least one enabled row; an empty
list is permitted only when `cancel:true`.

Confirm calls the optional `resolve(commandContext, args,
{ kind:"select", index, key, data })`; cancel, when enabled, calls it with
`{ kind:"cancel" }`. Only `resolve` receives the saved-RNG `random()` function,
so refreshing or navigating the list consumes no entropy. `write.index`,
`write.key`, and `write.cancelled` are optional, distinct variable ids. A
selection writes its zero-based index, key, and `0`; cancellation writes
`-1`, `""`, and `1`. These direct writes and the resolver's optional
`ExtensionCommandResult` commit atomically before the next instruction runs
on that same reference tick. A resolver may not write one of the same variable
ids through `result.writes`; overlap is a contract error, not a precedence
rule.

`createSession` lists every command, condition, or dynamic choice used by an
inline project but not registered. Editor previews may explicitly set
`allowUnknown: true`, which makes unknown commands and dynamic choices no-ops
and conditions false. For a sharded project, the same check runs as each map
is acquired. An open dynamic choice uses the ordinary modal slot: it captures
the d-pad, blocks its owning fiber, and makes `worldIdle` false. It is not a
save point, just like text, authored choices, and shops; rewind reconstructs
it by the normal pure refold. Per-reference-tick refresh and edge handling keep
the same outcome at every supported host Hz. The optional extension codec
encodes only save bytes; live state is decoded again on restore. Checksums and
attract-mode refolds include the slot, and an older v1 save without it loads
as `null`.

`BattleRules` is the game-owned pure scene reducer:

```ts
interface BattleRules {
  start(ext, setup, seed, context): {
    state: JsonValue;
    ext: JsonValue;
    audio?: { bgm: { id: string; volume?: number; pitch?: number } | null };
  } | null;
  step(state, input, ticks): JsonValue;
  done(state): null | {
    ext: JsonValue;
    result: "win" | "lose" | "escape" | "draw";
    writes?: Record<string, number | string>;
    switches?: Record<string, boolean>;
    items?: Record<string, number>;
    gold?: number;
    transfer?: { map: string; x: number; y: number; dir?: Dir | "keep"; fade?: number };
  };
}
```

Starting a battle consumes exactly one session RNG draw and gives the
derived u32 seed to `start`. Its fourth argument is the same read-only
ext/switch/variable/item/gold context extension conditions receive, captured
after the event or shop that requested the battle; existing three-parameter
rule implementations remain valid and simply ignore the extra argument.
`null` means no encounter and resumes the event immediately. Otherwise the
event fiber parks in external mode and the JSON battle state lives in
`SessionState.scene`. `step` is called once per host frame with 1/2/3/15 fixed
reference ticks at 60/30/20/4 Hz. On completion, ext, variable writes, boolean
switch writes, item counts, and gold commit atomically before the matching
result branch; an optional transfer runs after that branch. `draw` has no
branch.

When `start` omits `audio`, the existing audio state continues unchanged for
backwards compatibility. Supplying `audio` suspends the complete map mix
(including BGM/BGS/ME, fades, pause state, and an authored `saveBgm` snapshot),
then plays only the requested battle BGM; `{ bgm: null }` requests silence.
Completion restores the suspended state in the same reducer fold before the
result branch resumes, so map playback does not advance behind a default-frozen
battle. The game-owned track id must be non-empty, volume must be an integer
from 0 through 100, and pitch an integer from 50 through 150.

An `items` result replaces only the listed ids rather than replacing the
whole backpack. Each finite count is floored through `clampFiniteVar`, clamped
to `[0, system.inventory.maxPerItem]`, and zero removes the id. All removals
and updates to currently held kinds apply first; new positive kinds are then
admitted in lexical id order until `system.inventory.maxKinds`, with later
kinds discarded. A `gold` result replaces the wallet after the same finite
integer normalization and a non-negative clamp. These rules make results
independent of object insertion order.

Battle requests are the deliberate ordering exception: requests newly emitted
in one reference tick are staged and appended main first, then by ascending
parallel event key, without changing the general parallel-before-main fiber
execution order. Only the queue head starts. After its completion is applied
and its fiber resumed, the next request starts on the next reference tick;
`start()` returning `null` resumes immediately without occupying the scene.

While a battle scene is active, host input goes only to `BattleRules.step`.
By default page synchronization, player/NPC movement, and every map event
fiber freeze; the battle-owning fiber remains parked. Set
`scene={{ worldContinues: true }}` to opt into background world simulation;
battle requests raised there still queue safely. `GameView` keeps the world
subtree mounted but hidden (`display:none`, so core skips layout, paint and
hit-testing) while a scene is open, and pauses every world layer's
per-frame sync hook (ground, animated tiles, extra layers, occlusion,
actors, map animations, balloons) until the scene closes; the dialog box is
a persistent sibling that hides its own boxes while a scene owns the
screen; the registered scene component mounts on first use and likewise
stays mounted (hidden) between battles, so scene entry/exit frames pay no
mount/unmount cost. The optional effects component is a permanent root sibling
of both visibility gates, so a battle BGM swap and map-BGM restoration do not
remount the audio driver. The battle component receives
`{ state, width, height, active }`; `active` is false while the once-mounted
scene is hidden, so resource scopes can release the completed battle's
textures. Every visible animation cursor must still be in battle state:

```tsx
mount(() => <GameView
  project={project}
  assets={GAME_ASSETS}
  extensions={extensions}
  battle={battleRules}
  scene={{ worldContinues: false }}
  battleScene={BattleScreen}
/>);
```

`GameView` registers both the `confirm` and `back` action intents while a
scene is active, before considering any parked map modal. A text, choices, or
shop modal remains in reducer state but is hidden and cannot capture input
until the scene closes. Thus `BattleInput.cancelEdge` fires on CROSS the same
portable way `confirmEdge` already did — a rules module reads
`input.cancelEdge` for "cancel"/"escape" the same way it reads
`input.confirmEdge`, instead of reading the raw button mask itself.

Active battles and non-empty battle queues are not save points. They are
nevertheless fully rewindable: `AttractController` accepts the same
`extensions`, `battle`, and `scene` registrations, and reconstructs map,
queue, and scene by folding the retained input prefix from a clean session.
Authored concurrent/nested battle requests do not throw from `stepSession`;
invalid values returned by registered game callbacks remain programming
contract errors.

### Game scenes (the `scene` command)

A `scene` command opens a game-registered full-screen scene by namespaced
id — a PC storage box, a journal, a trading screen, a name input — using
the same lifecycle as battles:

```ts
const session = createSession(project, simulationHz(), {
  scenes: { "game.pc": pcRules, [NAME_INPUT_SCENE_ID]: nameInputRules },
});
```

`SceneRules` has the same `start(ext, args, seed, context)` /
`step(state, input, ticks)` / `done(state)` shape as `BattleRules`, with a
`SceneCompletion` of `{ cancelled?, ext?, writes?, switches?, items?, gold?,
playerName?, transfer? }`. The event fiber parks until the scene completes,
then runs `onDone` (or `onCancel`); a `null` start resumes immediately.
Scenes share the battle queue's ordering, freeze, save-point, rewind, and
multi-hz semantics, and `worldIdle` is false while a scene is queued or
active. `GameView` mounts the matching `sceneViews[id]` component, which
receives the same read-only `{ state, width, height }` props. Like the
battle view, a game scene view mounts on first use and stays mounted
(hidden) between opens, and the map world stays mounted but hidden while
any scene is on screen:

```tsx
mount(() => <GameView
  project={project}
  assets={GAME_ASSETS}
  scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
  sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
/>);
```

The kit ships one built-in scene: **name input**, a generic MV-style name
entry (not a byte-for-byte port of MV or Tuxemon — see the differences
below). `{ op:"scene", id:"rpgkit.nameInput", args:{...} }` with args
`{ variable?, maxLength?, default?, title?, charset?, columns?, allowEmpty?,
swallowCancel? }`: without `variable` the committed name replaces the player
name (the `{name}` text token); with one it writes that variable. The buffer
prefills from the variable's current value, the current player name, or
`default`; an empty buffer cannot be committed (unless `allowEmpty` with a
variable target). `maxLength` clamps to 1..24 (default 8; Tuxemon uses 15).
A custom `charset` keeps only printable single code units: every non-printable
code point is dropped — C0/C1 controls and DEL, format characters (zero-width,
BOM), line/paragraph separators, private-use, unassigned and surrogate code
units — while space separators such as U+00A0 render a visible cell and stay. Cancel closes the scene and runs `onCancel`; `swallowCancel: true`
instead swallows the cancel key, matching Tuxemon's `InputMenu` opened with
`escape_key_exits=False` (`rename_player`/`rename_monster`). Held-key repeat
is 0.50 s / 0.10 s on the reference clock (Tuxemon: 0.50 s / 0.08 s), so the
cursor is identical at 60/30/20/4 Hz for the same virtual time. MV's
back-key-deletes-char and empty-confirm-restores-default are not implemented;
Tuxemon's empty player initial and species-name monster initial are reached
by passing `default`.

Variable-addressed transfers validate their live map, coordinate, and
direction operands when the command executes. An unset/wrong-typed operand or
unknown map records a fatal `InterpState.error`, freezes the session, and is
shown by `GameView` instead of escaping the host frame as an exception. Fatal
states are not save points. A checksum-valid legacy v1 snapshot with a
populated single `pendingBattle` slot is explicitly rejected as unsafe;
`null` still hydrates to an empty queue.

Only `blocks: true` pages have a body: a body stops the player and moving
characters alike (characters also never step onto the player), and path
searches avoid bodies only, so a sprite-less marker (a transfer mat) is
walked over by everyone. By default
a blocking fiber or a choices box holds the player, while a parallel
page's text line does not; a project that sets
`"system": { "messageBlocksPlayer": true }` makes any open text or choices
box hold the player (no movement, no `action` / `playerTouch` start) while
`autorun` and `parallel` pages keep running — RPG Maker's and Tuxemon's
dialog behavior.

### Battle UI kit (`pocket-rpgkit/ui/battle`)

`BattleSceneComponent` (above) receives `{ state, width, height, active }`, so
every visible widget it draws from must be a pure function of that JSON and
the resolution — no signal seeded from a clock, `Date.now()`, or a host frame
count. `active` is a resource-lifecycle edge, not an animation clock.
`src/ui/battle/` is a small kit of such widgets for the screens a
turn-based battle actually needs, built on the same primitives DialogBox and
Panel already use (`ui/list-window.ts`'s scroll window, `ui/theme.ts`'s
palette):

- `effects.ts` — pure tick math with no UI-framework import: `tweenAt`
  (a `{ from, to, startTick, duration }` window), `shakeOffsetX`,
  `flashOpacity`, `faintPose` (sink + fade), `frameIndexAt` (a baked frame
  strip's current frame) and `barFillWidth`, plus `progress`, `windowDone`
  and the `NO_EFFECT` zero-descriptor. A rules module (or its own
  small core library) computes a `Tween`/`SpriteEffect` once when a beat
  starts and stores it in `SessionState.scene`; these functions re-derive
  the same pixels from it at any `nowTick`.
- `StatBar` — an HP/XP bar; its fill width is `barFillWidth(current, max,
  width)`.
- `CommandGrid` — the MV-style 2×2 battle command grid (Fight/Skill/Guard/Run
  and similar), with a selected cell and per-cell disabled state.
- `ListMenu` — a scrolling skill/item/party list sharing DialogBox's
  fixed-row window and label truncation, with an optional description line.
- `MessageBand` — a standalone typewriter message band (DialogBox's message
  box without the choices/shop/portrait machinery).
- `SpriteSlot` — one battler image whose position, horizontal shake, flash
  opacity, and faint sink/fade are all computed from a base position plus an
  `effects.ts` descriptor and `nowTick`.
- `FrameStrip` — a baked frame-strip animation (an effect authored as N pak
  images), swapping discrete image keys by tick like `PlayerSprite` chooses
  a walk pose — **not** a native auto-play sprite atlas (`AnimatedTiles`'s
  atlases cycle off the host's own vblank clock, which a save/rewind cannot
  carry).

`SpriteSlot`, `FrameStrip`, and the general `LazyImage` component from the
opt-in `pocket-rpgkit/ui/image` entry accept either the historical `ui:img`
string or an on-demand single-tile descriptor:

```ts
const HERO = {
  kind: "tile",
  ref: "ui:tile.battle/hero#0",
  sourceWidth: 128,
  sourceHeight: 128,
} as const;
```

The build-side `encodeClut8Tile(name, { width, height, rgba })` helper in
`tools/lib/clut8.ts` returns that descriptor, the `ui:tile.<name>` pak key, a
complete one-tile TILESET blob, and a quantization report. Write the blob as a
raw pak entry, for example:

```json
[
  { "key": "ui:tile.battle/hero", "file": "assets/battle/hero.pkts" }
]
```

Dimensions must be powers of two from 1 through 512. Images with at most 256
canonical colours round-trip exactly (a transparent image reserves palette
index zero and therefore has 255 opaque/translucent slots); wider palettes are
reduced deterministically by frequency and nearest RGBA colour, with the error
reported to the cooker. The index stream uses PocketJS's PackBits TILESET
format. Unlike `ui:img`, the host does not upload it at boot:

```tsx
import {
  createBattleImageCache,
  NO_EFFECT,
  SpriteSlot,
} from "pocket-rpgkit/ui/battle";

function BattleScreen(props: BattleSceneViewProps) {
  const images = createBattleImageCache(() => props.active, {
    maxEntries: 24,
    maxBytes: 3 * 1024 * 1024,
  });
  return <SpriteSlot
    src={HERO}
    cache={images}
    active={props.active}
    x={24} y={80} width={128} height={128}
    effect={NO_EFFECT}
    nowTick={0}
  />;
}
```

The cache reference-counts mounted borrowers and keeps released frames in a
deterministic unpinned LRU (defaults: 32 entries and 4 MiB of palette/index
backing). `createBattleImageCache` frees the whole battle working set when
`active` becomes false. Passing no cache gives one `LazyImage` an isolated
eight-entry cache. Existing string sources still use the eager `ui:img` path
unchanged. Byte accounting uses the dimensions in the cooker-produced
descriptor; applications that hand-author descriptors must keep those values
identical to the TILESET header.

Because every widget is this kind of pure function, a battle scene inherits
the kit's L-key rewind and 60/30/20/4 Hz determinism for free, the same way
the map layer does (`engine/attract.ts` restores a canonical keyframe and
folds its suffix). A game that
never registers `battle`/`battleScene` never imports `src/ui/battle/` (it is
its own `pocket-rpgkit/ui/battle` export, separate from `pocket-rpgkit/ui`),
so the module never reaches that game's bundle — proved for the sunstone
example in `tests/battle-ui-bundle-isolation.test.ts`. A full worked demo —
command grid, skill submenu with a disabled row, guard, escape, a hit's
shake and HP tween, a faint's sink/fade, and win/lose messages, driven by a
small `BattleRules` — lives in `tests/fixtures/kb4-battle/` (`rules.ts`,
`scene.tsx`), exercised by `tests/kb4-battle-rules.test.ts` (the state
machine) and `tests/kb4-battle-sim.test.ts` (rendered goldens, semantic
pixel checks, and the Hz/determinism proofs).

## Using it in your own project

The published package exports the engine surface (`pocket-rpgkit`), the
Solid components (`pocket-rpgkit/ui`), the opt-in lazy image path
(`pocket-rpgkit/ui/image`), the opt-in WAV/QOA bridge
(`pocket-rpgkit/ui/audio`), the battle UI kit (`pocket-rpgkit/ui/battle`),
the demo controls (`pocket-rpgkit/ui/demo`),
the host adapters (`pocket-rpgkit/host`), and the schema
(`pocket-rpgkit/schema`). The
in-repo examples import the sources relatively, because PocketJS's build
pass 1 walks relative imports; `examples/meadow/meadow.tsx` shows the
reducer loop by hand:

```ts
import { createSession, startSession, stepSession } from "pocket-rpgkit";
import { DialogBox, PlayerSprite } from "pocket-rpgkit/ui";

const session = createSession(project, simulationHz());
let state = startSession(project, session);
onFrame((buttons) => {
  state = stepSession(session, state, { buttons, confirmEdge, /* ... */ });
  // state.move / state.chars / state.interp drive the Solid tree.
});
```

and `examples/sunstone/sunstone.tsx` mounts the whole screen:

```tsx
import { GameView } from "pocket-rpgkit/ui";
import { createAudioEffects } from "pocket-rpgkit/ui/audio";
import { loadAttractTape } from "pocket-rpgkit/host";

const AudioEffects = createAudioEffects(project.audio!);
mount(() => (
  <GameView project={project} assets={GAME_ASSETS}
            attractTape={loadAttractTape(DEMO_TAPE_RUNS).masks}
            effects={AudioEffects} />
));
```

### Opt-in immutable-state fast path

`GameView` and `createSession` accept `immutableState: true`. This lets the
engine share unchanged reducer banks between published snapshots and lets the
view skip actor work when the corresponding character and appearance
identities did not change. Treat every state returned by the engine, including
restored and attract-mode states, as read-only while this option is enabled.
The default remains the defensive compatibility path for callers that mutate
published snapshots.

Game-owned conditions can additionally set both
`extensions.immutableConditions` and `extensions.deterministicConditions`.
The first promises that condition handlers never mutate the context, extension
state, or arguments; the second promises that identical inputs have identical
results and no observable side effects. Both promises are required before the
engine can reuse page and sleeping-guard decisions involving extension
conditions. Battle rules may set `immutableState: true` when `start`, `step`,
and `done` preserve every state they publish and return persistent JSON values.
The engine still validates those values, while sharing already validated
subtrees instead of cloning them every frame.

### Opt-in host audio

An audio-enabled project maps logical ids to complete `audio:wav.*` or
`audio:qoa.*` pak keys and explicitly injects the host effect:

```tsx
import { GameView } from "pocket-rpgkit/ui";
import { createAudioEffects } from "pocket-rpgkit/ui/audio";

const project = {
  /* ... */
  audio: {
    click: "audio:wav.sfx/click",
    field: "audio:qoa.music/field",
  },
};
const AudioEffects = createAudioEffects(project.audio);

mount(() => <GameView project={project} assets={GAME_ASSETS} effects={AudioEffects} />);
```

WAV entries contain PCM accepted by the PocketJS audio contract. Playable QOA
uses one or two channels at 11,025, 22,050 or 44,100 Hz. QOA entries are
indexed once and decoded in 20-frame slices only as host ring credit asks for
them; loops, fades, pause/resume and ME interruption use the same reducer
behavior for both formats. Every voice has private QOA decode state.

Where it plays: the web player and the desktop host (Linux and macOS) mount
the PocketJS audio module; the PSP host and the headless simulator implement
it too. On Linux the desktop host links ALSA, so building it needs the ALSA
development files (`libasound2-dev`); `bun run desktop` and `bun run editor`
fall back to a host without audio output when they are missing, and the game
then runs silently. The QuickJS benchmark scripts always build that silent
host.

The build-time encoder accepts interleaved signed 16-bit PCM and produces
deterministic QOA bytes:

```ts
import { encodeQoa } from "./vendor/pocket-rpgkit/tools/lib/qoa.ts";

const pcm = new Int16Array(await Bun.file("field.s16le").arrayBuffer());
await Bun.write("field.qoa", encodeQoa(pcm, 1, 22_050));
```

Decode compressed source formats before calling it; for example,
`ffmpeg -i field.ogg -ac 1 -ar 22050 -f s16le field.s16le`. The kit does not
bundle an Ogg or MP3 decoder. The encoder rejects channel counts and sample
rates that the PocketJS audio host cannot play. Add the resulting file as a raw pak entry, as in
`examples/sunstone/pak.json`; Sunstone's `gen-assets.ts` also shows a fully
programmatic four-second QOA loop. `tools/qoa-quickjs-bench.sh` measures one
368-frame streaming refill in PocketJS's desktop QuickJS guest.

If a project does not need host playback, omit both the audio import and
`effects` prop; both decoders and the PocketJS audio SDK then stay out of its
bundle. A project may still declare `project.audio` for reducer and QA use
without pulling in that adapter. A host without the audio module, or a
missing/malformed resource, is silent while reducer state, conditions, saves,
and rewind continue deterministically. Static pages made by `bun run web`
mount the web host automatically; their mute control changes output gain
without pausing the deterministic stream clock.

A game supplies its own project document, its own baked art (the
`tools/lib/chunks.ts` pipeline turns its sheet PNGs into map chunks and
writes the `GameAssets` manifest), and its own walker frames; the
components name no asset paths themselves. To give a game attract mode,
write a deterministic journey driver (`examples/sunstone/journey.ts`;
`searchWalk` in `src/engine/journey-search.ts` plans the walks on hosts
slower than 60 Hz), freeze its 60 Hz masks as an RLE tape, and pass the
tape to `GameView`. On a host with `data.fs`, an `attract-tape.json` at
the app's data root replaces the built-in tape without a rebuild.

`AttractController` captures a complete runtime keyframe every 3,600 reducer
inputs by default, and immediately after map changes and battle entry/exit.
Display-only pacing ticks do not advance that interval, so one tape produces
the same capture frames at 60/30/20/4 Hz. Rewind restores the nearest retained
keyframe and folds only the suffix through the ordinary reducer. Configure the
policy with `keyframeIntervalFrames` and `keyframeMaxBytes`; zero bytes disables
keyframes and uses the exact from-frame-zero fallback.

The default 8 MiB cap applies to the deterministic serialized-payload estimate
reported by `keyframeEstimatedBytes` and `keyframeStats()`. Oldest snapshots are
evicted first; a target older than the oldest retained snapshot falls back to
frame zero. `rewindHistoryEstimatedBytes` adds that payload to the u16 input and
u8 controller-timeline allocations. JS-engine object overhead is host-specific
and intentionally excluded. Keyframes are process-local acceleration data:
they never enter the `rpgkit-save/v1` envelope, so the save format is unchanged.
Run `tools/kr2-quickjs-bench.sh` to measure short/100k-frame rewind latency and
the periodic-capture spike in PocketJS's desktop QuickJS guest; scratch files
default to `${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/kr2-quickjs`.

### Demo controls (`pocket-rpgkit/ui/demo`)

The optional demo entry adds a three-page overlay to `GameView`: start from a
chapter, warp to any project map, or autoplay a chapter at 1×, 2× or 4×. It is
separate from `pocket-rpgkit/ui`, so a game that does not import it does not
bundle the menu, save decoder or demo runtime. **SELECT** opens it by default;
left/right changes pages, up/down selects a row, **CIRCLE** activates it and
**CROSS** closes it. The world folds zero reducer frames while the menu is
open.

```tsx
import { GameView } from "pocket-rpgkit/ui";
import { createDemo, type DemoOptions } from "pocket-rpgkit/ui/demo";

const demoOptions: DemoOptions = {
  chapters: [
    {
      id: "village",
      title: "Village beginning",
      snapshot: villageSaveCode, // SaveSnapshot is accepted too
      tape: fullTape,
    },
    {
      id: "cave",
      title: "Cave gate",
      snapshot: caveSaveCode,
      tape: fullTape.slice(caveSourceOrigin),
    },
  ],
  warp: {
    spawns: {
      village: { x: 9, y: 9, dir: "up" },
      cave: { x: 9, y: 10, dir: "up" },
    },
  },
  // openButton: BTN.SELECT,
};

mount(() => <GameView
  project={project}
  assets={GAME_ASSETS}
  attractTape={fullTape}
  demo={createDemo(demoOptions)}
/>);
```

A chapter snapshot must be an ordinary validated safe-point `SaveSnapshot` or
URL-safe save code. Its optional `tape` is the 60 Hz u16 button stream whose
first mask follows that snapshot; the snapshot's `held` field seeds the first
button edge. A bad code, invalid snapshot, missing map or unsafe landing is
shown in the overlay and leaves the current session untouched. Autoplay speed
changes how many session steps one host frame folds and renders only the last;
the ordered input stream, takeover behavior, **L** rewind and terminal state do
not change.

The map page lists every `Project.maps` entry by display name, or every
`ProjectShell.mapIndex` id. A configured spawn must be in bounds, terrain-
standable and free of an authored event. Without one, the runtime picks the
first such tile in row-major order. Warp acts like a transfer: it keeps the
current switches, variables, self switches, items, gold and extension state,
but starts a fresh visit to the destination map. The menu therefore warns that
the retained story state may not make sense on the chosen map.

When `demo` is enabled, the web page accepts these links:

- `?chapter=<id>` — restore a chapter for live play;
- `?map=<id>&x=<tile>&y=<tile>` — warp, with `x` and `y` supplied together;
- `?autoplay=<id>&speed=2` — autoplay at speed `1`, `2` or `4`.

`tools/web.ts` reads optional `chapters: [{ "id": "cave", "title": "Cave" }]`
metadata from a game's `web.json` entry and places chapter links beneath its
card. Before evaluating the game bundle, the web player exposes the supported
query strings as `globalThis.__rpgkitBoot`; custom hosts and tests may inject
the same object. Unknown parameters are ignored, while conflicting or invalid
demo values become a visible error. Current PocketJS desktop hosts do not pass
argv or environment variables into the guest, so desktop builds have the menu
but no launch-parameter equivalent. This limitation does not affect web links,
save points or replay determinism.

On the web player page, the same chapter metadata renders as HTML buttons next
to the game. Clicking one jumps the running game to that chapter **without
reloading the page**: while `demo` is enabled the runtime registers
`globalThis.__rpgkitDemo` with `jump(id)`, `warp(map, x, y)`,
`autoplay(id, speed)` and `current()`, and the page calls it in place. The
active chapter and autoplay speed stay highlighted, including after a jump
made from the in-game menu. When the hook is absent (for example a game built
without `demo`), the same buttons fall back to the `?chapter=` reload links
above, so the metadata keeps working everywhere.

Every web player page, with or without `demo`, also accepts `?embed`: the
page hides its header, caption, chapter buttons, on-screen pad, controls
table and footer and fits the game screen to the window, for pages that show
the player in an iframe (Studio's play-test panel embeds the `preview` page
this way). The editor page's file tools stay visible.

Saves are FNV-checksummed envelopes over a safe-point snapshot (mover on a
tile boundary, no modal, no parked request, no active scene). Hosts with `data.fs` write
three slots through `src/host/save-fs.ts`; other hosts exchange the same
envelope as URL-safe base64 text (the save code). For a sharded project, pass
`session.content` to `saveSlotFs`, `loadSlotFs` and `listSlotsFs`; this writes
the build identity and rejects slots from another map manifest or schema.

### Large-map streamed rendering

The legacy `GameAssets` path mounts every baked 512px map image. Large or
numerous maps can instead add `assets.stream`; `GameView` then uses
`StreamedChunkLayer` for the ground and upper layers while leaving the
project document, collision, camera, characters and event interpreter
unchanged. Existing manifests without `stream` still take the original
`ChunkLayer` path.

At build time, compose the same ground and upper RGBA pixels used by
`bakeMapChunks`, but cut each layer into row-major 256×256 chunks. Encode
each map layer and collect its pak entries:

```ts
import {
  encodeStreamedLayer,
  pakManifest,
  streamEntryFile,
  streamManifestSource,
} from "./tools/lib/stream.ts"; // use the equivalent vendor path in a game repo

const ground = encodeStreamedLayer("world-ground", groundRgba, columns, rows);
const upper = encodeStreamedLayer("world-upper", upperRgba, columns, rows);
const entries = [...ground.entries, ...upper.entries];

// Write each entry.blob to streamEntryFile(entry.key), and use these rows
// as the app's pak.json. `streamManifestSource` emits the stream: literal.
const pakRows = pakManifest(entries);
const stream = streamManifestSource([{
  id: "world", width: mapWidthInTiles, height: mapHeightInTiles,
  ground: ground.layer, upper: upper.layer,
}]);
```

Each emitted pak entry is a CLUT8 `TILESET` with PackBits RLE and reserved
transparent index 0. A fully transparent chunk becomes a null ref and
occupies no pak entry. A layer with at most 256 colours shares one palette
and entry; a wider layer splits into per-chunk entries, and byte-identical
chunks reuse one ref. The encoder reports any individual chunk that still
needed deterministic colour quantization. The fixture cooker in
`tests/fixtures/streamed/gen-assets.ts` is a complete writing example.

The generated string goes in the optional `stream` field of `GameAssets`:

```ts
stream: {
  chunkPx: 256,
  ground: { world: ["ui:tile.world-ground#0", /* ... */] },
  upper: { world: [null, /* ... */] },
  columns: { world: 4 },
  margin: 16,       // optional prefetch in pixels; default 16
  loadBudget: 2,   // optional uploads per layer per frame; default unlimited
}
```

Only chunks intersecting the camera plus the prefetch margin are loaded
through `loadTileTexture`. Chunks remain resident for one extra chunk of
hysteresis, then their texture is freed; image nodes are pooled across
scrolling and map transfers. Ground stays below characters and upper stays
above them. Pass `onStreamStats` to `GameView` for per-layer resident,
texture-byte, upload, free, pool and pending counts. `chunkWindow` from the
engine package exposes the same clamped viewport arithmetic for tooling and
tests.

Runtime layer variants use the same two source shapes. For example:

```ts
layers: {
  ground: {
    placement: "ground", mode: "streamed",
    variants: { winter: { refs: winterRefs, columns, chunkPx: 256 } },
  },
  mist: {
    placement: "above", mode: "eager",
    variants: { thick: { chunks: mistChunks, columns: mistColumns } },
  },
  weather: {
    placement: "screen",
    variants: { night: { color: "#00008080" }, torch: { image: torchOverlay } },
  },
}
```

The command selects only these names; it never causes a map image to be
baked at runtime. Built-in `upper` visibility hides upper row slices and
above-tile animations without hiding the actor nodes interleaved between them.

### Animated map tiles and 16×32 walkers

`GameView` also accepts `GameAssets.animated`, keyed by map id. Each row
names a tile coordinate, whether it belongs below or above characters, and
a sprite atlas registered in the app's `sprites.json`:

```ts
animated: {
  town: [
    { x: 11, y: 13, above: false, sprite: "assets/anim/water-0.png" },
    { x: 18, y: 7, above: true, sprite: "assets/anim/torch-0.png" },
  ],
}
```

`AnimatedTiles` mounts only cells intersecting the viewport plus a one-tile
ring, reuses image nodes after scrolling, and keeps separate below- and
above-character bands. It binds each node to the native sprite atlas; JS
does not advance animation frames and animated tiles never enter reducer or
save state. Atlas timing therefore lives in `sprites.json` as 60 Hz
reference vblanks:

```json
{
  "assets/anim/water-0.png": {
    "cols": 4, "rows": 1, "frames": 4, "step": 12, "psm": 3
  }
}
```

`cookAnimationAtlases` in `tools/lib/animated.ts` takes 16×16 RGBA frame
sequences, merges byte-identical sequences with the same timing, pads each
atlas to a power-of-two width, and returns its PNG bytes, `sprites.json`
rows, and sequence-to-sprite map. `animatedManifestSource` serializes the
placements for `GameAssets`. The first frame's `durationMs` becomes
`round(durationMs / 1000 * 60)`; a sequence with unequal authored durations
uses that first duration because a native atlas has one constant step.
Animated atlases stay PSM_8888 (`psm: 3`).

Character animation stays reducer-owned. `loadWalkerSheet` in
`tools/lib/bake.ts` cuts a 3-column × 4-row sheet of 16×32 cells into twelve
static PNGs. The default source layout is rows down/left/right/up and columns
walk-left/idle/walk-right; the emitted engine order is down/left/up/right.
Put the resulting frames in `GameAssets.player` or an `npcSrc` walker and
set its height:

```ts
const WALKER = {
  idle: [downIdle, leftIdle, upIdle, rightIdle],
  walkL: [downL, leftL, upL, rightL],
  walkR: [downR, leftR, upR, rightR],
  h: 32 as const,
};

const assets: GameAssets = {
  // map fields omitted
  player: WALKER,
  playerHeight: 32,
  npcSrc: { sailor: WALKER },
};
```

The project sprite may retain its build-time sheet id with
`{ "kind": "walker", "sheet": "sailor", "h": 32, "cols": 3, "rows": 4 }`;
the runtime paints only the cooked frame names in `GameAssets`. Player and
NPC images anchor their bottom edge to the occupied 16px tile. Their facing
and left/idle/right pose come from the saved mover state, while the upper
map layer and `above: true` animations paint over the part extending into
the tile above.

### Map animations (`mapAnim` / `stopAnim`)

A project may list frame animations in `animations`:

```ts
animations: [
  { id: "pulse", sheet: "assets/anim/pulse.png", count: 4, frameDuration: 0.15, loop: false },
]
```

Each entry names a build-time sheet the cooker slices into one static baked
image per frame (`frames` lists sheet indices in play order; `count` plays
`0..count-1`). `frameDuration` is seconds of virtual time, compiled to
reference ticks with the world's hz, so the same virtual instant shows the
same frame at 60/30/20/4 Hz. A missing sheet is a build error.

`mapAnim` plays an instance on a tile (`x`/`y`) or following the player or a
named event (`target`). `follow` (default `true`) keeps a targeted instance
pinned to the character's live pixel position; `follow:false` snapshots the
character's tile at execution and pins the instance there. An event target
with no live character is a content error. `layer` is `"above"` (default,
over characters) or `"below"`; `loop`
overrides the definition's default; `wait` parks the fiber until one
playthrough completes when the animation is one-shot, or until `stopAnim`
stops the instance when it loops (stopping the instance releases the wait
early either way).
Instances are reducer state keyed by `id` with the saved frame clock as
their origin: playback is identical under rewind and after a save/load, and
a same-id replay restarts the instance. `stopAnim` stops one instance by
`id`, every instance of an animation name, or all live instances; a fiber
parked on a stopped instance's `wait` resumes. Animations are per-map-visit
state — a transfer clears them — and a playing (non-waited) animation does
not make the world busy. `GameAssets.anims` maps each animation id to its
cooked frame refs; `MapAnimLayer` mounts instances from a pooled node set,
so playback itself costs no per-frame node churn.

### Themes and speaker portraits

`DialogBox`, `SaveMenu` and `GameView` take an optional `theme`, a
`Partial<UiTheme>`; keys left out keep the kit's navy look. `DialogBox` and
`GameView` also take `faces`, a table from speaker name to portrait:

```tsx
import { GameView, type UiTheme } from "pocket-rpgkit/ui";

const PARCHMENT: Partial<UiTheme> = {
  border: "#7a4a2a", // outer 2 px frame; fill of the name tab
  rim: "#e8a050",    // optional 1 px ring inside the border
  paper: "#f4ecd8",  // panel fill; text of the name tab
  ink: "#302820",    // body text
  dim: "#8a6040",    // prompts, legends, hints
  accent: "#c03020", // titles, the selected row
  backdrop: "#00000a", // full-screen backdrop behind the save menu
};
const FACES = {
  KEEPER: "assets/face/keeper.png", // 64x64 PNGs
  CLERK: "assets/face/clerk.png",
};

mount(() => <GameView project={project} assets={GAME_ASSETS} theme={PARCHMENT} faces={FACES} />);
```

A text whose first line starts with `NAME: ` (`/^([A-Z][A-Z]+): /`) for a
name in `faces` shows that portrait left of the text and a `Name` tab on
the box's top edge. The prefix is never typed: the interpreter still
counts it, so the reveal is offset by its length and the words start after
a short beat with the portrait already up. Any other line, including
`MAYOR: ...` when `MAYOR` has no face, renders exactly as it would without
`faces`. Pak images are power-of-two and at most 512 px, so portraits are
64×64; a game that draws a smaller face inside that canvas narrows the
column with `faceWidth` (default 72: the image plus an 8 px gap). As with
every image, the paths must appear as full string literals in the game's
sources so the build bakes them.

`SaveMenu` also takes a `title` for its root page. `Panel` is the frame
both components draw (border, optional rim, paper), for a game's own
screens such as a help page. `resolveUiTheme` and `splitSpeaker` are plain
TypeScript and are exported from `pocket-rpgkit` as well.

### Choice icons

A `choices` option may carry an `icon` naming a `project.sprites` entry. The
box then draws that character left of the label, the way a "pick your
partner" or "pick your look" screen shows each candidate:

```json
{ "op": "choices", "prompt": "Pick a partner to walk with you.", "options": [
  { "text": "Curator", "icon": { "sprite": "curator" }, "commands": [] },
  { "text": "Guide", "icon": { "sprite": "guide", "dir": "left", "frame": 0 }, "commands": [] },
  { "text": "Walk alone", "commands": [] }
] }
```

A walker shows facing `dir` (default `down`) in pose `frame` (0 idle,
default; 1 left step; 2 right step); a static `kind: "image"` sprite ignores
both. Options without an icon keep an empty cell so the labels stay aligned.

The icon box is opt-in, so games that author no icons do not bundle it:

```tsx
import { ChoiceIconBox } from "pocket-rpgkit/ui/choice-icons";

mount(() => <GameView project={project} assets={GAME_ASSETS} choiceIcons={ChoiceIconBox} />);
```

It replaces the text-only box while an icon choice is open: 248×144,
docked bottom right where the hidden message box sits, four 24 px rows that
scroll past four options, and a cursor bar (accent tint plus accent frame)
spanning icon and label. Icons draw at 1×, nearest neighbour. A 16×16
image is centred in its row; a 16×32 walker frame is anchored at its feet
and its top 8 pixel rows are clipped, which keeps Tuxemon-style characters
whole but cuts a taller head. A sprite that is not in `project.sprites` or
has no baked art draws a framed `?` and logs one `console.warn` per key;
`rpgkit-check lint` reports the missing key as `lint/sprite-missing`
(error). Without the `choiceIcons` prop an icon choice still works: it
opens the text-only box with the labels and logs one warning. Text-only
choices render exactly as before either way. `DialogBox` takes the same
component as `choiceIconBox` plus a `choiceIcon` resolver
(`resolveChoiceIcon` from the same entry).

## Target matrix

The engine is host-free TypeScript; the targets below describe what the
PocketJS app using it can run on. The examples declare the fixed 480×272
viewport plus a live dynamic viewport on desktop hosts, where `GameView`
letterboxes small maps and follows the player on large ones.

| host | runtime | notes |
| --- | --- | --- |
| `linux-app` / `macos-app` | PocketJS desktop host | `data.fs` save slots; resizable logical viewport letterboxes per `centerOffset` |
| `web-app` (wasm) | wasm core, `tools/web.ts` player pages | same bundle; save codes when no fs mount |
| sim (`hosts/sim`) | wasm core, headless | deterministic tapes and framebuffer hashes; the example suites run here |
| `psp` | PSP core | not gated by this repo; the vendor build's `pocket check --target psp` is the admission path for a consuming app (512px baked canvases, PSM_4444) |

## Repository layout

```
src/engine/      pure runtime (types, motion-clock, movement, passability,
                 interpreter, chars, session, camera, viewport, chunk-window,
                 tiles, save*, schema-validate, attract, tape, journey-search)
src/data/        schema.json (normative) + CHANGELOG
src/ui/          GameView, ChunkLayer, StreamedChunkLayer, AnimatedTiles,
                 DialogBox, PlayerSprite, SaveMenu, Panel, theme
                 (UiTheme, speaker prefixes), plus the opt-in LazyImage and
                 tile-texture cache entry
src/ui/audio/    opt-in WAV/QOA host bridge and streaming QOA decoder
src/ui/battle/   state-driven battle UI kit (StatBar, CommandGrid, ListMenu,
                 MessageBand, SpriteSlot, FrameStrip, effects.ts tick math);
                 its own "pocket-rpgkit/ui/battle" export, pulled in only by
                 games that register battle/battleScene
src/host/        data.fs save adapter, attract-tape loader
tools/lib/       game-agnostic baking pipelines (bake.ts, chunks.ts,
                 stream.ts, animated.ts, compact-map.ts, clut8.ts),
                 deterministic QOA encoding, and the desktop-host
                 build/launch helper (desktop.ts)
tools/           example/editor build driver, desktop and editor launchers,
                 macOS packager (package-macos.ts), web site builder
                 (web.ts, web/, web-verify.ts)
examples/        meadow (minimal), sunstone (game + attract + QOA), grow
                 (demo), wander (endless streamed world), showcase (feature
                 gallery);
                 each has its entry, data, assets/src, gen-assets.ts,
                 images.json, pocket.json and ATTRIBUTION.md
editor/          map/event editor (preview): app, engine/, ui/, its cooker
                 and the tile cells it bakes from the examples' sheets
tests/           unit suites, sim suites, goldens/, fixtures/ (small
                 apps the sim suites boot, built by build:example)
vendor/pocketjs  pinned PocketJS submodule
```

## License

MIT (`LICENSE`). Example art: Kenney Tiny Town and Tiny Dungeon (CC0 1.0),
Pixel-Boy and AAA's Ninja Adventure (CC0 1.0), and Lanea Zimmerman
(Sharm) Tiny 16 (**CC-BY 3.0**, attribution required) — see each
example's `ATTRIBUTION.md`. The editor's tile cells are cut from the
Sunstone example's Kenney sheets (CC0).
