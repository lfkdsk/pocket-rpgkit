/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// editor/studio/host-browser.ts — the StudioHost for a web page. With its
// page boot snippet (host-browser-boot.ts), the only code in editor/studio/
// that talks to browser storage, pickers, downloads and fetch
// (tests/studio-host.test.ts checks this).
//
//   save      localStorage, one document per origin; a document opened from
//             a directory saves back into it instead
//   open      <input type=file>; Chromium's directory picker (File System
//             Access) for loose sharded projects
//   export    a Blob behind a download link
//   checks    schema + rpgkit-check static lint, in the page
//   agent     not here: it needs a local process

import { THEME_KEY } from "./host-browser-boot.ts";
import { checkProblems } from "./problems.ts";
import { openFileProblem, PNG_HEADER_BYTES, pngProblem } from "../api/limits.ts";
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
import { openDirectoryProject, saveDirectoryTarget, type ProjectDirectory } from "./project-directory.ts";

export const STORAGE_KEY = "pocket-rpgkit:studio:document:v1";
export { THEME_KEY };

interface StoredDocument extends StoredProject {
  v: 1;
}

type OpenListener = (opened: OpenedProject | { error: string }) => void;

/** The parts of the File System Access API this host uses (not in every
 * TypeScript DOM lib yet). */
interface DirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<{ kind: "file" | "directory"; name: string }>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
}

interface FileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  /** Rename within the same directory; newer Chromium only. */
  move?(newName: string): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A ProjectDirectory over a File System Access directory handle. */
export function handleDirectory(root: DirectoryHandle): ProjectDirectory {
  const walk = async (path: string): Promise<{ parent: DirectoryHandle; name: string }> => {
    const parts = path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
    return { parent, name: parts.at(-1)! };
  };
  return {
    name: `${root.name}/`,
    async listRoot() {
      const names: string[] = [];
      for await (const item of root.values()) if (item.kind === "file") names.push(item.name);
      return names;
    },
    async read(path) {
      const { parent, name } = await walk(path);
      return (await (await parent.getFileHandle(name)).getFile()).text();
    },
    async size(path) {
      const { parent, name } = await walk(path);
      return (await (await parent.getFileHandle(name)).getFile()).size;
    },
    async write(path, text) {
      const { parent, name } = await walk(path);
      await writeHandle(await parent.getFileHandle(name, { create: true }), text);
    },
    async remove(path) {
      const { parent, name } = await walk(path);
      await parent.removeEntry(name);
    },
    // Replace `to` with the staged file `from` (a sibling). FileSystemFileHandle
    // .move() renames in place, but not every Chromium has it, and some
    // versions refuse to move onto an existing name. So the staged bytes are
    // read first, move() is tried when present, and if it is missing or throws
    // the bytes are written into `to` instead. That write is still all or
    // nothing per file: Chromium's createWritable() writes a swap file and
    // swaps it in on close(), so `to` keeps its old bytes if it fails.
    async rename(from, to) {
      const source = await walk(from);
      const target = await walk(to);
      const handle = await source.parent.getFileHandle(source.name);
      const text = await (await handle.getFile()).text();
      const sameFolder = from.slice(0, from.lastIndexOf("/") + 1) === to.slice(0, to.lastIndexOf("/") + 1);
      if (sameFolder && typeof handle.move === "function") {
        try {
          await handle.move(target.name);
          return;
        } catch {
          // Fall through to the copy below.
        }
      }
      await writeHandle(await target.parent.getFileHandle(target.name, { create: true }), text);
      await source.parent.removeEntry(source.name).catch(() => undefined);
    },
  };
}

async function writeHandle(handle: FileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

export class BrowserHost implements StudioHost {
  readonly name = "browser";
  private listeners = new Set<OpenListener>();
  private fileInput: HTMLInputElement;
  private systemDark = window.matchMedia("(prefers-color-scheme: dark)");

  constructor() {
    // A persistent input: the toolbar opens it, and automation can set its
    // files directly.
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "application/json,.json";
    this.fileInput.hidden = true;
    this.fileInput.id = "studio-open-input";
    document.body.appendChild(this.fileInput);
    this.fileInput.addEventListener("change", async () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (!file) return;
      // Refuse an oversized file before reading it into memory.
      const tooBig = openFileProblem(file.size, file.name);
      if (tooBig !== null) {
        this.emit({ error: tooBig });
        return;
      }
      try {
        this.emit({ text: await file.text(), label: file.name, fileName: file.name });
      } catch (error) {
        this.emit({ error: `Could not read ${file.name}: ${message(error)}` });
      }
    });
  }

  private storageWorks(): boolean {
    try {
      return typeof localStorage !== "undefined" && localStorage !== null;
    } catch {
      return false;
    }
  }

  private directoryPicker(): ((options: { mode: "readwrite" }) => Promise<DirectoryHandle>) | null {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    return typeof picker === "function" ? picker.bind(window) : null;
  }

  capabilities(): HostCapabilities {
    const directories = this.directoryPicker() !== null;
    const noDirectories = "This browser has no directory picker (File System Access); open a sharded pack file instead, or use Chrome or Edge.";
    return {
      openFile: available("Open a project JSON or a sharded pack from your computer."),
      openDirectory: directories ? available("Open a folder holding project.json and its map files; Save writes back into it.") : unavailable(noDirectories),
      saveInPlace: directories
        ? available("Projects opened from a folder save back into that folder. A failed write puts back the files already replaced; the save is not crash-proof, so a crash or closed tab mid-save can leave a mix of old and new files.")
        : unavailable(`Single files cannot be saved in place by a web page. ${noDirectories}`),
      storage: this.storageWorks()
        ? available("Save keeps one document in this browser and restores it next time.")
        : unavailable("This browser blocks local storage for this page; use Download."),
      export: available("Download hands the exact export bytes to the browser."),
      localArt: available("Chosen PNGs are used in this page only; they are not uploaded or saved."),
      checks: available("Schema validation and rpgkit-check's static lint run in this page."),
      dynamicChecks: unavailable("rpgkit-check's engine checks (reachability, locks) are not wired into the web page; run rpgkit-check locally or use the desktop app."),
      agent: unavailable(NEEDS_DESKTOP),
    };
  }

  private emit(opened: OpenedProject | { error: string }): void {
    for (const listener of this.listeners) listener(opened);
  }

  onOpen(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pickProjectFile(): void {
    this.fileInput.click();
  }

  async pickProjectDirectory(): Promise<void> {
    const picker = this.directoryPicker();
    if (!picker) {
      this.emit({ error: this.capabilities().openDirectory.reason });
      return;
    }
    let handle: DirectoryHandle;
    try {
      handle = await picker({ mode: "readwrite" });
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") this.emit({ error: `Could not open the folder: ${message(error)}` });
      return;
    }
    await this.openDirectoryHandle(handle);
  }

  /** Open a directory handle from the picker (or, in tests, from the
   * origin-private file system). */
  async openDirectoryHandle(handle: DirectoryHandle): Promise<void> {
    this.emit(await openDirectoryProject(handleDirectory(handle)));
  }

  async listExamples(): Promise<StudioExample[]> {
    const response = await fetch("examples.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { examples: StudioExample[] }).examples;
  }

  async readExample(example: StudioExample): Promise<string> {
    const response = await fetch(example.document);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async save(text: string, meta: { label: string; fileName: string }, target?: SaveTarget): Promise<SaveOutcome> {
    const savedAt = new Date().toISOString();
    if (target?.kind === "directory") return saveDirectoryTarget(target, text, savedAt);
    if (target) return { ok: false, message: `This browser cannot save to ${target.name} in place.` };
    const stored: StoredDocument = { v: 1, label: meta.label, fileName: meta.fileName, text, savedAt };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      return { ok: false, message: `Not saved: browser storage refused the document (${error instanceof Error ? error.name : String(error)}). Download keeps working.` };
    }
    return { ok: true, where: "storage", written: [STORAGE_KEY], savedAt };
  }

  restore(): StoredProject | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredDocument;
      if (stored.v !== 1 || typeof stored.text !== "string") return null;
      return { label: stored.label, fileName: stored.fileName, text: stored.text, savedAt: stored.savedAt };
    } catch {
      return null;
    }
  }

  async exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }> {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, message: `Downloaded ${fileName}.` };
  }

  pickImage(): Promise<LocalArt | { error: string } | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png";
      input.hidden = true;
      document.body.appendChild(input);
      const done = (art: LocalArt | { error: string } | null) => {
        input.remove();
        resolve(art);
      };
      input.addEventListener("cancel", () => done(null));
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return done(null);
        // Size first, then only the 24-byte header (signature, width,
        // height) before the image is ever decoded.
        let problem = pngProblem(file.name, file.size);
        if (problem === null) {
          try {
            problem = pngProblem(file.name, file.size, new Uint8Array(await file.slice(0, PNG_HEADER_BYTES).arrayBuffer()));
          } catch (error) {
            problem = `Could not read ${file.name}: ${message(error)}`;
          }
        }
        if (problem !== null) return done({ error: problem });
        const url = URL.createObjectURL(file);
        done({ name: file.name, url, release: () => URL.revokeObjectURL(url) });
      });
      input.click();
    });
  }

  async runChecks(request: CheckRequest): Promise<CheckOutcome> {
    if (request.mode === "dynamic") return { ok: false, code: "UNAVAILABLE", message: this.capabilities().dynamicChecks.reason };
    try {
      return { ok: true, problems: checkProblems(request.project) };
    } catch (error) {
      return { ok: false, code: "FAILED", message: `Checks could not run: ${message(error)}` };
    }
  }

  async runAgent(): Promise<AgentOutcome> {
    return { ok: false, code: "NEEDS_DESKTOP", message: NEEDS_DESKTOP };
  }

  async confirm(text: string): Promise<boolean> {
    return window.confirm(text);
  }

  guardClose(isDirty: () => boolean): void {
    window.addEventListener("beforeunload", (event) => {
      if (isDirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }

  theme(): ThemeChoice {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch { /* storage unavailable: follow the system */ }
    return "system";
  }

  setTheme(choice: ThemeChoice): void {
    try {
      if (choice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch { /* not persisted */ }
  }

  systemPrefersDark(): boolean {
    return this.systemDark.matches;
  }

  onSystemThemeChange(listener: () => void): () => void {
    this.systemDark.addEventListener("change", listener);
    return () => this.systemDark.removeEventListener("change", listener);
  }
}
