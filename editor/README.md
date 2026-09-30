# Pocket RPG Kit — Editor (preview)

A tile-map editor for `rpgkit-project/v1` documents, running as a
PocketJS app on the portable desktop host. It opens the kit's example
projects (`examples/sunstone`, `examples/meadow`) and paints them with
those examples' own tile art.

## What it does

- **Tile painting**: click or drag on the canvas to paint ground cells.
  The first header button cycles **GROUND → UPPER → EVENT**. Upper is the
  sparse star layer drawn above characters at runtime. Right click or
  shift+click erases; palette slot 0 is the eraser brush.
- **Events**: EVENT mode selects the topmost event under the pointer and
  highlights its full `w`×`h` footprint. Drag anywhere in that footprint to
  move it without changing the grabbed-cell offset. The left tools create an
  event at the last canvas cell, open its inspector, copy it, or delete it.
  The inspector edits the display name, origin and footprint.
- **Pages**: add, delete, copy and reorder pages; select the trigger, existing
  sprite key, facing, autonomous move type, `blocks`, and a basic movement
  route. Conditions support the v1 flat forms and compound `all` clauses for
  switches, variables, self switches, items, gold, facing and `worldIdle`.
  Extension conditions are visible and retained as read-only payloads.
- **Commands**: the inspector shows the recursive command tree with indented
  `if`/`else`, choices/cancel, and battle-result branches. It can add, delete,
  copy and reorder commands, and edit parameters for `text`, `choices`,
  `switch`, `variable`, `selfSwitch`, `if`, `transfer`, `wait`, `gold`,
  `item`, `se`, `erase`, `exit`, `common`, `lockInput`, `unlockInput`,
  `place`, and basic `moveRoute`. In the add prompt, type an op such as
  `text`; with a selected parent, `text@then`, `text@else`,
  `text@option1`, `text@cancel`, or `text@win`/`@lose`/`@escape` inserts
  directly into that branch.
- **Undo/redo**: every tile drag and every event/page/condition/command
  transaction is one history step, 64 steps deep.
  **UNDO**/**REDO** in the header, or Cmd+Z / Cmd+Shift+Z (Ctrl on Linux).
- **Maps**: **<** and **>** switch between the document's maps; the palette
  shows every cell of the sheets the current map declares.
- **Open and save**: the document is parsed and checked against
  `src/data/schema.json` on load, and again before every save, which
  refuses an invalid export with the first schema error in the status bar.
  An unedited document saves back byte for byte. After an edit, unchanged
  source spans — including other event objects, their property order, and
  whitespace — are reused rather than reformatting the whole file.

Not yet: map properties, passage overrides, new maps, common-event lists,
asset import, or a destination-map point picker. Transfer coordinates are
numeric fields for now. `shop`, `ext`, and `battle` setup payloads and
advanced object-shaped movement steps are shown and preserved but not edited
in place; their existing branch commands remain navigable and reorderable.

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
and `--file`. The host forwards the real mouse and keyboard to the editor,
sends the file's text at boot, and writes each SAVE (header button or
Cmd+S) back to that file through a temp file and a rename.

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
mode can close the inspector with CROSS. On a host with `data.fs` a save goes to
`projects/<id>.json` under the app's data root and wins over the bundled
copy at the next boot; with neither channel the save is refused with a
visible notice.

## Building and testing

```sh
bun run build:editor        # dist/editor.{js,pak} for the sim tests
bun test tests/editor-model.test.ts tests/editor-sim.test.ts tests/editor-event-sim.test.ts
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
byte-identical no-edit round trip, and a click-authored speaking NPC whose
saved action page is triggered by the runtime interpreter.

## Layout

```
editor/
  editor.tsx, app.tsx   entry and shell (header, palette, canvas, status)
  svc.ts                the rpgkit-editor companion channel (svc lines)
  store.ts              data.fs project documents (gamepad mode)
  sources.ts            which example documents and sheets the cooker reads
  gen-assets.ts         the cooker (below)
  engine/document.ts    parse, schema-check, source-preserving serialize
  engine/model.ts       pure tile/event/page reducer and shared history
  engine/commands.ts    recursive command addresses and immutable edits
  engine/event-fields.ts validated page/condition/command field adapters
  engine/event-layout.ts responsive inspector geometry and hit-testing
  engine/event-canvas.ts event footprint, selection and drag geometry
  engine/layout.ts      map/sidebar geometry and pointer hit-testing
  engine/cursor.ts      buttons-mode cursor reducer
  engine/textures.ts    tile id -> baked image key
  ui/canvas.tsx         map window: tiles, event footprints and cursors
  ui/event-inspector.tsx pages, conditions and recursive command UI
  ui/panels.tsx         header, palette/event tools, gamepad banner
  pocket.json           manifest: dynamic 720x480 viewport, companion
generated by gen-assets.ts (committed):
  assets/tile-<sheet>-<cell>.png   one 16x16 PNG per sheet cell
  images.json                      their PSM marks
  engine/tile-keys.ts              tile id -> pak image literal
  engine/sheets.ts                 sheet grids and source files
  engine/projects.ts               bundled documents + schema copy
```

## Art and licenses

The editor ships no art of its own. `assets/tile-*.png` are 16×16 cells
cut, unaltered, from the examples' source sheets:
`examples/sunstone/assets/src/town-tiles.png` (Kenney Tiny Town) and
`examples/sunstone/assets/src/dungeon-tiles.png` (Kenney Tiny Dungeon),
both CC0 1.0. Meadow's `town-tiles.png` is the same file byte for byte;
the cooker refuses two examples whose sheets share an id but differ. See
`examples/sunstone/ATTRIBUTION.md` and `examples/meadow/ATTRIBUTION.md`
for sources and license texts.
