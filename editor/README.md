# Pocket RPG Kit — Editor (preview)

A tile-map editor for `rpgkit-project/v1` documents, running as a
PocketJS app on the portable desktop host. It opens the kit's example
projects (`examples/sunstone`, `examples/meadow`) and paints them with
those examples' own tile art.

New to the editor? [`docs/editor-tutorial.md`](../docs/editor-tutorial.md)
follows one small scenario — a villager NPC with branching dialog and a
one-time reward, a second map with two-way portals, and a play-test with
the live debugger — from launch to save, with regenerable screenshots and
a guard test.

## What it does

- **Tile painting**: click or drag on the canvas to paint ground cells.
  The first header button cycles **GROUND → UPPER → PASS → EVENT**. Upper is
  the sparse star layer drawn above characters at runtime; PASS paints
  passage overrides and one-way edges (see below). Right click or
  shift+click erases; palette slot 0 is the eraser brush.
- **Events**: EVENT mode selects the topmost event under the pointer and
  highlights its full `w`×`h` footprint. Drag anywhere in that footprint to
  move it without changing the grabbed-cell offset. The left tools create an
  event at the last canvas cell, open its inspector, copy it, or delete it.
  The inspector edits the display name, origin and footprint.
- **Pages**: add, delete, copy and reorder pages; select the trigger, existing
  sprite key, facing, autonomous move type, `blocks`, and a basic movement
  route. Conditions support the v1 flat forms and every current schema kind in
  compound `all` clauses: switches, variables, self switches, items, gold,
  facing, appearance, tile-property overrides, `worldIdle`, `bgmPlaying`, and
  extension predicates.
- **Commands**: the inspector shows the recursive command tree with indented
  `if`/`else`, choices/cancel, and battle-result branches. It can add, delete,
  copy and reorder commands, and edit every command kind in the current
  project schema, including movement control, presentation, shops, map
  animations, audio, extensions, and battle processing. In the add prompt,
  type an op such as `text`; with a selected parent, `text@then`,
  `text@else`, `text@option1`, `text@cancel`, or
  `text@win`/`text@lose`/`text@escape` inserts directly into that branch.
- **Undo/redo**: every tile drag and every event/page/condition/command
  transaction is one history step, 64 steps deep.
  **UNDO**/**REDO** in the header, or Cmd+Z / Cmd+Shift+Z / Cmd+Y (Cmd is
  Ctrl on Linux).
- **In-editor playtest**: **PLAY** starts the production `GameView` and
  reducer from the current in-memory document, including unsaved edits. The
  most recently selected canvas cell on the current map becomes the
  disposable preview start; if no cell was selected, the document's
  authored `start` is used. During play the hidden editor canvas and panels
  do not receive input. Click **STOP**, press Escape, or press **START** to
  return to the same editor state and undo/redo history.
- **Live debugger**: **DEBUG** (or **SELECT**) opens a panel for switches,
  variables, self switches on the current map, inventory, gold, and running
  event pages/fibers with their command addresses. Click a row's `-`/`+`
  controls to change only the disposable session; page conditions observe
  the new value on the next reducer step. Before PLAY, the **STATE** header
  button chooses **FRESH** or **LAST**. LAST carries only switches and
  variables from the previous run, leaving inventory, gold, self switches,
  map visit state, extension state, and RNG freshly initialized.
- **Preview fallbacks**: an amber in-play notice lists project capabilities
  for which the editor has no game registration. Unknown `ext` handlers are
  deterministic no-ops, battle commands open a visible preview scene
  (CIRCLE = win, CROSS = escape), and named screen backdrops receive a
  visible placeholder asset. These fallbacks affect only the editor bundle.
- **Maps**: **<** and **>** switch between the document's maps; the palette
  shows every cell of the sheets the current map declares. The **MAP** header
  button opens the map inspector:
  - **properties**: id (rename follows `start.map` and every transfer that
    names the old id), display name, width/height (resize expands with void
    or crops; events fully outside are cropped and listed in a persistent
    inspector notice, partially outside clamp — every resize is one undo
    step), and the sheet list. Unknown fields the schema adds later are
    preserved untouched.
  - **NEW** creates an empty map after the current one (20×14, its sheets,
    filled with cell 0 of its first declared sheet) and selects it; **DUP**
    copies the map with a unique
    `-copy` id (event ids are map-local, so the copy keeps them verbatim
    and intra-map `place`/`moveRoute` references stay valid); **DEL** refuses
    the only map and the start map, pages every transfer targeting the map
    with its source and recursive command address, and needs a second click
    to confirm. Crop warnings, save errors, and delete confirmation remain
    visible while the inspector is open.
- **Passage overrides**: the LAYER button cycles GROUND → UPPER → **PASS** →
  EVENT. PASS mode paints per-cell `passage` overrides (PASS / BLOCK /
  CLEAR brushes, green/red corner markers) and toggles one-sided
  `dirEdges` on the sheet of the painted cell's ground tile (IN-*/OUT-*
  tools for enter/exit edges, CLR-EDGE to clear; blue arrows point into
  the cell, orange out). Both are undoable drag strokes.
  Button-only navigation follows the visible two-column PASS tool grid, so
  every operation is reachable without changing the tile palette's layout.
- **Transfer picking**: a transfer command's inspector row has a **PICK**
  button. Click it, switch maps with **<**/**>**, click any cell, and the
  command's map/x/y/dir fill from the canvas. The map/x/y/dir fields stay
  text-editable, so `$variable` operands still work.
- **AI proposal review**: **PROPOSALS** opens the validated sidecar queue.
  The list shows title, author, pending hunk count, and live conflict state.
  Selecting a proposal shows its rationale and hunks, locates the chosen hunk
  on its map, overlays proposed ground/upper tiles at partial opacity, and
  marks added events with translucent green boxes, deleted events in red,
  moved events in blue, and other event changes in amber. **ACCEPT**,
  **REJECT**, and **ALL** review
  hunks independently. Conflicting hunks cannot be accepted; an acceptance
  (including several hunks through ALL) is one undo step, while rejection does
  not touch the project.
  Agents create, list, inspect, and withdraw queue entries through the four
  proposal CLI/MCP operations documented in the
  [edit API reference](../docs/edit-api.md#ai-proposal-lifecycle).
- **Open and save**: the document is parsed and checked against
  `src/data/schema.json` on load, and again before every save, which
  refuses an invalid export with the first schema error in the status bar.
  An unedited document saves back byte for byte. After an edit, unchanged
  source spans — including other event and map objects, their property order,
  and whitespace — are reused rather than reformatting the whole file.

## Event command and condition editing

The inspector owns every command and condition kind currently declared by
`src/data/schema.json`. Parameterless commands such as `stopBgm`, `saveBgm`,
`erase`, and `unlockInput` have no parameter rows, but can still be added,
copied, moved, and deleted. Each accepted field change is checked against the
same project schema before it enters editor state.

Field text uses these common spellings:

- Character targets are `player`, `this`, or `event:<id>`; camera targets may
  also be `tile:<x>,<y>`. Basic routes and direction sets use comma-separated
  values. Screen-fade colours and wander bounds use four comma-separated
  integers.
- `(unset)` removes an optional property. For nullable appearance, layer, and
  tile-property fields, `null` is different: it authors a reset to the runtime
  default. The inspector prevents removing the last field from commands or
  conditions whose schema requires at least one override.
- Fields labelled **JSON** accept JSON text. These include shop `goods`,
  extension `args`, extension-choice `write`, battle `setup`, and extension
  condition arguments. The edited command or condition must still satisfy the
  project schema.
- Project maps, items, sprites, animations, audio ids, common events,
  previously authored layer/variant names, animation instance ids, and
  extension calls appear as hints where relevant. They are suggestions, not a
  replacement for validation or for game-provided resources that the project
  document cannot enumerate.

Only authored command arrays form branches. `if`, ordinary `choices`, and
`battle` expose their respective branch lists; select a battle and use
`<op>@win`, `<op>@lose`, or `<op>@escape` to insert into its result branches.
`extChoice` is not an authored branch container: its rows come dynamically
from the registered extension provider, while `write` describes optional
result variables. The current project schema also has no generic `scene`
command; `battle` is the authored entry point for the existing battle scene.

Not yet: common-event lists, asset import, sheet-level `dirBlock`/`defaultPassage`
editing (the PASS tools paint map `passage` overrides and sheet `dirEdges`
only), or structured controls for advanced object-shaped movement steps (the
existing payloads remain preserved).

## Running

```sh
bun run editor              # dist/editor/sunstone.json, a working copy
bun run editor meadow       # dist/editor/meadow.json
bun run editor sunstone --file my-map.json   # edit another file; seeded from
                                             # the example document if missing
                                             # (relative paths start at the
                                             # repository root)
bun run editor --build-only # bundle + release host, no window
bun run editor meadow -- --quit-after 600    # extra host flags pass through
```

`tools/editor.ts` resolves `editor/pocket.json` for the desktop target
(macos-app on a Mac, linux-app elsewhere), builds the bundle into
`dist/<target>/editor.{js,pak}`, builds the Rust host with
`cargo build --release`, and starts it with the `rpgkit-editor` companion
and `--file`. The host forwards the real mouse and keyboard to the editor and
sends the file's text at boot. For this managed launcher, SAVE (header button
or Cmd+S) is handed to the bridge through `data.fs` rather than sent to the
generic host writer.

The launcher derives the proposal queue at `<file>.proposals/`, snapshots its
validated pending JSON into the editor's project-specific `data.fs`, and
reconciles changes every 200 ms while the window is open. This preserves the
guest filesystem boundary: the PocketJS app never receives arbitrary host
paths. Review updates may add hunk decisions but cannot rewrite proposal
metadata or edit changes. Rejections are recorded without waiting for a
document save. For acceptance, the launcher rechecks the hunk against the
latest host file, applies it with a byte-checked atomic replacement, and then
records the decision; unrelated external edits are retained and target
conflicts are refused. Per-proposal locks merge independent reviewers, and an
interrupted archive move is repaired on the next load. Once every hunk is
accepted or rejected, the launcher moves the proposal to
`<file>.proposals/archive/`.

The bridge first writes an explicit managed-save capability marker, then a
separate, host-owned semantic-hash snapshot into the editor data root. After an
acceptance, SAVE stays disabled until that snapshot
confirms the expected host apply. Every managed SAVE carries the exact source
hash that the editor loaded; the bridge compares it and replaces the file while
holding the same project lock used by direct agent edits and proposal
acceptance. A stale save is rejected and asks for a reload, so the check and
write cannot straddle another cooperating writer. Dead locks are moved to
token-specific reaper tombstones so concurrent recovery cannot remove a new
owner's lock. If bridge initialization later fails, the marker makes SAVE fail
closed; a generic companion without the marker keeps its legacy save channel.

**Working copies.** The examples author their projects in code
(`examples/sunstone/game-data.ts`, `examples/meadow/mini-project.ts`);
`data/*.json` is what their cookers emit, and the games themselves still
build from code. So by default the editor works on a copy in
`dist/editor/`, seeded from the example document the first time. Passing
`--file examples/sunstone/data/sunstone.json` edits the example document
itself, but `bun run gen-assets` rewrites it from code and drops the edits,
and `tests/editor-model.test.ts` notices a document that no longer matches
the editor's bundled copy.
Once the host file is open, the **DOC** button is disabled, so SAVE can
never write a different project into it.

Mouse wheel scrolls the palette, or the condition/command list under the
pointer while the event inspector is open. Text and numeric controls accept
normal typing and paste; Enter commits and Escape cancels. Enum and boolean
controls cycle on click. The arrow keys move the gamepad cursor, which pans
the view on maps larger than the 20×14-cell window.

### Without the companion

On a host without the `rpgkit-editor` channel (the wasm sim, a browser),
the editor shows an amber banner and runs entirely from buttons: the d-pad
moves a cursor across canvas, palette/event tools and header, **CIRCLE**
paints, selects or activates, **CROSS** erases/deletes, **SQUARE**/**TRIANGLE**
undo/redo, **L**/**R** switch maps, **SELECT** cycles the editing mode, and
**START** saves. **DOC** cycles the bundled documents. Detailed inspector
field entry uses the desktop companion's pointer and keyboard; button-only
mode can close the inspector with CROSS. In proposal review, CIRCLE accepts,
CROSS rejects, START accepts all clean hunks, and SELECT returns to the queue.
On a host with `data.fs` a save goes to
`projects/<id>.json` under the app's data root and wins over the bundled
copy at the next boot; with neither channel the save is refused with a
visible notice.

## Building and testing

```sh
bun run build:editor        # dist/editor.{js,pak} for the sim tests
bun test tests/editor-model.test.ts tests/editor-sim.test.ts \
  tests/editor-event-sim.test.ts tests/editor-proposal-sim.test.ts \
  tests/editor-playtest-sim.test.ts
bun editor/gen-assets.ts    # regenerate the editor's baked inputs
```

`bun run build:example` builds the editor along with the examples, and
`bun run gen-assets` runs the editor cooker after the example cookers
(it reads their documents). The cooker is deterministic: two runs produce
identical bytes.

The sim suite drives both input modes on the wasm sim host with semantic
pixel checks (banner, palette art and selection, tile art, multi-cell event
selection, inspector controls at 480×272 and 720×480, and letterbox
hit-testing), svc save/load and typed-character lines, the data.fs store, a
byte-identical no-edit round trip, proposal ghost golden and per-hunk
accept/reject/undo/persistence flow, and a click-authored speaking NPC whose
saved action page is triggered by the runtime interpreter. The playtest sim
suite additionally exercises unsaved map art through the real `GameView`,
selected-cell starts, STOP/undo continuity, live page switching, LAST/FRESH
state, capability fallbacks, and reviewed play/debug PNG goldens.

## Layout

```
editor/
  editor.tsx, app.tsx   entry and shell (header, palette, canvas, status)
  svc.ts                the rpgkit-editor companion channel (svc lines)
  store.ts              data.fs project documents (gamepad mode)
  proposals/model.ts    portable validation, conflict, apply and preview
  proposals/store.ts    data.fs proposal-session transport
  sources.ts            which example documents and sheets the cooker reads
  gen-assets.ts         the cooker (below)
  api/                  the editor-api package surface: file adapter,
                        operations, tool schemas and shared types (the
                        rpgkit-edit CLI/MCP server is a thin adapter over it)
  engine/document.ts    parse, schema-check, source-preserving serialize
  engine/model.ts       pure tile/event/page reducer and shared history
  engine/commands.ts    recursive command addresses and immutable edits
  engine/event-fields.ts validated page/condition/command field adapters
  engine/event-layout.ts responsive inspector geometry and hit-testing
  engine/event-canvas.ts event footprint, selection and drag geometry
  engine/proposal-layout.ts proposal panel geometry and hit-testing
  engine/layout.ts      map/sidebar geometry and pointer hit-testing
  engine/map-layout.ts  map inspector geometry
  engine/cursor.ts      buttons-mode cursor reducer
  engine/playtest.ts    preview snapshot, carry/debug state, diagnostics
  engine/playtest-layout.ts debug panel geometry and hit-testing
  engine/playtest-view.ts production GameView asset/fallback adapter
  engine/textures.ts    tile id -> baked image key
  ui/canvas.tsx         map window: tiles, event footprints and cursors
  ui/event-inspector.tsx pages, conditions and recursive command UI
  ui/proposal-panel.tsx queue, rationale, hunk states and review controls
  ui/map-inspector.tsx  map properties, sheets and map management
  ui/pass-panel.tsx     PASS-mode brushes and one-way edge tools
  ui/playtest.tsx       GameView, STOP/DEBUG chrome and live state panel
  ui/panels.tsx         header, palette/event tools, gamepad banner
  pocket.json           manifest: dynamic 720x480 viewport, companion
generated by gen-assets.ts (committed):
  assets/tile-<sheet>-<cell>.png   one 16x16 PNG per sheet cell
  images.json                      their PSM marks
  engine/tile-keys.ts              tile id -> pak image literal
  engine/sheets.ts                 sheet grids and source files
  assets/playtest/*.pkts           raw streamed sheet cells for GameView
  assets/playtest/{player,npc}-*.png preview actor frames
  engine/playtest-assets.ts        preview texture manifest
  pak.json                         raw TILESET pak entries
  engine/projects.ts               bundled documents + schema copy
```

## Art and licenses

The editor ships no art of its own. `assets/tile-*.png` and
`assets/playtest/*.pkts` are two encodings of the same 16×16 cells cut,
unaltered, from the examples' source sheets; `assets/playtest/player-*.png`
and `npc-*.png` copy the examples' generated preview frames:
`examples/sunstone/assets/src/town-tiles.png` (Kenney Tiny Town) and
`examples/sunstone/assets/src/dungeon-tiles.png` (Kenney Tiny Dungeon),
both CC0 1.0. Meadow's `town-tiles.png` is the same file byte for byte;
the cooker refuses two examples whose sheets share an id but differ. See
`examples/sunstone/ATTRIBUTION.md` and `examples/meadow/ATTRIBUTION.md`
for sources and license texts.
