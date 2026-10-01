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
  schema error.
- `start` — warps to a map/cell/facing, or restores a chapter supplied with
  `load`, through the demo runtime's validated warp/restore paths
  (`src/ui/demo/runtime.ts`).
- `state` — reads back map, position, facing, switches, variables, gold and
  items.
- `input` — holds a u16 button mask for N frames through the attract
  controller's tape path, then releases.
- `stop` — unmounts the project and returns to the idle screen.

The host answers only its own origin plus any origins the embedding page
configured with `?preview-origin=<origin>` (repeatable, comma-separated).
Messages from other origins are dropped without a reply.

## Layout

- `preview.tsx` — the host app: protocol backend, the demo-seam runtime that
  captures the `GameView` host surface, and the postMessage listener.
- `protocol.ts` — the pure protocol core (allowlist, parsing, dispatch),
  shared with `tests/preview-protocol.test.ts`.
- `pocket.json` — the web-app manifest (fixed 480×272 viewport).
- `gen-assets.ts` — copies the editor playtest art this app shares into
  `assets/playtest/` and writes `images.json` / `pak.json`. Run it after
  `editor/gen-assets.ts`; the root `bun run gen-assets` does both.

## Limitations

- Inline documents only: a sharded `ProjectShell` (`mapIndex`) is refused.
- Art is the editor's fixed Kenney playtest palette: sheets other than the
  ones the editor bakes render as blanks, and unregistered extensions,
  battles and screen backdrops use the same visible stand-ins as the editor
  playtest.
- The host page is a normal player page: keyboard and the on-screen pad also
  reach the loaded project when the iframe has focus.
