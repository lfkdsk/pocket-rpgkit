// editor/sources.ts — the example projects the editor opens, and where
// each tile sheet's art comes from. Read by editor/gen-assets.ts (which
// bakes the per-cell tile PNGs and bundles the documents) and by
// tools/editor.ts (which points the desktop host's --file at a document).
//
// Paths are relative to the repository root. Every sheet id a document
// declares must name its source PNG here; a sheet id shared by several
// examples (both use Kenney Tiny Town as "town") must come from
// byte-identical files, because the editor keys tile art by sheet id.
// Licenses: each example's ATTRIBUTION.md covers its own assets/src.

export interface EditorSource {
  /** Bundled document id; also the `bun run editor <id>` argument. */
  id: string;
  /** The example's rpgkit-project/v1 document (emitted by its cooker). */
  document: string;
  /** Sheet id -> the example's source tile sheet (16px cell grid). */
  sheets: Record<string, string>;
  /** The example's demo chapters (save points), offered by Studio's
   * play-test: a module and the name of its exported DemoOptions. */
  chapters?: { module: string; export: string };
}

export const EDITOR_SOURCES: readonly EditorSource[] = [
  {
    id: "sunstone",
    document: "examples/sunstone/data/sunstone.json",
    sheets: {
      town: "examples/sunstone/assets/src/town-tiles.png",
      dun: "examples/sunstone/assets/src/dungeon-tiles.png",
    },
    chapters: { module: "examples/sunstone/demo-chapters.ts", export: "SUNSTONE_DEMO" },
  },
  {
    id: "meadow",
    document: "examples/meadow/data/meadow.json",
    sheets: {
      town: "examples/meadow/assets/src/town-tiles.png",
    },
  },
];

/** The document `bun run editor` opens without an argument. */
export const DEFAULT_SOURCE = "sunstone";
