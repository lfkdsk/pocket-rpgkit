// editor/studio/host.ts — everything Studio needs from the place it runs.
//
// Studio's UI never touches storage, files, downloads, processes or the
// network itself; it asks a StudioHost. The web page uses the browser host
// (host-browser.ts). A desktop shell implements the same interface with
// native files and processes, and tests use the in-memory host
// (host-memory.ts). tests/studio-host.test.ts keeps browser APIs out of the
// rest of editor/studio/.
//
// The interface is plain data in, plain data out: no DOM types, so a host
// can sit on the far side of an IPC bridge.

import type { Project } from "../../src/engine/types.ts";
import type { PreviewChapter, StudioPreview } from "./preview.ts";
import type { StudioProblem } from "./problems.ts";

// ---- capabilities ----------------------------------------------------------------

export type HostFeature =
  /** Open a project file (inline JSON or a sharded pack). */
  | "openFile"
  /** Open a directory holding a ProjectShell and its loose shard files. */
  | "openDirectory"
  /** Save back to the file or directory a project was opened from. */
  | "saveInPlace"
  /** Keep one document in host storage and restore it on the next start. */
  | "storage"
  /** Hand the export bytes to the user as a file. */
  | "export"
  /** Pick local PNGs for tile sheets and characters. */
  | "localArt"
  /** Schema validation and rpgkit-check's static lint. */
  | "checks"
  /** rpgkit-check's dynamic checks, which run the game engine. */
  | "dynamicChecks"
  /** Start a local agent process that proposes edits. */
  | "agent"
  /** Play the open document in the real game engine (rpgkit-preview/v1). */
  | "preview";

export interface FeatureStatus {
  available: boolean;
  /** One sentence for tooltips and notices: what it does here, or why not. */
  reason: string;
}

export type HostCapabilities = Record<HostFeature, FeatureStatus>;

// ---- documents ---------------------------------------------------------------------

/** Where a document can be saved back to. Opaque outside its host. */
export interface SaveTarget {
  kind: "file" | "directory";
  /** Shown to the user, e.g. "sunstone/" or "village.json". */
  name: string;
  /** Host-private reference (handle, path); never inspected by the UI. */
  ref: unknown;
}

/** A document the user opened through the host. */
export interface OpenedProject {
  /** Inline project JSON or a sharded pack. */
  text: string;
  /** Shown in notices and the window title. */
  label: string;
  /** Suggested export file name. */
  fileName: string;
  /** Set when the host can save the document where it came from. */
  target?: SaveTarget;
}

export interface StoredProject {
  label: string;
  fileName: string;
  text: string;
  savedAt: string;
}

export type SaveOutcome =
  | { ok: true; where: "storage" | "file" | "directory"; written: string[]; savedAt: string }
  | { ok: false; message: string };

export interface StudioExample {
  id: string;
  title: string;
  document: string;
  kind?: "inline" | "pack";
  sheets: Record<string, string>;
  sprites: Record<string, string>;
  player?: string;
  /** Save points a play-test can start from, for documents with this
   * example's title. */
  chapters?: PreviewChapter[];
}

// ---- art, checks, agent ------------------------------------------------------------

/** A local image the user picked. `url` is drawable until release(). */
export interface LocalArt {
  name: string;
  url: string;
  release(): void;
}

export interface CheckRequest {
  /** Inline project to check; packs are checked shard by shard elsewhere. */
  project: Project;
  /** "lint" runs the static checks; "dynamic" also runs the engine. */
  mode: "lint" | "dynamic";
}

export type CheckOutcome =
  | { ok: true; problems: StudioProblem[] }
  | { ok: false; code: "UNAVAILABLE" | "FAILED"; message: string };

export interface AgentRequest {
  /** What the user asked for, in their words. */
  prompt: string;
  /** Current export bytes the agent should work from. */
  projectText: string;
}

export type AgentOutcome =
  | { ok: true; proposals: string[] }
  | { ok: false; code: "NEEDS_DESKTOP" | "FAILED"; message: string };

// ---- preferences -------------------------------------------------------------------

export type ThemeChoice = "system" | "light" | "dark";

// ---- the host ----------------------------------------------------------------------

export interface StudioHost {
  /** "browser", "memory", "desktop"… for diagnostics. */
  readonly name: string;
  capabilities(): HostCapabilities;

  /** Show the host's file picker. The pick arrives through onOpen(). */
  pickProjectFile(): void;
  /** Show the host's directory picker. The pick arrives through onOpen(). */
  pickProjectDirectory(): Promise<void>;
  /** Documents opened by a picker, a drop, an OS "open with"… Errors (an
   * unreadable file, a directory without a shell) arrive as `error`. */
  onOpen(listener: (opened: OpenedProject | { error: string }) => void): () => void;

  /** Bundled examples, then one example's document text. */
  listExamples(): Promise<StudioExample[]>;
  readExample(example: StudioExample): Promise<string>;

  /** Save the export bytes: in place when `target` is given, else in storage. */
  save(text: string, meta: { label: string; fileName: string }, target?: SaveTarget): Promise<SaveOutcome>;
  /** The document last saved in storage, if any. */
  restore(): StoredProject | null;
  /** Hand the export bytes to the user as a file. */
  exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }>;

  /** Pick a local PNG; null when cancelled, `error` (shown to the user) when
   * the file is not a PNG or exceeds the limits in editor/api/limits.ts. */
  pickImage(): Promise<LocalArt | { error: string } | null>;

  runChecks(request: CheckRequest): Promise<CheckOutcome>;
  runAgent(request: AgentRequest): Promise<AgentOutcome>;

  /** The play-test connection (preview.ts), or null when the "preview"
   * capability is unavailable. One per host; the UI shows it in a panel. */
  preview(): StudioPreview | null;

  /** Ask before a destructive step (discarding edits). */
  confirm(message: string): Promise<boolean>;
  /** Called with a probe; the host warns before closing while it is true. */
  guardClose(isDirty: () => boolean): void;

  theme(): ThemeChoice;
  setTheme(choice: ThemeChoice): void;
  systemPrefersDark(): boolean;
  onSystemThemeChange(listener: () => void): () => void;
}

/** Shared by hosts that run rpgkit-check in-process. */
export function unavailable(reason: string): FeatureStatus {
  return { available: false, reason };
}

export function available(reason: string): FeatureStatus {
  return { available: true, reason };
}

export const NEEDS_DESKTOP = "Local agents run as processes on your computer; this needs the desktop app.";
