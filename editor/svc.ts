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
//   {t:"load",text}             document text from the host's --file
//   {t:"mouse",x,y,d,b,sh}      pointer: b 0 left / 2 right; sh = shift;
//                               a Reset sends a bare {d:false} release
//   {t:"scroll",dy}             wheel scrolls the tile palette
//   {t:"ch",s}                  typed text (including IME output)
//   {t:"paste",text}            pasted text
//   {t:"proposals",proposals}   optional external proposal queue snapshot
//
// guest → host lines:
//   {t:"loaded",request,ok,...} acknowledge a browser-correlated load
//   {t:"save",text,request?}    persist the exported document; request is
//                               echoed for a browser Download round-trip
//   {t:"save",text}             legacy save when no managed data.fs bridge exists
//   {t:"proposal-review",proposal} persist one proposal's hunk decisions

import { getOps } from "@pocketjs/framework";

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
  request?: number;
  proposals?: unknown;
  proposal?: unknown;
};

export interface Svc {
  /** Drain this frame's host lines (one poll per frame, per the HostOps
   *  contract). */
  poll(): HostLine[];
  /** Persist the exported document through a generic host channel. The
   * managed editor launcher uses the data.fs compare-and-swap bridge instead. */
  save(text: string, request?: number): void;
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
  | ResizeEvent
  | KeyEvent
  | CharacterEvent
  | PasteEvent
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
  return {
    poll() {
      const batch = poll();
      if (!batch) return [];
      const events: HostLine[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
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
