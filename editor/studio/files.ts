// editor/studio/files.ts — opening, saving and exporting documents through
// the StudioHost. The host decides where bytes go (browser storage, a folder,
// a download); this file decides when, validates first, and reports the
// outcome. It has no DOM dependency, so tests run it on the memory host.

import { EditSession } from "../api/session.ts";
import type { StudioApp } from "./app.ts";
import type { ArtRegistry } from "./art.ts";
import type { OpenedProject, SaveTarget, StudioExample, StudioHost } from "./host.ts";

export type { StudioExample } from "./host.ts";

/** What one save writes, fixed when Save is pressed. */
interface SaveJob {
  session: EditSession;
  target: SaveTarget | null;
  fileName: string;
  label: string;
}

export class StudioFiles {
  examples: StudioExample[] = [];
  /** Download file name for the open document. */
  fileName = "project.json";
  lastSavedAt: string | null = null;
  /** Where the last save went: "storage", "file" or "directory". */
  lastSavedWhere: "storage" | "file" | "directory" | null = null;
  /** Set when the open document saves back where it came from. */
  target: SaveTarget | null = null;
  /** Saves started and not yet finished (running or queued). The UI shows
   * "Saving…" and disables Save while this is above zero. */
  saving = 0;
  /** The folder the running save writes into: the document's when Save was
   * pressed, which need not be the one open now. Null for storage saves. */
  savingTo: string | null = null;
  private saveQueue: Promise<unknown> = Promise.resolve();

  constructor(private app: StudioApp, private art: ArtRegistry, readonly host: StudioHost) {
    host.onOpen((opened) => void this.opened(opened));
  }

  async loadExamples(): Promise<void> {
    try {
      this.examples = await this.host.listExamples();
    } catch (error) {
      this.app.notify("error", `Bundled examples are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Load bundled art for every sheet/sprite id the document uses that a
   * bundled example provides (art is keyed by id, as in the PocketJS editor). */
  private attachBundledArt(): void {
    const session = this.app.session;
    if (!session) return;
    this.art.clear();
    const sheets = new Map<string, string>();
    const sprites = new Map<string, string>();
    for (const example of this.examples) {
      for (const [id, url] of Object.entries(example.sheets)) if (!sheets.has(id)) sheets.set(id, url);
      for (const [id, url] of Object.entries(example.sprites)) if (!sprites.has(id)) sprites.set(id, url);
    }
    for (const sheet of session.sheets()) {
      const url = sheets.get(sheet.id);
      if (url) void this.art.loadBundledSheet(sheet.id, url);
    }
    for (const id of Object.keys(session.sprites())) {
      const url = sprites.get(id);
      if (url) void this.art.loadBundledSprite(id, url);
    }
  }

  /** Open document text; returns false (with a visible error) if invalid. */
  openText(text: string, label: string, fileName: string, target: SaveTarget | null = null): boolean {
    let session: EditSession;
    try {
      session = EditSession.open(text);
    } catch (error) {
      const details = (error as { details?: { path: string; msg: string }[] }).details;
      const first = Array.isArray(details) && details[0] ? ` (${details[0].path}: ${details[0].msg})` : "";
      this.app.notify("error", `Could not open ${label}: ${error instanceof Error ? error.message : String(error)}${first}`);
      return false;
    }
    this.fileName = fileName;
    this.target = target;
    this.lastSavedAt = null;
    this.lastSavedWhere = null;
    this.app.load(session, { label, savesTo: target ? target.name : "storage" });
    this.attachBundledArt();
    return true;
  }

  /** A document picked through the host (file, folder, drop…). */
  async opened(opened: OpenedProject | { error: string }): Promise<boolean> {
    if ("error" in opened) {
      this.app.notify("error", opened.error);
      return false;
    }
    if (!(await this.confirmDiscard())) return false;
    const ok = this.openText(opened.text, opened.label, opened.fileName, opened.target ?? null);
    if (ok) {
      const kind = this.app.session?.kind === "pack" ? "sharded pack" : "project";
      const where = opened.target ? ` Save writes back into ${opened.target.name}.` : "";
      this.app.notify("info", `Opened ${kind} ${opened.label}.${where}`);
    }
    return ok;
  }

  openFile(): void {
    this.host.pickProjectFile();
  }

  async openDirectory(): Promise<void> {
    const status = this.host.capabilities().openDirectory;
    if (!status.available) {
      this.app.notify("error", status.reason);
      return;
    }
    await this.host.pickProjectDirectory();
  }

  async openExample(id: string): Promise<boolean> {
    const example = this.examples.find((item) => item.id === id);
    if (!example) {
      this.app.notify("error", `Unknown example ${id}`);
      return false;
    }
    if (!(await this.confirmDiscard())) return false;
    try {
      const text = await this.host.readExample(example);
      const ok = this.openText(text, example.title, example.document.split("/").pop() ?? `${id}.json`);
      if (ok) this.app.notify("info", `Opened ${example.title}. Edits stay here until you save or download.`);
      return ok;
    } catch (error) {
      this.app.notify("error", `Could not load ${example.title}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async confirmDiscard(): Promise<boolean> {
    if (!this.app.session?.isDirty()) return true;
    return this.host.confirm("The open document has unsaved changes. Discard them?");
  }

  /** Validate, then save: into the folder it came from, else host storage.
   * A save started while another is running waits for it, then saves the
   * document as it is by then (Ctrl/Cmd+S pressed twice saves twice, in
   * order, never at the same time). A save belongs to the document open
   * when it was started: if another document is opened meanwhile, the save
   * still writes the first one and reports it by name, and the newly open
   * document's saved state is left alone. */
  save(): Promise<boolean> {
    const session = this.app.session;
    const job: SaveJob | null = session
      ? { session, target: this.target, fileName: this.fileName, label: this.app.origin?.label ?? session.title() }
      : null;
    this.saving += 1;
    if (this.saving === 1) this.app.emit("saving");
    const run = this.saveQueue.then(() => (job ? this.saveNow(job) : false));
    this.saveQueue = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.saving -= 1;
      if (this.saving === 0) {
        this.savingTo = null;
        this.app.emit("saving");
      }
    });
  }

  /** Whether `job`'s document is still the one open. Reopening the same
   * folder makes a new session and target, so it does not count. */
  private isOpen(job: SaveJob): boolean {
    return this.app.session === job.session && this.target === job.target;
  }

  private async saveNow(job: SaveJob): Promise<boolean> {
    const { session, target } = job;
    const name = target?.name ?? null;
    this.savingTo = name;
    const problems = session.validate();
    if (problems.length > 0) {
      if (this.isOpen(job)) {
        this.app.problems = problems;
        this.app.emit("problems");
      }
      this.app.notify("error", `Not saved${name ? ` to ${name}` : ""}: the document has ${problems.length} validation problem${problems.length === 1 ? "" : "s"}.`);
      return false;
    }
    const text = session.exportText();
    const outcome = await this.host.save(text, { label: job.label, fileName: job.fileName }, target ?? undefined);
    if (!outcome.ok) {
      this.app.notify("error", outcome.message);
      return false;
    }
    // Edits made while an asynchronous save was writing stay unsaved.
    if (session.exportText() === text) session.markSaved();
    const open = this.isOpen(job);
    if (open) {
      this.lastSavedAt = outcome.savedAt;
      this.lastSavedWhere = outcome.where;
    }
    this.app.notify("ok", outcome.where === "storage"
      ? `Saved in ${this.host.name === "browser" ? "this browser" : "local storage"}.`
      : `Saved to ${name ?? "disk"}: ${outcome.written.length === 0 ? "nothing changed" : `${outcome.written.length} file${outcome.written.length === 1 ? "" : "s"} written`}.`);
    if (open) this.app.emit("saved");
    return true;
  }

  /** Reopen the document saved in host storage, if any. */
  restore(): boolean {
    const stored = this.host.restore();
    if (!stored) return false;
    if (!this.openText(stored.text, stored.label, stored.fileName)) return false;
    this.lastSavedAt = stored.savedAt;
    this.lastSavedWhere = "storage";
    this.app.notify("info", `Restored “${stored.label}” saved ${this.host.name === "browser" ? "in this browser" : "earlier"}.`);
    return true;
  }

  async download(): Promise<void> {
    const session = this.app.session;
    if (!session) return;
    const fileName = this.fileName.endsWith(".json") ? this.fileName : `${this.fileName}.json`;
    const outcome = await this.host.exportFile(fileName, session.exportText());
    this.app.notify(outcome.ok ? "ok" : "error", outcome.message);
  }
}
