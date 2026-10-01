// editor/studio/preview.ts — the slot for in-browser play-testing (next
// phase). A preview host will embed the real game page in an iframe and talk
// to it over postMessage: Studio sends the current export text and a start
// cell, the game answers with its state. Until a host is registered the
// toolbar's play button stays disabled and explains why.

export interface PreviewStart {
  map: string;
  x: number;
  y: number;
}

export interface StudioPreviewHost {
  /** Start (or restart) the game from `projectText` at `start`. */
  start(projectText: string, start: PreviewStart): Promise<void>;
  stop(): void;
  /** Game state snapshots (switches, variables, position) while running. */
  onState(listener: (state: Record<string, unknown>) => void): () => void;
}

let host: StudioPreviewHost | null = null;

export function registerPreviewHost(next: StudioPreviewHost | null): void {
  host = next;
}

export function previewHost(): StudioPreviewHost | null {
  return host;
}
