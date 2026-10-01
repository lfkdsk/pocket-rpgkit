// tests/fixtures/ui-theme/gen-assets.ts — write the fixture's procedural
// portraits (faces.ts) to assets/face-<name>.png and copy the showcase's
// choice-icon sprites (icons.ts) next to them. tools/build-example.ts runs
// this before building the fixture; the PNGs are build outputs and stay
// out of git (.gitignore).

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import { FACE_PALETTES, FACE_PX, faceRgba, type FaceName } from "./faces.ts";
import { ICON_STATIC, ICON_WALKERS } from "./icons.ts";

const OUT = join(new URL(".", import.meta.url).pathname, "assets");
mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(FACE_PALETTES) as FaceName[]) {
  writeFileSync(join(OUT, `face-${name}.png`), encodePNG(faceRgba(name), FACE_PX, FACE_PX));
}

const SHOWCASE = join(new URL(".", import.meta.url).pathname, "..", "..", "..", "examples", "showcase", "assets");
const copies = [`${ICON_STATIC}.png`];
for (const walker of ICON_WALKERS) {
  for (const pose of ["idle", "left", "right"]) for (let facing = 0; facing < 4; facing++) copies.push(`${walker}-${pose}-${facing}.png`);
}
for (const file of copies) copyFileSync(join(SHOWCASE, file), join(OUT, file));
