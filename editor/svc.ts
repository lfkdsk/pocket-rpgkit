// editor/svc.ts — the rpgkit-editor companion channel over the spec svc
// ops (HostOps svcOpen/svcPoll/svcSend). The portable PocketJS desktop host
// (vendor/pocketjs/hosts/desktop/src/main.rs) is the companion when launched with
// `--companions rpgkit-editor`: it forwards the real keyboard and mouse as
// JSON lines and persists {t:"save"} lines to its --file.
//
// Hosts WITHOUT the channel (goldens, hosts/sim without injected ops, the
// browser playground) feature-detect to null. The editor then keeps a full
// buttons-only editing mode and renders a visible banner — never a window
// whose buttons are silently dead.
//
// host → guest lines used here:
//   {t:"hello",w,h}             logical viewport at boot
//   {t:"resize",w,h}            live window resize
//   {t:"load",text}             inline document text from the host's --file
//   {t:"project",shell}         sharded document shell (no map payloads)
//   {t:"map-data",request,...}  one requested map shard
//   {t:"map-error",request,...} failed map request
//   {t:"project-saved",...}     acknowledgement for a sharded save
//   {t:"mouse",x,y,d,b,sh}      pointer: b 0 left / 2 right; sh = shift;
//                               a Reset sends a bare {d:false} release
//   {t:"scroll",dy}             wheel scrolls the tile palette
//   {t:"ch",s}                  typed text (including IME output)
//   {t:"paste",text}            pasted text
//   {t:"proposals",proposals}   optional external proposal queue snapshot
//
// guest → host lines:
//   {t:"loaded",request,ok,...} acknowledge a browser-correlated load
//   {t:"save",text,request?}    persist an inline document; request is
//                               echoed for a browser Download round-trip
//   {t:"save",text}             legacy save when no managed data.fs bridge exists
//   {t:"map-read",request,...}  request one map shard by manifest entry
//   {t:"project-save",...}      persist a shell plus dirty shards only
//   {t:"proposal-review",proposal} persist one proposal's hunk decisions

import { getOps } from "@pocketjs/framework";
import { ServiceMessageAssembler, chunkServiceMessage } from "./engine/service-chunks.ts";

export const COMPANION = "rpgkit-editor";

export interface MouseEvent {
  t: "mouse";
  /** Absent on the bare {d:false} release the host sends on Reset. */
  x?: number;
  y?: number;
  d?: boolean;
  /** 0 primary (or omitted on moves), 2 secondary (right button erases). */
  b?: number;
  sh?: boolean;
}
export interface ScrollEvent {
  t: "scroll";
  dy: number;
}
export interface LoadEvent {
  t: "load";
  text: string;
  /** Optional browser-host correlation token. Desktop hosts omit it. */
  request?: number;
}
export interface ShardedProjectEvent {
  t: "project";
  shell: string;
  request?: number;
}
export interface MapDataEvent {
  t: "map-data";
  request: number;
  entry: string;
  text: string;
}
export interface MapErrorEvent {
  t: "map-error";
  request: number;
  entry: string;
  error: string;
}
export interface ProjectSavedEvent {
  t: "project-saved";
  request: number;
  ok: boolean;
  error?: string;
}
export interface DirtyShardSave {
  entry: string;
  text: string;
  /** Exact SHA-256 declared by the shell when this shard was loaded. */
  expectedSha256: string;
}
export interface ShardedSave {
  /** Manifest identity of the shell accepted by the editor. */
  baseManifestHash: string;
  shell: string;
  shards: DirtyShardSave[];
}
export interface ResizeEvent {
  t: "resize";
  w: number;
  h: number;
}
export interface KeyEvent {
  t: "key";
  k: string;
  cmd: boolean;
  sh: boolean;
  alt: boolean;
  ctl: boolean;
}
export interface CharacterEvent {
  t: "ch";
  s: string;
}
export interface PasteEvent {
  t: "paste";
  text: string;
}
export interface ProposalSnapshotEvent {
  t: "proposals";
  proposals: unknown;
}
/** A parsed host line. `t` is the discriminant; the typed interfaces below
 *  document each dialect, and extra fields stay accessible through the
 *  index signature. */
export type HostLine = {
  t: string;
  x?: number;
  y?: number;
  d?: boolean;
  b?: number;
  sh?: boolean;
  cmd?: boolean;
  alt?: boolean;
  ctl?: boolean;
  k?: string;
  w?: number;
  h?: number;
  dy?: number;
  s?: string;
  text?: string;
  shell?: string;
  entry?: string;
  error?: string;
  ok?: boolean;
  request?: number;
  proposals?: unknown;
  proposal?: unknown;
};

export interface Svc {
  /** Drain this frame's host lines (one poll per frame, per the HostOps
   *  contract). */
  poll(): HostLine[];
  /** Persist through a generic host channel. Managed desktop inline saves
   * use the data.fs compare-and-swap bridge instead. */
  save(text: string, request?: number): void;
  /** Ask the host for exactly one shard declared by the open shell. */
  readMap(entry: string, request: number): void;
  /** Persist only dirty shards and the refreshed shell. */
  saveProject(save: ShardedSave, request: number): void;
  /** Report whether a correlated host load passed full project validation. */
  loaded(request: number | undefined, ok: boolean, error?: string): void;
  /** Complete a correlated export request when schema validation failed. */
  saveError(request: number, error: string): void;
  /** Notify an enhanced companion that review metadata changed. The stock
   * desktop launcher also mirrors this through data.fs. */
  reviewProposal(proposal: unknown): void;
}

type SvcLine =
  | MouseEvent
  | ScrollEvent
  | LoadEvent
  | ShardedProjectEvent
  | MapDataEvent
  | MapErrorEvent
  | ProjectSavedEvent
  | ResizeEvent
  | KeyEvent
  | CharacterEvent
  | PasteEvent
  | ProposalSnapshotEvent
  | { t: "hello"; w: number; h: number };

export type { SvcLine };

type SvcOps = ReturnType<typeof getOps> & {
  svcOpen?: (name: string) => boolean;
  svcPoll?: () => string | null | undefined;
  svcSend?: (line: string) => void;
};

/** Probe the channel. Null = no companion on the other end; the caller
 *  renders its banner and switches to buttons-only editing. */
export function connectSvc(): Svc | null {
  const ops = getOps() as SvcOps;
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend) return null;
  let accepted = false;
  try {
    accepted = ops.svcOpen(COMPANION) === true;
  } catch {
    accepted = false;
  }
  if (!accepted) return null;
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  const assembler = new ServiceMessageAssembler();
  let nextTransfer = 1;
  const sendMessage = (value: unknown): void => {
    for (const line of chunkServiceMessage(value, nextTransfer++)) send(line);
  };
  return {
    poll() {
      const batch = poll();
      if (!batch) return [];
      const events: HostLine[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          const envelope = JSON.parse(line) as unknown;
          const assembled = assembler.push(envelope);
          if (assembled === undefined || typeof assembled !== "object" || assembled === null || Array.isArray(assembled)) {
            continue;
          }
          const parsed = assembled as Record<string, unknown>;
          // The key line carries cmd/ctl/alt/sh modifiers.
          if (parsed.t === "key") {
            events.push({
              t: "key",
              k: typeof parsed.k === "string" ? parsed.k : "",
              cmd: parsed.cmd === true,
              sh: parsed.sh === true,
              alt: parsed.alt === true,
              ctl: parsed.ctl === true,
              ...(typeof parsed.request === "number" ? { request: parsed.request } : {}),
            });
            continue;
          }
          events.push(parsed as unknown as HostLine);
        } catch {
          // A malformed line is a host bug; skip it rather than wedge.
        }
      }
      return events;
    },
    save(text, request) {
      send(JSON.stringify({ t: "save", text, ...(request === undefined ? {} : { request }) }));
    },
    readMap(entry, request) {
      send(JSON.stringify({ t: "map-read", request, entry }));
    },
    saveProject(save, request) {
      sendMessage({ t: "project-save", request, ...save });
    },
    loaded(request, ok, error) {
      send(JSON.stringify({
        t: "loaded",
        ok,
        ...(request === undefined ? {} : { request }),
        ...(error === undefined ? {} : { error }),
      }));
    },
    saveError(request, error) {
      send(JSON.stringify({ t: "save", request, error }));
    },
    reviewProposal(proposal) {
      send(JSON.stringify({ t: "proposal-review", proposal }));
    },
  };
}
