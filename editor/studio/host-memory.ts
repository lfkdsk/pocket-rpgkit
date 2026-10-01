// editor/studio/host-memory.ts — a StudioHost with no browser underneath:
// files, folders, storage and exports are maps in memory. Tests drive Studio's
// document flow through it, and it shows what a host must provide.

import {
  available,
  NEEDS_DESKTOP,
  unavailable,
  type AgentOutcome,
  type CheckOutcome,
  type CheckRequest,
  type HostCapabilities,
  type LocalArt,
  type OpenedProject,
  type SaveOutcome,
  type SaveTarget,
  type StoredProject,
  type StudioExample,
  type StudioHost,
  type ThemeChoice,
} from "./host.ts";
import { MAX_PACK_BYTES, openFileProblem, PNG_HEADER_BYTES, pngProblem, utf8Bytes } from "../api/limits.ts";
import { checkProblems } from "./problems.ts";
import { isStagingPath, openDirectoryProject, saveDirectoryTarget, type ProjectDirectory } from "./project-directory.ts";

type OpenListener = (opened: OpenedProject | { error: string }) => void;

/** A fault MemoryDirectory injects: the matching call throws instead of
 * touching the file. */
export interface DirectoryFault {
  op: "write" | "rename" | "remove";
  /** The path to fail (for rename, the target `to`), or a test on it;
   * omitted = any path. */
  path?: string | ((path: string) => boolean);
  /** Fail only the nth matching call, counting from 1; omitted = every one. */
  nth?: number;
  /** The thrown error's message (default "injected <op> failure"). */
  message?: string;
}

/** A ProjectDirectory over a Map of POSIX paths to text. */
export class MemoryDirectory implements ProjectDirectory {
  readonly files: Map<string, string>;
  /** Paths whose bytes a write or rename replaced or created, in order.
   * Temporary files staged by a save (isStagingPath) are left out. */
  writes: string[] = [];
  /** Faults to inject; tests push to and clear this. */
  faults: DirectoryFault[] = [];
  /** Paths read, in order (tests check oversized files are never read). */
  reads: string[] = [];
  /** Sizes to report instead of a file's UTF-8 bytes, so tests can model
   * huge files without allocating them. */
  sizes = new Map<string, number>();
  /** Every read, write, rename (logged by its target) and remove, in
   * order, as "op path", including staged temporaries. */
  log: string[] = [];
  /** Called before each logged operation touches anything; a test returns a
   * promise to hold the call there until it chooses to let it go on. */
  gate: ((op: "read" | "write" | "rename" | "remove", path: string) => Promise<void> | void) | null = null;
  readonly rename?: (from: string, to: string) => Promise<void>;
  private seen = new Map<DirectoryFault, number>();

  /** `rename: false` models a host that cannot move files. */
  constructor(readonly name: string, files: Record<string, string> | Map<string, string>, options: { rename?: boolean } = {}) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
    if (options.rename !== false) this.rename = (from, to) => this.move(from, to);
  }

  private inject(op: DirectoryFault["op"], path: string): void {
    for (const fault of this.faults) {
      if (fault.op !== op) continue;
      if (fault.path !== undefined && (typeof fault.path === "string" ? fault.path !== path : !fault.path(path))) continue;
      const count = (this.seen.get(fault) ?? 0) + 1;
      this.seen.set(fault, count);
      if (fault.nth === undefined || fault.nth === count) throw new Error(fault.message ?? `injected ${op} failure`);
    }
  }

  async listRoot(): Promise<string[]> {
    return [...this.files.keys()].filter((path) => !path.includes("/"));
  }

  private async pass(op: "read" | "write" | "rename" | "remove", path: string): Promise<void> {
    this.log.push(`${op} ${path}`);
    await this.gate?.(op, path);
  }

  async read(path: string): Promise<string> {
    await this.pass("read", path);
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no file ${path}`);
    this.reads.push(path);
    return text;
  }

  async size(path: string): Promise<number> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no file ${path}`);
    return this.sizes.get(path) ?? utf8Bytes(text);
  }

  async write(path: string, text: string): Promise<void> {
    await this.pass("write", path);
    this.inject("write", path);
    this.files.set(path, text);
    if (!isStagingPath(path)) this.writes.push(path);
  }

  async remove(path: string): Promise<void> {
    await this.pass("remove", path);
    this.inject("remove", path);
    if (!this.files.delete(path)) throw new Error(`no file ${path}`);
  }

  private async move(from: string, to: string): Promise<void> {
    await this.pass("rename", to);
    this.inject("rename", to);
    const text = this.files.get(from);
    if (text === undefined) throw new Error(`no file ${from}`);
    this.files.set(to, text);
    this.files.delete(from);
    if (!isStagingPath(to)) this.writes.push(to);
  }
}

export class MemoryHost implements StudioHost {
  readonly name = "memory";
  /** Files the next pickProjectFile() call "chooses", in order. `size`
   * stands in for the file's byte size (default: the text's UTF-8 bytes), so
   * tests can pick an oversized file without building one. */
  filePicks: { name: string; text: string; size?: number }[] = [];
  /** Directories the next pickProjectDirectory() call "chooses". */
  directoryPicks: MemoryDirectory[] = [];
  /** Images the next pickImage() call "chooses": the file's bytes (at least
   * its PNG header) and, optionally, a byte size standing in for the file's. */
  imagePicks: { name: string; bytes: Uint8Array; size?: number }[] = [];
  examples: StudioExample[] = [];
  exampleTexts = new Map<string, string>();
  stored: StoredProject | null = null;
  exports: { fileName: string; text: string }[] = [];
  /** Answer for confirm(); every question is recorded. */
  confirmAnswer = true;
  questions: string[] = [];
  themeChoice: ThemeChoice = "system";
  dark = false;
  storageFails = false;
  private listeners = new Set<OpenListener>();
  private themeListeners = new Set<() => void>();

  capabilities(): HostCapabilities {
    return {
      openFile: available("Files come from MemoryHost.filePicks."),
      openDirectory: available("Folders come from MemoryHost.directoryPicks."),
      saveInPlace: available("Folders save back into their MemoryDirectory."),
      storage: this.storageFails ? unavailable("Storage is switched off.") : available("One document in MemoryHost.stored."),
      export: available("Exports collect in MemoryHost.exports."),
      localArt: available("Images come from MemoryHost.imagePicks."),
      checks: available("rpgkit-check's static lint, in-process."),
      dynamicChecks: unavailable("Not run in tests."),
      agent: unavailable(NEEDS_DESKTOP),
    };
  }

  onOpen(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(opened: OpenedProject | { error: string }): void {
    for (const listener of this.listeners) listener(opened);
  }

  pickProjectFile(): void {
    const file = this.filePicks.shift();
    if (!file) return;
    // Like a browser File: the size is known before the text is read.
    const problem = openFileProblem(file.size ?? utf8Bytes(file.text, MAX_PACK_BYTES), file.name);
    if (problem !== null) this.emit({ error: problem });
    else this.emit({ text: file.text, label: file.name, fileName: file.name });
  }

  async pickProjectDirectory(): Promise<void> {
    const dir = this.directoryPicks.shift();
    if (dir) this.emit(await openDirectoryProject(dir));
  }

  async listExamples(): Promise<StudioExample[]> {
    return this.examples;
  }

  async readExample(example: StudioExample): Promise<string> {
    const text = this.exampleTexts.get(example.id);
    if (text === undefined) throw new Error(`no text for example ${example.id}`);
    return text;
  }

  async save(text: string, meta: { label: string; fileName: string }, target?: SaveTarget): Promise<SaveOutcome> {
    const savedAt = new Date(0).toISOString();
    if (target?.kind === "directory") return saveDirectoryTarget(target, text, savedAt);
    if (this.storageFails) return { ok: false, message: "Not saved: storage is switched off." };
    this.stored = { label: meta.label, fileName: meta.fileName, text, savedAt };
    return { ok: true, where: "storage", written: ["memory"], savedAt };
  }

  restore(): StoredProject | null {
    return this.stored;
  }

  async exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }> {
    this.exports.push({ fileName, text });
    return { ok: true, message: `Exported ${fileName}.` };
  }

  async pickImage(): Promise<LocalArt | { error: string } | null> {
    const image = this.imagePicks.shift();
    if (!image) return null;
    const problem = pngProblem(image.name, image.size ?? image.bytes.length, image.bytes.subarray(0, PNG_HEADER_BYTES));
    if (problem !== null) return { error: problem };
    return { name: image.name, url: `memory:${image.name}`, release: () => {} };
  }

  async runChecks(request: CheckRequest): Promise<CheckOutcome> {
    if (request.mode === "dynamic") return { ok: false, code: "UNAVAILABLE", message: "Not run in tests." };
    return { ok: true, problems: checkProblems(request.project) };
  }

  async runAgent(): Promise<AgentOutcome> {
    return { ok: false, code: "NEEDS_DESKTOP", message: NEEDS_DESKTOP };
  }

  async confirm(text: string): Promise<boolean> {
    this.questions.push(text);
    return this.confirmAnswer;
  }

  guardClose(): void {}

  theme(): ThemeChoice {
    return this.themeChoice;
  }

  setTheme(choice: ThemeChoice): void {
    this.themeChoice = choice;
  }

  systemPrefersDark(): boolean {
    return this.dark;
  }

  /** Flip the "system" theme as an OS would. */
  setSystemDark(dark: boolean): void {
    this.dark = dark;
    for (const listener of this.themeListeners) listener();
  }

  onSystemThemeChange(listener: () => void): () => void {
    this.themeListeners.add(listener);
    return () => this.themeListeners.delete(listener);
  }
}
