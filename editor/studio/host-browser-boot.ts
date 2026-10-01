// editor/studio/host-browser-boot.ts — the browser host's part of the page
// shell. editor/studio/index.html calls no browser APIs itself; it marks
// where a host's boot snippet goes, and tools/studio-build.ts puts this one
// there. A desktop shell uses its own page and boot.
//
// Part of the browser host (tests/studio-host.test.ts treats it like
// host-browser.ts). Dependency-free and DOM-free, so build tooling can
// import it.

/** Where the browser host keeps the theme choice ("light" or "dark"; absent
 *  means follow the system). host-browser.ts re-exports it. */
export const THEME_KEY = "pocket-rpgkit:studio:theme";

/** The inline script that picks the theme before first paint: a stored
 *  "light"/"dark" wins, else the system preference; any failure (storage
 *  switched off) falls back to dark. main.ts refines it once loaded. */
export function browserBootScript(): string {
  return [
    "<script>",
    "// Browser host: pick the theme before first paint (main script refines it).",
    "try {",
    `  var t = localStorage.getItem(${JSON.stringify(THEME_KEY)});`,
    '  document.documentElement.dataset.theme = t === "light" || t === "dark" ? t',
    '    : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");',
    '} catch (e) { document.documentElement.dataset.theme = "dark"; }',
    "</script>",
  ].join("\n");
}
