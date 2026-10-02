# tools/preview — the `rpgkit-preview/v1` host

A player page that embeds the real engine and lets another web page drive it
over `postMessage`. It is built onto the kit's site as the `preview` app
(`bun run web`), and the reference frontend is
[`tools/web/preview-demo.html`](../web/preview-demo.html), served at
`/preview-demo.html`. The protocol reference is
[`docs/protocols.md`](../../docs/protocols.md), section "Preview protocol".

## What it does

- `load` — validates an `rpgkit-project/v1` document through the editor's
  document gate (`editor/engine/document.ts`), dresses it in the editor
  playtest art (`editor/engine/playtest-view.ts`) and mounts it through the
  production `GameView`. Invalid documents are refused with their first
  schema error. With `art: true` it draws the project images staged with
  `art` instead of the stand-ins (`art.ts`).
- `art` — stages one slice of a project image (a tile sheet or a sprite,
  base64 RGBA8) for the next `load`.
- `start` — warps to a map/cell/facing, or restores a chapter supplied with
  `load`, through the demo runtime's validated warp/restore paths
  (`src/ui/demo/runtime.ts`).
- `state` — reads back map, position, facing, frame number, running event
  pages, the open message box, switches, variables, gold and items.
- `input` — holds a u16 button mask for N frames through the attract
  controller's tape path, then releases.
- `stop` — unmounts the project and returns to the idle screen.

Studio's play-test panel (`editor/studio/`) is the second frontend: it
embeds this page as `preview/?embed` (the player page then shows only the
game screen) from the same site.

The host answers only its own origin plus any origins the embedding page
configured with `?preview-origin=<origin>` (repeatable, comma-separated).
Messages from other origins are dropped without a reply.

## Layout

- `preview.tsx` — the host app: protocol backend, the demo-seam runtime that
  captures the `GameView` host surface, and the postMessage listener.
- `protocol.ts` — the pure protocol core (allowlist, parsing, dispatch,
  art staging), shared with `tests/preview-protocol.test.ts`.
- `art.ts` — turns the staged images into runtime art: sheet cells served
  through `StreamedGameAssets.loadTile`, sprite and walker-frame textures
  (walker cutting is `tools/lib/walker-slice.ts`, shared with the baker).
- `pocket.json` — the web-app manifest (fixed 480×272 viewport).
- `gen-assets.ts` — copies the editor playtest art this app shares into
  `assets/playtest/` and writes `images.json` / `pak.json`. Run it after
  `editor/gen-assets.ts`; the root `bun run gen-assets` does both.
- `fonts/`, `gen-cjk-font.ts` — the budgeted text faces a loaded document's
  characters are baked from (a Noto Sans CJK SC subset: GB2312 level-1 hanzi,
  GB2312 symbols, CJK punctuation and full-width forms; an Inter subset for
  Latin beyond ASCII) and their licenses, all pak entries. Regenerate with
  `bun tools/preview/gen-cjk-font.ts` (downloads the pinned Noto source once).
- `cjk-glyphs.ts`, `atlas-merge.ts`, `glyph-bake.ts` — on `load`, bake the
  document's characters the atlases lack and swap the merged atlases into
  the core before the game view mounts. `glyph-bake.ts` is a port of the
  build's baker, pinned to it byte for byte by `tests/preview-glyphs.test.ts`.

## Limitations

- Inline documents only: a sharded `ProjectShell` (`mapIndex`) is refused.
- Without supplied art, art is the editor's fixed Kenney playtest palette:
  sheets other than the ones the editor bakes render as blanks. A frontend
  can supply the project's sheets and sprites with `art`; images the page
  cannot use (a sheet that is not a whole number of 16 px cells, a sprite
  over 512 px, a walker sheet that does not match its grid, an atlas walker)
  keep their stand-ins, and staging is bounded (1,024 images, 32 MiB,
  4,096 px a side). Animated tiles, map animations, backdrops and battle art
  are not supplied. Unregistered extensions, battles and screen backdrops
  use the same visible stand-ins as the editor playtest.
- The preview host does not register game scenes, including
  `rpgkit.numberInput`; exercise those in a built game or fixture that passes
  the matching rules and view to `GameView`.
- The host page is a normal player page: keyboard and the on-screen pad also
  reach the loaded project when the iframe has focus.
- Chinese text draws from the budget above. A character outside it (a rare
  hanzi, a CJK Extension B character) draws as a box; `load` lists it in
  `glyphs.missing`. A built game bakes its own font and is not limited.
