import type { SaveSnapshot } from "../../engine/save.ts";
import type { AttractSpeed } from "../../engine/attract.ts";

export interface DemoChapter {
  /** Stable id used by menu selection and ?chapter / ?autoplay. */
  id: string;
  title: string;
  /** A validated save point object or its URL-safe save code. */
  snapshot: SaveSnapshot | string;
  /** Canonical u16 input stream whose frame zero starts at snapshot. */
  tape?: readonly number[];
}

export interface DemoSpawn {
  x: number;
  y: number;
  dir?: "down" | "left" | "up" | "right";
}

export interface DemoWarpOptions {
  /** Preferred safe landing cells. Missing maps use their first free,
   * standable row-major terrain cell. */
  spawns?: Readonly<Record<string, DemoSpawn>>;
}

/** Host-populated boot request. The web bridge deliberately leaves values as
 * URL strings so this game-owned module can validate them visibly. */
export interface DemoBootRequest {
  chapter?: unknown;
  map?: unknown;
  x?: unknown;
  y?: unknown;
  autoplay?: unknown;
  speed?: unknown;
}

export interface DemoOptions {
  chapters: readonly DemoChapter[];
  warp?: DemoWarpOptions;
  /** Raw PocketJS button bit. Defaults to SELECT. */
  openButton?: number;
  /** Tests and non-web hosts may supply the same object explicitly. null
   * disables the documented globalThis.__rpgkitBoot lookup. */
  boot?: DemoBootRequest | null;
}

/** Read-only state exposed to an embedding web page. `chapter` follows a
 * chapter whose id matches the current map, or a named chapter while the
 * player remains on that chapter's origin map. */
export interface DemoCurrent {
  chapter: string | null;
  map: string;
  autoplay: boolean;
  speed: AttractSpeed;
}

/** Same-origin page bridge installed only by a GameView with `demo` enabled.
 * Calls use the same validated chapter/warp paths as the in-game menu. */
export interface RpgkitDemoHook {
  jump(id: string): void;
  warp(map: string, x?: number, y?: number): void;
  autoplay(id: string, speed?: AttractSpeed): void;
  current(): DemoCurrent;
}

export type DemoPage = "chapters" | "warp" | "autoplay";
