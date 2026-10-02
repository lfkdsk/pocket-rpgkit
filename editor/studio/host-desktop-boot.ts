// editor/studio/host-desktop-boot.ts — the desktop host's part of the page
// shell (see host-browser-boot.ts for the browser's). The desktop app's pages
// forbid inline scripts, so the pre-paint theme pick is a script file next to
// index.html instead of an inline snippet. It reads the same stored choice the
// desktop host writes (THEME_KEY in the app's own origin storage).
//
// Part of the desktop host (tests/studio-host.test.ts treats it like
// host-desktop.ts). Dependency-free and DOM-free, so build tooling can import
// it.

import { THEME_KEY } from "./host-browser-boot.ts";

export const DESKTOP_BOOT_FILE = "theme-boot.js";

/** The tag that replaces the page's host boot placeholder. */
export function desktopBootTag(): string {
  return `<script src="${DESKTOP_BOOT_FILE}"></script>`;
}

/** theme-boot.js: a stored "light"/"dark" wins, else the system preference;
 *  any failure falls back to dark. main.ts refines it once loaded. */
export function desktopBootScript(): string {
  return [
    "// Desktop host: pick the theme before first paint (main script refines it).",
    "try {",
    `  var t = localStorage.getItem(${JSON.stringify(THEME_KEY)});`,
    '  document.documentElement.dataset.theme = t === "light" || t === "dark" ? t',
    '    : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");',
    '} catch (e) { document.documentElement.dataset.theme = "dark"; }',
    "",
  ].join("\n");
}
