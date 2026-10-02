// The save/load GameView fixture runs Sunstone's game data and art. Copy
// the committed Sunstone images next to the fixture entry, where the
// PocketJS build resolves GameAssets paths.

import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const SUNSTONE = join(HERE, "..", "..", "..", "examples", "sunstone");
rmSync(join(HERE, "assets"), { recursive: true, force: true });
cpSync(join(SUNSTONE, "assets"), join(HERE, "assets"), { recursive: true });
cpSync(join(SUNSTONE, "images.json"), join(HERE, "images.json"));
