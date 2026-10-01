// editor/studio/preview.ts — play-testing the open document in the real
// game engine. The host (StudioHost.preview()) embeds the site's `preview`
// player page and talks rpgkit-preview/v1 to it (docs/protocols.md, section
// "Preview protocol"); the browser host does it with an iframe and
// postMessage. This file holds what does not depend on how: the interface a
// host implements, the document check against the protocol's limits, and the
// controller the play-test panel (preview-panel.ts) renders. No DOM here, so
// tests run the controller on the memory host.

import type { EditSession } from "../api/session.ts";
import type { MapDef, Project } from "../../src/engine/types.ts";
import {
  PREVIEW_LIMITS,
  PREVIEW_PROTOCOL,
  previewMessageBytes,
  type PreviewLoadResult,
  type PreviewStartResult,
  type PreviewStateResult,
} from "../../tools/preview/protocol.ts";
import type { StudioApp } from "./app.ts";
import type { StudioExample, StudioHost } from "./host.ts";

export { PREVIEW_LIMITS, PREVIEW_PROTOCOL };
export type { PreviewLoadResult, PreviewStartResult, PreviewStateResult };

export type PreviewDir = "down" | "left" | "up" | "right";
export const PREVIEW_DIRS: readonly PreviewDir[] = ["down", "left", "up", "right"];

/** A save point the game can start from (the protocol's `load.chapters`
 * entry without a tape, so it restores for live play). */
export interface PreviewChapter {
  id: string;
  title: string;
  /** rpgkit-save/v1 save code. */
  snapshot: string;
}

export type PreviewTarget =
  | { kind: "tile"; map: string; x: number; y: number; dir?: PreviewDir }
  | { kind: "chapter"; chapter: string };

/** A request's result, or why it failed. `code` is a protocol error code
 * (bad-start, bad-document, too-large…) or one of the host's own:
 * "unavailable", "timeout", "disconnected", "bad-version". */
export type PreviewOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** The game connection a host provides. Requests settle; they never throw. */
export interface StudioPreview {
  /** Show the game in the UI element with this id and wait until the
   * embedded page announces rpgkit-preview/v1. Connecting again replaces the
   * previous game. */
  connect(slotId: string): Promise<PreviewOutcome<void>>;
  load(documentText: string, chapters: readonly PreviewChapter[]): Promise<PreviewOutcome<PreviewLoadResult>>;
  start(target: PreviewTarget): Promise<PreviewOutcome<PreviewStartResult>>;
  state(): Promise<PreviewOutcome<PreviewStateResult>>;
  stop(): Promise<PreviewOutcome<void>>;
  /** Give the keyboard to the game. */
  focusGame(): void;
  /** Called when the user leaves the game with Esc; the host has already
   * taken the keyboard back from it. */
  onRelease(listener: () => void): () => void;
  /** Remove the game from the UI; pending requests fail. */
  disconnect(): void;
}

// ---- the document ---------------------------------------------------------------

export type PreviewDocument =
  | { ok: true; text: string; bytes: number; expanded: boolean }
  | { ok: false; reason: string };

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The document a play-test loads: the inline export bytes, or a sharded
 * pack put back together as one inline document. Refused (with a reason to
 * show) when the load message would exceed the protocol's message limit. */
export function previewDocument(session: EditSession, chapters: readonly PreviewChapter[] = []): PreviewDocument {
  let text: string;
  let expanded = false;
  if (session.kind === "inline") {
    text = session.exportText();
  } else {
    const { mapIndex: _index, mapManifestHash: _manifest, mapSchemaHash: _schema, ...globals } = session.shell();
    const maps: MapDef[] = [];
    for (const summary of session.maps()) {
      let map: MapDef | undefined;
      try {
        map = session.map(summary.id);
      } catch (error) {
        return { ok: false, reason: `Map ${summary.id} could not be read for the play-test: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!map) return { ok: false, reason: `Map ${summary.id} is missing from the pack.` };
      maps.push(map);
    }
    const project: Project = { ...globals, maps };
    text = JSON.stringify(project);
    expanded = true;
  }
  // The load message as a host sends it (chapters only when there are some).
  const bytes = previewMessageBytes({ protocol: PREVIEW_PROTOCOL, type: "load", requestId: "studio-load-000000", document: text, ...(chapters.length ? { chapters } : {}) });
  if (bytes > PREVIEW_LIMITS.maxMessageBytes) {
    return {
      ok: false,
      reason: `Too large to play-test: the ${expanded ? "pack, put together as one document," : "document"} is ${mib(bytes)} and the preview protocol carries at most ${mib(PREVIEW_LIMITS.maxMessageBytes)} per message.`,
    };
  }
  return { ok: true, text, bytes, expanded };
}

/** Save points offered for the open document: those of a bundled example
 * with the same title. */
export function chaptersFor(examples: readonly StudioExample[], title: string): PreviewChapter[] {
  const example = examples.find((item) => item.title === title && item.chapters?.length);
  return example?.chapters ? [...example.chapters] : [];
}

// ---- the controller --------------------------------------------------------------

export type PlayStatus = "closed" | "connecting" | "loading" | "running" | "stopped" | "error";

/** Where the next start goes: the selected cell, the document's start, or a
 * chapter. */
export type StartChoice = { kind: "selection" } | { kind: "project" } | { kind: "chapter"; chapter: string };

/** State polls per second while the game runs. */
export const PREVIEW_POLL_HZ = 4;

type Listener = () => void;

/** The play-test panel's model: connection, document, start target, the
 * last state reading. The panel renders it; tests drive it directly. */
export class PlayTest {
  status: PlayStatus = "closed";
  /** Shown in the panel: why the last step failed, or why play is off. */
  error: string | null = null;
  /** The document cannot be played (too large, unreadable pack). */
  blocked: string | null = null;
  /** The loaded document came from a pack put together for the play-test. */
  expanded = false;
  /** The last state reading. */
  state: PreviewStateResult | null = null;
  /** Readings taken since the game started. */
  readings = 0;
  /** What the running game was started from. */
  target: PreviewTarget | null = null;
  /** Edits since the running game loaded the document. */
  stale = false;
  /** Facing for a start at a cell. */
  dir: PreviewDir = "down";
  choice: StartChoice = { kind: "selection" };
  private loadedRevision = -1;
  private loadedSession: EditSession | null = null;
  /** What the running game loaded, so Restart can start it afresh. */
  private loadedText: string | null = null;
  private loadedChapters: PreviewChapter[] = [];
  /** The document revision last measured by checkDocument(). */
  private checked: { session: EditSession; revision: number } | null = null;
  private listeners = new Set<Listener>();
  private releaseListeners = new Set<Listener>();
  private polling = false;
  private releaseOff: (() => void) | null = null;
  private slotId = "";
  private connected = false;
  /** Bumped by every play/stop/close, so a stale async step gives up. */
  private generation = 0;

  constructor(
    private readonly app: StudioApp,
    private readonly host: StudioHost,
    private readonly examples: () => readonly StudioExample[],
  ) {
    app.on((reason) => {
      if (reason !== "edit" && reason !== "history" && reason !== "load") return;
      const session = app.session;
      const stale = this.loadedSession !== null && (session !== this.loadedSession || session.revision !== this.loadedRevision);
      if (stale !== this.stale) {
        this.stale = stale;
        this.emit();
      }
    });
  }

  /** Called when the user leaves the game with Esc. */
  onRelease(listener: Listener): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get open(): boolean {
    return this.status !== "closed";
  }

  /** The play-test connection, or why there is none. */
  availability(): { available: boolean; reason: string } {
    return this.host.capabilities().preview;
  }

  chapters(): PreviewChapter[] {
    const session = this.app.session;
    return session ? chaptersFor(this.examples(), session.title()) : [];
  }

  /** The start the panel's Play button would use now. */
  nextTarget(): PreviewTarget | null {
    const session = this.app.session;
    if (!session) return null;
    const choice = this.choice;
    if (choice.kind === "chapter") {
      return this.chapters().some((chapter) => chapter.id === choice.chapter) ? { kind: "chapter", chapter: choice.chapter } : null;
    }
    const selection = this.app.selection;
    if (choice.kind === "selection" && selection.kind === "cell" && this.app.mapId) {
      return { kind: "tile", map: this.app.mapId, x: selection.x, y: selection.y, dir: this.dir };
    }
    const start = session.globals().start;
    return { kind: "tile", map: start.map, x: start.x, y: start.y, dir: start.dir as PreviewDir };
  }

  /** Open the panel (its game shows in the element `slotId`) and play from
   * the current choice, unless the document cannot be played. */
  async openIn(slotId: string): Promise<void> {
    this.slotId = slotId;
    if (this.status === "closed") this.status = "stopped";
    this.error = null;
    this.releaseOff ??= this.host.preview()?.onRelease(() => {
      for (const listener of this.releaseListeners) listener();
    }) ?? null;
    this.checked = null;
    this.checkDocument(true);
    this.emit();
    if (!this.blocked) await this.play();
  }

  /** Load the current document and start it from `target` (default: the
   * current choice). Also "reload with the latest document". */
  async play(target: PreviewTarget | null = this.nextTarget()): Promise<boolean> {
    const preview = this.host.preview();
    const session = this.app.session;
    if (!preview) return this.fail(this.availability().reason);
    if (!session || this.status === "closed" || !this.slotId) return false;
    if (!target) return this.fail("Choose where to start.");
    const chapters = this.chapters();
    const document = previewDocument(session, chapters);
    this.checked = { session, revision: session.revision };
    this.blocked = document.ok ? null : document.reason;
    if (!document.ok) {
      this.emit();
      return false;
    }
    const generation = ++this.generation;
    this.error = null;
    this.state = null;
    this.readings = 0;
    if (!this.connected) {
      this.status = "connecting";
      this.emit();
      const connected = await preview.connect(this.slotId);
      if (generation !== this.generation) return false;
      if (!connected.ok) return this.fail(connected.message);
      this.connected = true;
    }
    this.status = "loading";
    this.emit();
    const revision = session.revision;
    const loaded = await preview.load(document.text, chapters);
    if (generation !== this.generation) return false;
    if (!loaded.ok) {
      if (loaded.code === "disconnected" || loaded.code === "bad-version" || loaded.code === "timeout") this.connected = false;
      return this.fail(`The game refused the document: ${loaded.message}`);
    }
    this.loadedSession = session;
    this.loadedRevision = revision;
    this.loadedText = document.text;
    this.loadedChapters = chapters;
    this.stale = this.app.session !== session || session.revision !== revision;
    this.expanded = document.expanded;
    return this.startAt(target, generation);
  }

  /** Start the loaded document again, from scratch, at the same place: the
   * game gets the same document again, so switches, items and the rest start
   * fresh (later edits wait for Reload). After Stop or a failure the game
   * holds nothing, so this loads the latest document. */
  async restart(): Promise<boolean> {
    const preview = this.host.preview();
    const target = this.target;
    const text = this.loadedText;
    if (!preview || !target || text === null || this.status !== "running") return this.play(target ?? this.nextTarget());
    const generation = ++this.generation;
    this.status = "loading";
    this.state = null;
    this.readings = 0;
    this.emit();
    const loaded = await preview.load(text, this.loadedChapters);
    if (generation !== this.generation) return false;
    if (!loaded.ok) {
      if (loaded.code === "disconnected" || loaded.code === "bad-version" || loaded.code === "timeout") this.connected = false;
      return this.fail(`The game refused the document: ${loaded.message}`);
    }
    return this.startAt(target, generation);
  }

  private async startAt(target: PreviewTarget, generation: number): Promise<boolean> {
    const preview = this.host.preview();
    if (!preview) return false;
    const started = await preview.start(target);
    if (generation !== this.generation) return false;
    if (!started.ok) {
      const where = target.kind === "chapter" ? `chapter ${target.chapter}` : `${target.map} (${target.x}, ${target.y})`;
      return this.fail(`Could not start at ${where}: ${started.message}`);
    }
    this.target = target;
    this.status = "running";
    this.error = null;
    this.emit();
    await this.poll();
    preview.focusGame();
    return true;
  }

  /** Read the game's state once (the panel calls this PREVIEW_POLL_HZ times
   * a second while running). */
  async poll(): Promise<void> {
    const preview = this.host.preview();
    if (!preview || this.status !== "running" || this.polling) return;
    this.polling = true;
    const generation = this.generation;
    try {
      const state = await preview.state();
      if (generation !== this.generation || this.status !== "running") return;
      if (!state.ok) {
        // The next Play embeds the game again.
        if (state.code === "disconnected" || state.code === "bad-version" || state.code === "timeout") this.connected = false;
        this.fail(`Lost the game: ${state.message}`);
        return;
      }
      this.state = state.value;
      this.readings++;
      this.emit();
    } finally {
      this.polling = false;
    }
  }

  async stop(): Promise<void> {
    const preview = this.host.preview();
    if (!preview || this.status === "closed") return;
    ++this.generation;
    this.status = "stopped";
    this.emit();
    const stopped = await preview.stop();
    if (!stopped.ok && this.status === "stopped") {
      if (stopped.code === "disconnected" || stopped.code === "bad-version" || stopped.code === "timeout") this.connected = false;
      this.fail(stopped.message);
    }
  }

  close(): void {
    ++this.generation;
    this.host.preview()?.disconnect();
    this.connected = false;
    this.releaseOff?.();
    this.releaseOff = null;
    this.status = "closed";
    this.state = null;
    this.target = null;
    this.loadedSession = null;
    this.loadedText = null;
    this.expanded = false;
    this.stale = false;
    this.error = null;
    this.emit();
  }

  focusGame(): void {
    this.host.preview()?.focusGame();
  }

  /** Recheck whether the open document can be played (after edits). The
   * check walks the whole document, so an unchanged revision is not measured
   * twice, and a sharded pack (which has to be put together first) is only
   * measured when it is played unless `packs` is set. */
  checkDocument(packs = false): void {
    const session = this.app.session;
    if (session && this.checked?.session === session && this.checked.revision === session.revision) return;
    if (session?.kind === "pack" && !packs) return;
    if (session) this.checked = { session, revision: session.revision };
    const document = session ? previewDocument(session, this.chapters()) : null;
    const blocked = document && !document.ok ? document.reason : null;
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      this.emit();
    }
  }

  private fail(message: string): false {
    this.status = "error";
    this.error = message;
    this.emit();
    return false;
  }
}
