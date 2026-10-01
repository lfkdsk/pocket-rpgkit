import type { SaveSnapshot } from "../../engine/save.ts";
import type { AttractSpeed } from "../../engine/attract.ts";

/** Supplies a chapter's tape on first use. A large tape can live in the
 *  pak and decode only when a chapter that uses it is selected, instead of
 *  being validated and held at boot. The demo runtime calls each provider
 *  function at most once and shares the result between every chapter that
 *  names the same function; a provider that throws is retried on the next
 *  selection and its error is shown in the demo menu. */
export type DemoTapeProvider = () => DemoTapeFrames;

/** u16 input masks: a plain array or a typed array such as Uint16Array. */
export type DemoTapeFrames = ArrayLike<number> & Iterable<number>;

export interface DemoChapter {
  /** Stable id used by menu selection and ?chapter / ?autoplay. */
  id: string;
  title: string;
  /** A validated save point object or its URL-safe save code. */
  snapshot: SaveSnapshot | string;
  /** Canonical u16 input stream. Frame `tapeStart` (default 0) is the
   *  first input after the snapshot. A provider resolves lazily on first
   *  selection and is cached by the runtime (see DemoTapeProvider), so
   *  several chapters can share one decoded tape through tapeStart. */
  tape?: readonly number[] | DemoTapeProvider;
  /** Index of this chapter's first input within `tape`. Lets chapters that
   *  resume one long recording share it instead of each holding a copy. */
  tapeStart?: number;
  /** Number of inputs from tapeStart; defaults to the rest of the tape.
   *  With a provider this also lets the autoplay page list the chapter
   *  without resolving the tape. A provider chapter that omits it is
   *  listed, and an empty tape is reported when it is chosen. */
  tapeFrames?: number;
  /** Global reducer frame at the checkpoint. A snapshot carries only the
   *  per-map interpreter clock, so a chapter whose map was entered mid-tape
   *  supplies this to land the suffix replay on the same timeline as a full
   *  replay. Omit when the snapshot's clock already is the global frame. */
  timelineFrame?: number;
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
