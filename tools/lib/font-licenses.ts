// tools/lib/font-licenses.ts — the license files that have to travel with an
// app's build because of the fonts it bakes.
//
// An app that bakes glyphs from a fallback face (its `fonts.json` beside the
// entry, see tools/lib/cjk-font.ts) redistributes a derivative of that face
// in its atlases, so the face's license goes wherever the build goes. The
// license files are the `LICENSE*` / `OFL*` files in the directory of each
// listed fallback font. The pak carries them through the app's `pak.json`;
// the web site and the desktop packages also copy them beside the build so a
// player can read them without unpacking anything.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Absolute paths of the license files for the fallback fonts listed in
 *  `<appDir>/fonts.json`, plus the files its `pak.json` ships under a
 *  `license:` key (fonts an app carries for run-time baking), unique by file
 *  name, in a stable order. Empty for an app with neither. */
export function fontLicenseFiles(appDir: string): string[] {
  const byName = new Map<string, string>();
  const pakManifest = join(appDir, "pak.json");
  if (existsSync(pakManifest)) {
    const rows: unknown = JSON.parse(readFileSync(pakManifest, "utf8"));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.key !== "string" || !row.key.startsWith("license:") || typeof row.file !== "string") continue;
      const file = resolve(appDir, row.file);
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (existsSync(file) && !byName.has(name)) byName.set(name, file);
    }
  }
  const manifest = join(appDir, "fonts.json");
  const fallback: unknown = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8"))?.fallback : undefined;
  for (const font of Array.isArray(fallback) ? fallback : []) {
    if (typeof font !== "string") continue;
    const dir = dirname(resolve(appDir, font));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (/^(LICENSE|OFL)/i.test(name) && !byName.has(name)) byName.set(name, join(dir, name));
    }
  }
  return [...byName.values()];
}

/** The app directory (the entry's directory, where the build reads
 *  `fonts.json` and `pak.json`) of a resolved plan's entry. */
export function appDirOf(projectRoot: string, entry: string): string {
  return dirname(resolve(projectRoot, entry));
}
