// editor/studio/main-desktop.ts — Studio's entry in the desktop app
// (studio-desktop/). It builds the desktop host first (its boot answer makes
// the synchronous host methods possible), leaves it where main.ts looks, then
// starts the same Studio the web page runs.

import { createDesktopHost } from "./host-desktop.ts";

(globalThis as { studioHost?: unknown }).studioHost = await createDesktopHost();
await import("./main.ts");
