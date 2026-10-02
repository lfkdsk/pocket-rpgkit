// tests/preview-protocol.test.ts — the rpgkit-preview/v1 protocol core:
// origin allowlist, message parsing, and dispatch against a fake backend.
// The browser end-to-end path lives in tools/web-verify.ts.

import { describe, expect, test } from "bun:test";
import {
  PREVIEW_ART_SLICE_BYTES,
  PREVIEW_ECHO_LIMIT,
  PREVIEW_LIMITS,
  PREVIEW_PROTOCOL,
  PreviewArtStage,
  PreviewError,
  decodePreviewBase64,
  dispatchPreviewMessage,
  echoPreviewValue,
  encodePreviewBase64,
  isAllowedOrigin,
  parsePreviewMessage,
  previewAllowlist,
  previewMessageBytes,
  walkPreviewBytes,
  type PreviewBackend,
  type PreviewLoadResult,
  type PreviewStartResult,
  type PreviewStateResult,
} from "../tools/preview/protocol.ts";

const SELF = "https://preview.example";
const OTHER = "https://editor.example";

const LOAD_RESULT: PreviewLoadResult = {
  title: "Yard",
  maps: [{ id: "yard", name: "Old Yard", width: 12, height: 8 }],
  start: { map: "yard", x: 5, y: 5, dir: "up" },
};
const START_RESULT: PreviewStartResult = { map: "yard", x: 2, y: 2, dir: "down" };
const STATE_RESULT: PreviewStateResult = {
  status: "running",
  map: "yard",
  x: 2,
  y: 2,
  px: 34,
  py: 34,
  dir: "down",
  moving: false,
  frame: 120,
  running: 1,
  event: "yard/gardener",
  message: { kind: "text", text: "Hello there." },
  switches: { "met-gardener": true },
  variables: {},
  gold: 10,
  items: {},
};

function fakeBackend(): PreviewBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load(document, _chapters, art) {
      calls.push(`load:${typeof document === "string" ? "text" : "object"}${art ? ":art" : ""}`);
      return LOAD_RESULT;
    },
    art(slice) {
      calls.push(`art:${slice.kind}:${slice.id}:${slice.offset}:${slice.bytes.length}`);
      return { received: slice.offset + slice.bytes.length, complete: false, staged: 1 };
    },
    start(target) {
      calls.push(`start:${target.kind}`);
      return START_RESULT;
    },
    state() {
      calls.push("state");
      return STATE_RESULT;
    },
    input(buttons, frames) {
      calls.push(`input:${buttons}:${frames}`);
    },
    stop() {
      calls.push("stop");
    },
  };
}

const msg = (extra: Record<string, unknown>) => ({ protocol: PREVIEW_PROTOCOL, requestId: "r1", ...extra });

describe("preview allowlist", () => {
  test("the page's own origin is always allowed", () => {
    const allow = previewAllowlist(SELF, "");
    expect(isAllowedOrigin(allow, SELF)).toBe(true);
    expect(allow.size).toBe(1);
  });

  test("preview-origin query parameters add origins, repeated and comma-separated", () => {
    const allow = previewAllowlist(SELF, `?preview-origin=${encodeURIComponent(OTHER)}&preview-origin=https://a.example,https://b.example`);
    expect(isAllowedOrigin(allow, OTHER)).toBe(true);
    expect(isAllowedOrigin(allow, "https://a.example")).toBe(true);
    expect(isAllowedOrigin(allow, "https://b.example")).toBe(true);
    expect(isAllowedOrigin(allow, SELF)).toBe(true);
  });

  test("the opaque null origin and empty origins are never allowed", () => {
    const allow = previewAllowlist(SELF, "?preview-origin=null");
    expect(isAllowedOrigin(allow, "null")).toBe(false);
    expect(isAllowedOrigin(allow, "")).toBe(false);
  });
});

describe("preview parsing", () => {
  test("accepts the five request shapes", () => {
    expect(parsePreviewMessage(msg({ type: "load", document: "{}" })).type).toBe("load");
    expect(parsePreviewMessage(msg({ type: "load", document: {} })).document).toEqual({});
    const tile = parsePreviewMessage(msg({ type: "start", map: "yard", x: 2, y: 3, dir: "left" }));
    expect(tile.start).toEqual({ kind: "tile", map: "yard", x: 2, y: 3, dir: "left" });
    expect(parsePreviewMessage(msg({ type: "start", chapter: "intro" })).start).toEqual({ kind: "chapter", chapter: "intro" });
    expect(parsePreviewMessage(msg({ type: "state" })).type).toBe("state");
    expect(parsePreviewMessage(msg({ type: "input", buttons: 0x0020, frames: 30 }))).toMatchObject({ buttons: 0x0020, frames: 30 });
    expect(parsePreviewMessage(msg({ type: "input", buttons: 0 }))).toMatchObject({ buttons: 0, frames: 1 });
    expect(parsePreviewMessage(msg({ type: "stop" })).type).toBe("stop");
  });

  test("input and stop may omit requestId", () => {
    expect(parsePreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", buttons: 1 }).requestId).toBeUndefined();
    expect(parsePreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "stop" }).requestId).toBeUndefined();
  });

  test("rejects a foreign protocol with bad-version", () => {
    const foreign = () => parsePreviewMessage({ protocol: "rpgkit-preview/v2", type: "state", requestId: "r1" });
    expect(foreign).toThrow(/unsupported protocol/);
    expect(foreign).toThrow(PreviewError);
    try {
      foreign();
    } catch (error) {
      expect((error as PreviewError).code).toBe("bad-version");
    }
    expect(() => parsePreviewMessage({ type: "state", requestId: "r1" })).toThrow(/bad-version|unsupported protocol/);
  });

  test("rejects malformed messages with bad-message", () => {
    const bad = (m: unknown) => () => parsePreviewMessage(m);
    expect(bad(null)).toThrow(/not a JSON object/);
    expect(bad("string")).toThrow(/not a JSON object/);
    expect(bad([1, 2])).toThrow(/not a JSON object/);
    expect(bad({ protocol: PREVIEW_PROTOCOL })).toThrow(/type is missing/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "state" })).toThrow(/state needs a requestId/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "load", requestId: "r1" })).toThrow(/load needs a document/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "start", requestId: "r1" })).toThrow(/map id and x\/y/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "start", requestId: "r1", map: "yard", x: -1, y: 2 })).toThrow(/non-negative/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "start", requestId: "r1", map: "yard", x: 1, y: 2, dir: "sideways" })).toThrow(/dir must be one of/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "start", requestId: "r1", chapter: "" })).toThrow(/chapter is empty/);
    expect(bad({ protocol: PREVIEW_PROTOCOL, type: "wat", requestId: "r1" })).toThrow(/unknown type/);
  });

  test("rejects bad input with bad-input", () => {
    const bad = (m: unknown) => () => parsePreviewMessage(m);
    expect(bad(msg({ type: "input", buttons: -1 }))).toThrow(/u16/);
    expect(bad(msg({ type: "input", buttons: 0x10000 }))).toThrow(/u16/);
    expect(bad(msg({ type: "input", buttons: 1, frames: 0 }))).toThrow(/frames must be/);
    expect(bad(msg({ type: "input", buttons: 1, frames: 601 }))).toThrow(/frames must be/);
    expect(bad(msg({ type: "input", buttons: "1" }))).toThrow(/u16/);
  });
});

describe("preview dispatch", () => {
  test("a message from a disallowed origin is dropped without a reply", () => {
    const backend = fakeBackend();
    const dispatch = dispatchPreviewMessage(msg({ type: "state" }), OTHER, previewAllowlist(SELF, ""), backend);
    expect(dispatch).toBe("drop");
    expect(backend.calls).toEqual([]);
  });

  test("load/start/state reply with their results", () => {
    const backend = fakeBackend();
    const allow = previewAllowlist(SELF, "");
    const load = dispatchPreviewMessage(msg({ type: "load", document: "{...}" }), SELF, allow, backend);
    expect(load).toEqual({ protocol: PREVIEW_PROTOCOL, type: "reply", requestId: "r1", ok: true, result: LOAD_RESULT });
    const start = dispatchPreviewMessage(msg({ type: "start", map: "yard", x: 2, y: 2 }), SELF, allow, backend);
    expect(start).toMatchObject({ ok: true, result: START_RESULT });
    const state = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, backend);
    expect(state).toMatchObject({ ok: true, result: STATE_RESULT });
    expect(backend.calls).toEqual(["load:text", "start:tile", "state"]);
  });

  test("a chapter start dispatches to the chapter path", () => {
    const backend = fakeBackend();
    const dispatch = dispatchPreviewMessage(msg({ type: "start", chapter: "intro" }), SELF, previewAllowlist(SELF, ""), backend);
    expect(dispatch).toMatchObject({ ok: true });
    expect(backend.calls).toEqual(["start:chapter"]);
  });

  test("input and stop without requestId run but produce no reply", () => {
    const backend = fakeBackend();
    const allow = previewAllowlist(SELF, "");
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", buttons: 0x0020, frames: 10 }, SELF, allow, backend)).toBeNull();
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "stop" }, SELF, allow, backend)).toBeNull();
    expect(backend.calls).toEqual(["input:32:10", "stop"]);
  });

  test("input and stop with requestId get an empty ok reply", () => {
    const backend = fakeBackend();
    const allow = previewAllowlist(SELF, "");
    expect(dispatchPreviewMessage(msg({ type: "input", buttons: 1 }), SELF, allow, backend)).toEqual({
      protocol: PREVIEW_PROTOCOL, type: "reply", requestId: "r1", ok: true,
    });
    expect(dispatchPreviewMessage(msg({ type: "stop" }), SELF, allow, backend)).toEqual({
      protocol: PREVIEW_PROTOCOL, type: "reply", requestId: "r1", ok: true,
    });
  });

  test("a PreviewError from the backend becomes an error reply with its code", () => {
    const backend: PreviewBackend = {
      ...fakeBackend(),
      state: () => { throw new PreviewError("not-loaded", "no project is loaded"); },
    };
    const dispatch = dispatchPreviewMessage(msg({ type: "state" }), SELF, previewAllowlist(SELF, ""), backend);
    expect(dispatch).toMatchObject({ ok: false, error: { code: "not-loaded", message: "no project is loaded" } });
  });

  test("an unexpected backend error becomes an internal error reply", () => {
    const backend: PreviewBackend = {
      ...fakeBackend(),
      load: () => { throw new Error("boom"); },
    };
    const dispatch = dispatchPreviewMessage(msg({ type: "load", document: "{}" }), SELF, previewAllowlist(SELF, ""), backend);
    expect(dispatch).toMatchObject({ ok: false, error: { code: "internal", message: "boom" } });
  });

  test("a malformed message with a requestId gets an error reply; without one, silence", () => {
    const backend = fakeBackend();
    const allow = previewAllowlist(SELF, "");
    const withId = dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", requestId: "r9", buttons: -1 }, SELF, allow, backend);
    expect(withId).toMatchObject({ requestId: "r9", ok: false, error: { code: "bad-input" } });
    const withoutId = dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", buttons: -1 }, SELF, allow, backend);
    expect(withoutId).toBeNull();
    expect(backend.calls).toEqual([]);
  });
});

describe("preview message limits", () => {
  const allow = previewAllowlist(SELF, "");

  /** A load message whose document pads the whole wire message to exactly
   *  `extra` bytes over the budget. The fake backend never inspects it. */
  function loadAtBudget(extra: number) {
    const overhead = previewMessageBytes(msg({ type: "load", document: "" }));
    const bytes = PREVIEW_LIMITS.maxMessageBytes - overhead + extra;
    return msg({ type: "load", document: "x".repeat(bytes) });
  }

  test("a message exactly at the byte budget is accepted", () => {
    const backend = fakeBackend();
    const dispatch = dispatchPreviewMessage(loadAtBudget(0), SELF, allow, backend);
    expect(dispatch).toMatchObject({ ok: true });
    expect(backend.calls).toEqual(["load:text"]);
  });

  test("a message one byte over the budget is refused with too-large and not run", () => {
    const backend = fakeBackend();
    const dispatch = dispatchPreviewMessage(loadAtBudget(1), SELF, allow, backend);
    expect(dispatch).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend.calls).toEqual([]);
  });

  test("the budget is enforced before parsing, so an over-budget message with a bad shape is still too-large", () => {
    const backend = fakeBackend();
    const huge = { protocol: PREVIEW_PROTOCOL, type: "load", requestId: "r1", document: "x".repeat(PREVIEW_LIMITS.maxMessageBytes + 16) };
    const dispatch = dispatchPreviewMessage(huge, SELF, allow, backend);
    expect(dispatch).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend.calls).toEqual([]);
  });

  test("a load with exactly maxChapters chapters is accepted", () => {
    const backend = fakeBackend();
    const chapters = Array.from({ length: PREVIEW_LIMITS.maxChapters }, (_, i) => ({ id: `c${i}`, title: "t", snapshot: "s" }));
    const dispatch = dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters }), SELF, allow, backend);
    expect(dispatch).toMatchObject({ ok: true });
    expect(backend.calls).toEqual(["load:text"]);
  });

  test("a load with one chapter over the limit is refused with too-large", () => {
    const backend = fakeBackend();
    const chapters = Array.from({ length: PREVIEW_LIMITS.maxChapters + 1 }, (_, i) => ({ id: `c${i}`, title: "t", snapshot: "s" }));
    const dispatch = dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters }), SELF, allow, backend);
    expect(dispatch).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend.calls).toEqual([]);
  });

  test("a chapter tape at the max length plays; one frame over is refused", () => {
    const atLimit = [{ id: "c0", title: "t", snapshot: "s", tape: new Array<number>(PREVIEW_LIMITS.maxChapterTapeLength).fill(0) }];
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: atLimit }), SELF, allow, backend)).toMatchObject({ ok: true });
    const over = [{ id: "c0", title: "t", snapshot: "s", tape: new Array<number>(PREVIEW_LIMITS.maxChapterTapeLength + 1).fill(0) }];
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: over }), SELF, allow, backend2)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend2.calls).toEqual([]);
  });

  test("a chapter snapshot at the byte limit is accepted; one byte over is refused", () => {
    const atLimit = [{ id: "c0", title: "t", snapshot: "s".repeat(PREVIEW_LIMITS.maxSnapshotBytes) }];
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: atLimit }), SELF, allow, backend)).toMatchObject({ ok: true });
    const over = [{ id: "c0", title: "t", snapshot: "s".repeat(PREVIEW_LIMITS.maxSnapshotBytes + 1) }];
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: over }), SELF, allow, backend2)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend2.calls).toEqual([]);
  });

  test("an object snapshot is measured structurally", () => {
    const big = { a: "s".repeat(PREVIEW_LIMITS.maxSnapshotBytes) };
    const chapters = [{ id: "c0", title: "t", snapshot: big }];
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters }), SELF, allow, backend)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend.calls).toEqual([]);
  });
});

describe("preview requestId validation", () => {
  const allow = previewAllowlist(SELF, "");

  test("a present requestId that is not a non-empty bounded string is refused and never runs", () => {
    const longId = "r".repeat(PREVIEW_LIMITS.maxRequestIdBytes + 1);
    for (const bad of [7, 3.5, true, ["r1"], { toString: () => "r1" }, "", longId]) {
      const backend = fakeBackend();
      const dispatch = dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", requestId: bad, buttons: 1 }, SELF, allow, backend);
      expect(dispatch).toBeNull();
      expect(backend.calls).toEqual([]);
    }
  });

  test("a numeric requestId on a load is refused instead of running as a notification", () => {
    const backend = fakeBackend();
    const dispatch = dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "load", requestId: 7, document: "{}" }, SELF, allow, backend);
    expect(dispatch).toBeNull();
    expect(backend.calls).toEqual([]);
  });

  test("a backend error from a notification is contained, not thrown", () => {
    const backend: PreviewBackend = {
      ...fakeBackend(),
      input: () => { throw new Error("boom"); },
    };
    let threw: unknown;
    let dispatch: unknown;
    try {
      dispatch = dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", buttons: 1 }, SELF, allow, backend);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeUndefined();
    expect(dispatch).toBeNull();
  });

  test("a backend error from a notification never suppresses the next message", () => {
    const backend = fakeBackend();
    backend.input = () => {
      backend.calls.push("input");
      throw new PreviewError("not-loaded", "no project is loaded");
    };
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "input", buttons: 1 }, SELF, allow, backend)).toBeNull();
    expect(dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, backend)).toMatchObject({ ok: true });
    expect(backend.calls).toEqual(["input", "state"]);
  });
});

// Unpaired surrogates survive structured clone, so the wire can carry them.
// The counter must agree with TextEncoder: a high surrogate followed by a
// low is one 4-byte scalar; a lone surrogate is the 3-byte U+FFFD and its
// successor is counted separately.
const encoder = new TextEncoder();
const utf8Len = (s: string): number => encoder.encode(s).length;

/** Mirror of the structural counter with every string measured by
 *  TextEncoder — the independent oracle for the byte budget. */
function structuralUtf8(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") return utf8Len(value);
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 4;
  if (Array.isArray(value)) return 2 + value.reduce((n, el) => n + 2 + structuralUtf8(el), 0);
  if (typeof value === "object") {
    return (
      2 +
      Object.entries(value as Record<string, unknown>).reduce(
        (n, [key, el]) => n + 4 + utf8Len(key) + structuralUtf8(el),
        0,
      )
    );
  }
  return 8;
}

const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);
const HIGHEST_LOW = String.fromCharCode(0xdfff);
const PAIR = String.fromCharCode(0xd83d, 0xde00); // U+1F600
const EDGE_PAIR = String.fromCharCode(0xd800, 0xdc00); // U+10000

const HOSTILE: readonly string[] = [
  LONE_HIGH, // lone high surrogate
  LONE_LOW, // lone low surrogate
  HIGHEST_LOW, // highest low surrogate
  LONE_HIGH + LONE_HIGH, // two lone highs
  LONE_LOW + LONE_HIGH, // lone low, then lone high
  LONE_HIGH + "x", // lone high followed by a non-low code unit
  PAIR, // valid pair (U+1F600)
  EDGE_PAIR, // valid pair at the surrogate range edge (U+10000)
  PAIR + LONE_HIGH, // pair, then a lone high
  "a" + PAIR + "b" + LONE_HIGH + "c", // ASCII, pair, ASCII, lone high, ASCII
  "é" + LONE_HIGH + PAIR, // 2-byte, lone high, pair
];

describe("preview UTF-8 counting", () => {
  const allow = previewAllowlist(SELF, "");

  test("the structural counter matches a TextEncoder-based count for hostile strings", () => {
    for (const s of HOSTILE) {
      expect(previewMessageBytes(s)).toBe(utf8Len(s));
      const nested = { [s]: [s, { s, n: 3 }], ok: true, none: null };
      expect(previewMessageBytes(nested)).toBe(structuralUtf8(nested));
    }
  });

  /** A load message whose document is `unit` repeated plus ASCII padding,
   *  sized so the whole message lands exactly `extra` bytes over the
   *  budget. `unitBytes` is the unit's UTF-8 length. */
  function loadAtBudgetWith(unit: string, unitBytes: number, extra: number) {
    const overhead = structuralUtf8(msg({ type: "load", document: "" }));
    const available = PREVIEW_LIMITS.maxMessageBytes - overhead + extra;
    const repeats = Math.floor(available / unitBytes);
    const pad = available - repeats * unitBytes;
    return msg({ type: "load", document: unit.repeat(repeats) + "x".repeat(pad) });
  }

  test("a whole message padded with lone surrogates to exactly the budget is accepted; one byte over is refused", () => {
    const atLimit = loadAtBudgetWith(LONE_HIGH, 3, 0);
    expect(structuralUtf8(atLimit)).toBe(PREVIEW_LIMITS.maxMessageBytes);
    expect(previewMessageBytes(atLimit)).toBe(PREVIEW_LIMITS.maxMessageBytes);
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(atLimit, SELF, allow, backend)).toMatchObject({ ok: true });
    expect(backend.calls).toEqual(["load:text"]);
    const over = loadAtBudgetWith(LONE_HIGH, 3, 1);
    expect(structuralUtf8(over)).toBe(PREVIEW_LIMITS.maxMessageBytes + 1);
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage(over, SELF, allow, backend2)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend2.calls).toEqual([]);
  });

  test("a whole message padded with valid surrogate pairs to exactly the budget is accepted; one byte over is refused", () => {
    const pair = PAIR;
    const atLimit = loadAtBudgetWith(pair, 4, 0);
    expect(structuralUtf8(atLimit)).toBe(PREVIEW_LIMITS.maxMessageBytes);
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(atLimit, SELF, allow, backend)).toMatchObject({ ok: true });
    const over = loadAtBudgetWith(pair, 4, 1);
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage(over, SELF, allow, backend2)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend2.calls).toEqual([]);
  });

  test("the review's lone-surrogate bypass is refused", () => {
    // 2097112 lone highs: the fix-1 counter measured 4194301 bytes; the
    // strings actually carry 6291336 UTF-8 bytes.
    const document = LONE_HIGH.repeat(2097112);
    const repro = msg({ type: "load", document });
    expect(utf8Len(document)).toBe(6291336);
    expect(previewMessageBytes(repro)).toBe(structuralUtf8(repro));
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(repro, SELF, allow, backend)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend.calls).toEqual([]);
  });

  /** A one-chapter load whose snapshot string is `unit` repeated plus ASCII
   *  padding, sized so the snapshot lands exactly `extra` bytes over the
   *  snapshot budget. */
  function snapshotAtBudgetWith(unit: string, unitBytes: number, extra: number) {
    const available = PREVIEW_LIMITS.maxSnapshotBytes + extra;
    const repeats = Math.floor(available / unitBytes);
    const pad = available - repeats * unitBytes;
    return [{ id: "c0", title: "t", snapshot: unit.repeat(repeats) + "x".repeat(pad) }];
  }

  test("a snapshot string of lone surrogates at exactly the budget is accepted; one byte over is refused", () => {
    const atLimit = snapshotAtBudgetWith(LONE_HIGH, 3, 0);
    expect(utf8Len(atLimit[0].snapshot as string)).toBe(PREVIEW_LIMITS.maxSnapshotBytes);
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: atLimit }), SELF, allow, backend)).toMatchObject({ ok: true });
    const over = snapshotAtBudgetWith(LONE_HIGH, 3, 1);
    expect(utf8Len(over[0].snapshot as string)).toBe(PREVIEW_LIMITS.maxSnapshotBytes + 1);
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: over }), SELF, allow, backend2)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend2.calls).toEqual([]);
  });

  test("a snapshot string of valid surrogate pairs at exactly the budget is accepted; one byte over is refused", () => {
    const atLimit = snapshotAtBudgetWith(PAIR, 4, 0);
    expect(utf8Len(atLimit[0].snapshot as string)).toBe(PREVIEW_LIMITS.maxSnapshotBytes);
    const backend = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: atLimit }), SELF, allow, backend)).toMatchObject({ ok: true });
    const over = snapshotAtBudgetWith(PAIR, 4, 1);
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage(msg({ type: "load", document: "{}", chapters: over }), SELF, allow, backend2)).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(backend2.calls).toEqual([]);
  });

  /** A requestId of `unit` repeated plus ASCII padding, sized so its UTF-8
   *  length lands exactly `extra` bytes over the 128-byte bound. */
  function idAtBudgetWith(unit: string, unitBytes: number, extra: number): string {
    const available = PREVIEW_LIMITS.maxRequestIdBytes + extra;
    const repeats = Math.floor(available / unitBytes);
    const pad = available - repeats * unitBytes;
    return unit.repeat(repeats) + "x".repeat(pad);
  }

  test("a requestId of lone surrogates at exactly 128 UTF-8 bytes is accepted; one byte over is refused", () => {
    const atLimit = idAtBudgetWith(LONE_HIGH, 3, 0);
    expect(utf8Len(atLimit)).toBe(PREVIEW_LIMITS.maxRequestIdBytes);
    const backend = fakeBackend();
    const dispatch = dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "state", requestId: atLimit }, SELF, allow, backend);
    expect(dispatch).toMatchObject({ ok: true, requestId: atLimit });
    expect(backend.calls).toEqual(["state"]);
    const over = idAtBudgetWith(LONE_HIGH, 3, 1);
    expect(utf8Len(over)).toBe(PREVIEW_LIMITS.maxRequestIdBytes + 1);
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "state", requestId: over }, SELF, allow, backend2)).toBeNull();
    expect(backend2.calls).toEqual([]);
  });

  test("a requestId of valid surrogate pairs at exactly 128 UTF-8 bytes is accepted; one byte over is refused", () => {
    const atLimit = idAtBudgetWith(PAIR, 4, 0);
    expect(utf8Len(atLimit)).toBe(PREVIEW_LIMITS.maxRequestIdBytes);
    const backend = fakeBackend();
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "state", requestId: atLimit }, SELF, allow, backend)).toMatchObject({ ok: true });
    const over = idAtBudgetWith(PAIR, 4, 1);
    expect(utf8Len(over)).toBe(PREVIEW_LIMITS.maxRequestIdBytes + 1);
    const backend2 = fakeBackend();
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "state", requestId: over }, SELF, allow, backend2)).toBeNull();
    expect(backend2.calls).toEqual([]);
  });

  test("the review's 64-lone-high requestId (192 UTF-8 bytes) is refused and not echoed", () => {
    const id = LONE_HIGH.repeat(64);
    expect(utf8Len(id)).toBe(192);
    const backend = fakeBackend();
    expect(dispatchPreviewMessage({ protocol: PREVIEW_PROTOCOL, type: "state", requestId: id }, SELF, allow, backend)).toBeNull();
    expect(backend.calls).toEqual([]);
  });

  test("an overlong string is only scanned until the budget is exceeded", () => {
    const limit = PREVIEW_LIMITS.maxMessageBytes;
    const ascii = "x".repeat(64 * 1024 * 1024);
    let pieces = 0;
    let bytes = 0;
    expect(() =>
      walkPreviewBytes(ascii, (n) => {
        pieces++;
        bytes += n;
        if (bytes > limit) throw new PreviewError("too-large", "test");
      }),
    ).toThrow(PreviewError);
    expect(bytes).toBe(limit + 1);
    expect(pieces).toBe(limit + 1);
    // 64 MiB of string, ~4 MiB of work: scanned code units stay within a
    // small constant factor of the budget, not of the string.
    expect(pieces).toBeLessThan(ascii.length / 8);

    const surrogates = LONE_HIGH.repeat(64 * 1024 * 1024);
    pieces = 0;
    bytes = 0;
    expect(() =>
      walkPreviewBytes(surrogates, (n) => {
        pieces++;
        bytes += n;
        if (bytes > limit) throw new PreviewError("too-large", "test");
      }),
    ).toThrow(PreviewError);
    expect(bytes).toBeGreaterThan(limit);
    expect(bytes).toBeLessThanOrEqual(limit + 3);
    expect(pieces).toBeLessThan(surrogates.length / 32);
  });
});

describe("preview state reply compatibility and limits", () => {
  const allow = previewAllowlist(SELF, "");

  /** A backend whose state reply is `result`. */
  function stateBackend(result: PreviewStateResult): PreviewBackend {
    return { ...fakeBackend(), state: () => result };
  }

  test("a state reply in the original v1 shape (no frame/running/event/message) is still a valid result", () => {
    // Typed on purpose: the four newer fields are optional within v1, so the
    // original shape must compile as a PreviewStateResult.
    const original: PreviewStateResult = {
      status: "running",
      map: "yard",
      x: 2,
      y: 2,
      px: 34,
      py: 34,
      dir: "down",
      moving: false,
      switches: {},
      variables: {},
      gold: 0,
      items: {},
    };
    const reply = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, stateBackend(original));
    expect(reply).toMatchObject({ ok: true, result: original });
    expect((reply as { result: PreviewStateResult }).result.message).toBeUndefined();
  });

  /** A state result whose message text pads the whole reply to exactly
   *  `extra` bytes over the budget. */
  function stateReplyWith(extra: number): PreviewStateResult {
    const base: PreviewStateResult = { ...STATE_RESULT, message: { kind: "text", text: "" } };
    const overhead = structuralUtf8({ protocol: PREVIEW_PROTOCOL, type: "reply", requestId: "r1", ok: true, result: base });
    const available = PREVIEW_LIMITS.maxMessageBytes - overhead + extra;
    const repeats = Math.floor(available / 3);
    const text = "☃".repeat(repeats) + "x".repeat(available - repeats * 3);
    return { ...base, message: { kind: "text", text } };
  }

  test("a state reply of exactly the budget is sent; one byte over becomes a bounded too-large error", () => {
    const atLimit = stateReplyWith(0);
    const ok = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, stateBackend(atLimit));
    expect(ok).toMatchObject({ ok: true });
    expect(structuralUtf8(ok)).toBe(PREVIEW_LIMITS.maxMessageBytes);
    const refused = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, stateBackend(stateReplyWith(1)));
    expect(refused).toMatchObject({ ok: false, requestId: "r1", error: { code: "too-large" } });
    expect(structuralUtf8(refused)).toBeLessThan(1024);
  });

  test("the review's 4 MiB dialogue text is refused rather than replied with ok", () => {
    // 4194305 UTF-8 bytes of text alone: the reply would be 4194593 bytes.
    const text = "é".repeat(2097152) + "x";
    expect(utf8Len(text)).toBe(4194305);
    const huge: PreviewStateResult = { ...STATE_RESULT, message: { kind: "text", text } };
    const reply = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, stateBackend(huge));
    expect(reply).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect((reply as { result?: unknown }).result).toBeUndefined();
    expect(structuralUtf8(reply)).toBeLessThanOrEqual(PREVIEW_LIMITS.maxMessageBytes);
  });
});

describe("every preview reply leaves through the same byte budget", () => {
  const allow = previewAllowlist(SELF, "");

  /** A backend whose `state` throws `error`. */
  function throwingBackend(error: unknown): PreviewBackend {
    return {
      ...fakeBackend(),
      state: () => {
        throw error;
      },
    };
  }

  /** A backend-error message that pads the whole error reply to exactly
   *  `extra` bytes over the budget. */
  function errorMessageWith(extra: number): string {
    const overhead = structuralUtf8({
      protocol: PREVIEW_PROTOCOL,
      type: "reply",
      requestId: "r1",
      ok: false,
      error: { code: "bad-start", message: "" },
    });
    return "x".repeat(PREVIEW_LIMITS.maxMessageBytes - overhead + extra);
  }

  test("the review's bad-version request of exactly the budget gets a short, truncated echo", () => {
    // A request measured at exactly 4 MiB whose whole size is an invalid
    // protocol value: the parser used to quote all of it back (4194425 bytes).
    const base = { protocol: "", type: "state", requestId: "r1" };
    const protocol = "p".repeat(PREVIEW_LIMITS.maxMessageBytes - structuralUtf8(base));
    const request = { ...base, protocol };
    expect(previewMessageBytes(request)).toBe(PREVIEW_LIMITS.maxMessageBytes);
    const reply = dispatchPreviewMessage(request, SELF, allow, fakeBackend());
    expect(reply).toMatchObject({ ok: false, requestId: "r1", error: { code: "bad-version" } });
    const message = (reply as { error: { message: string } }).error.message;
    expect(message).toContain(`"${"p".repeat(PREVIEW_ECHO_LIMIT)}"... (truncated, ${protocol.length} chars)`);
    expect(message).toContain(`expected "${PREVIEW_PROTOCOL}"`);
    expect(structuralUtf8(reply)).toBeLessThan(1024);
  });

  test("echoes in parse errors are bounded for every value kind", () => {
    expect(echoPreviewValue("rpgkit-preview/v0")).toBe('"rpgkit-preview/v0"');
    expect(echoPreviewValue("a".repeat(PREVIEW_ECHO_LIMIT))).toBe(JSON.stringify("a".repeat(PREVIEW_ECHO_LIMIT)));
    expect(echoPreviewValue("a".repeat(PREVIEW_ECHO_LIMIT + 1))).toBe(
      `${JSON.stringify("a".repeat(PREVIEW_ECHO_LIMIT))}... (truncated, ${PREVIEW_ECHO_LIMIT + 1} chars)`,
    );
    // The cut never splits a surrogate pair.
    const emoji = "a".repeat(PREVIEW_ECHO_LIMIT - 1) + "😀".repeat(4);
    expect(echoPreviewValue(emoji)).toStartWith(JSON.stringify("a".repeat(PREVIEW_ECHO_LIMIT - 1)) + "...");
    expect(echoPreviewValue(undefined)).toBe("null");
    expect(echoPreviewValue(2)).toBe("2");
    expect(echoPreviewValue({ huge: "x".repeat(100_000) })).toBe("an object");
    expect(echoPreviewValue(["x".repeat(100_000)])).toBe("an array");
    const unknownType = dispatchPreviewMessage(msg({ type: "t".repeat(1_000_000) }), SELF, allow, fakeBackend());
    expect(unknownType).toMatchObject({ ok: false, error: { code: "bad-message" } });
    expect(structuralUtf8(unknownType)).toBeLessThan(1024);
  });

  test("the review's 4 MiB backend error message becomes a bounded too-large error", () => {
    const backend = throwingBackend(new PreviewError("bad-start", "x".repeat(PREVIEW_LIMITS.maxMessageBytes)));
    const reply = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, backend);
    expect(reply).toMatchObject({ ok: false, requestId: "r1", error: { code: "too-large" } });
    expect(structuralUtf8(reply)).toBeLessThan(1024);
  });

  test("a backend error reply of exactly the budget is sent; one byte over becomes too-large", () => {
    const atLimit = dispatchPreviewMessage(
      msg({ type: "state" }),
      SELF,
      allow,
      throwingBackend(new PreviewError("bad-start", errorMessageWith(0))),
    );
    expect(atLimit).toMatchObject({ ok: false, requestId: "r1", error: { code: "bad-start" } });
    expect(structuralUtf8(atLimit)).toBe(PREVIEW_LIMITS.maxMessageBytes);
    const over = dispatchPreviewMessage(
      msg({ type: "state" }),
      SELF,
      allow,
      throwingBackend(new PreviewError("bad-start", errorMessageWith(1))),
    );
    expect(over).toMatchObject({ ok: false, requestId: "r1", error: { code: "too-large" } });
    expect(structuralUtf8(over)).toBeLessThan(1024);
  });

  test("a non-PreviewError backend failure is measured the same way", () => {
    const huge = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, throwingBackend(new Error("e".repeat(5_000_000))));
    expect(huge).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(structuralUtf8(huge)).toBeLessThan(1024);
    const small = dispatchPreviewMessage(msg({ type: "state" }), SELF, allow, throwingBackend(new Error("boom")));
    expect(small).toMatchObject({ ok: false, error: { code: "internal", message: "boom" } });
  });

  test("a notification never replies, even when its backend error is enormous", () => {
    const backend: PreviewBackend = {
      ...fakeBackend(),
      stop: () => {
        throw new PreviewError("internal", "x".repeat(PREVIEW_LIMITS.maxMessageBytes * 2));
      },
    };
    const notice = { protocol: PREVIEW_PROTOCOL, type: "stop" };
    expect(dispatchPreviewMessage(notice, SELF, allow, backend)).toBeNull();
  });
});

// ---- project art -----------------------------------------------------------------

/** One `art` request for `bytes` at `offset` of a width x height image. */
function artMsg(fields: { kind?: string; id?: string; width?: number; height?: number; offset?: number; bytes?: Uint8Array; rgba?: unknown }) {
  const { bytes, ...rest } = fields;
  return msg({
    type: "art",
    kind: "sheet",
    id: "town",
    width: 2,
    height: 1,
    offset: 0,
    ...(bytes ? { rgba: encodePreviewBase64(bytes) } : {}),
    ...rest,
  });
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof PreviewError ? error.code : "thrown";
  }
  return undefined;
}

const pixels = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

describe("preview art base64", () => {
  test("round-trips every tail length and matches the platform encoder", () => {
    for (let n = 0; n < 12; n++) {
      const bytes = pixels(n, n);
      const text = encodePreviewBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64"));
      expect(decodePreviewBase64(text)).toEqual(bytes);
    }
    const big = pixels(100_003);
    expect(encodePreviewBase64(big, 7, 50_000)).toBe(Buffer.from(big.subarray(7, 50_000)).toString("base64"));
  });

  test("decoding is strict: padding, alphabet and length", () => {
    for (const bad of ["A", "AB=", "AB=C", "A===", "=AAA", "AA-_", "AA\nA", "QUJD RA==", "QQ=", "Q\u00e9==", "QUJ=QUJD"]) {
      expect(decodePreviewBase64(bad)).toBeNull();
    }
    expect(decodePreviewBase64("")).toEqual(new Uint8Array(0));
  });
});

describe("preview art parsing", () => {
  test("an art request parses into its decoded slice; it needs a requestId", () => {
    const parsed = parsePreviewMessage(artMsg({ bytes: pixels(8) }));
    expect(parsed.type).toBe("art");
    expect(parsed.slice).toEqual({ kind: "sheet", id: "town", width: 2, height: 1, offset: 0, bytes: pixels(8) });
    const { requestId: _id, ...noId } = artMsg({ bytes: pixels(8) });
    expect(() => parsePreviewMessage(noId)).toThrow(/art needs a requestId/);
  });

  test("load takes an optional boolean art flag", () => {
    expect(parsePreviewMessage(msg({ type: "load", document: "{}" })).useArt).toBe(false);
    expect(parsePreviewMessage(msg({ type: "load", document: "{}", art: true })).useArt).toBe(true);
    expect(parsePreviewMessage(msg({ type: "load", document: "{}", art: false })).useArt).toBe(false);
    expect(codeOf(() => parsePreviewMessage(msg({ type: "load", document: "{}", art: "yes" })))).toBe("bad-message");
  });

  test("shape problems are bad-message", () => {
    const bad = (fields: Parameters<typeof artMsg>[0]) => codeOf(() => parsePreviewMessage(artMsg(fields)));
    expect(bad({ kind: "tile", bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ id: "", bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ id: "x".repeat(PREVIEW_LIMITS.maxArtIdBytes + 1), bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ width: 0, bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ height: 1.5, bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ offset: -4, bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ offset: 8, bytes: pixels(8) })).toBe("bad-message");
    expect(bad({ rgba: 42 })).toBe("bad-message");
    expect(bad({ rgba: "" })).toBe("bad-message");
  });

  test("bad base64 is refused with bad-message", () => {
    expect(() => parsePreviewMessage(artMsg({ rgba: "not base64!" }))).toThrow(/not valid base64/);
    expect(codeOf(() => parsePreviewMessage(artMsg({ rgba: "QUJD" + "=" })))).toBe("bad-message");
  });

  test("a slice that runs past the image is refused with bad-message", () => {
    expect(() => parsePreviewMessage(artMsg({ bytes: pixels(9) }))).toThrow(/overflows the 8-byte image/);
    expect(() => parsePreviewMessage(artMsg({ offset: 4, bytes: pixels(5) }))).toThrow(/overflows/);
    expect(parsePreviewMessage(artMsg({ offset: 4, bytes: pixels(4) })).slice?.offset).toBe(4);
  });

  test("an image over the side or byte limits is refused with too-large", () => {
    const side = PREVIEW_LIMITS.maxArtSide;
    expect(codeOf(() => parsePreviewMessage(artMsg({ width: side + 1, bytes: pixels(4) })))).toBe("too-large");
    expect(codeOf(() => parsePreviewMessage(artMsg({ height: side + 1, bytes: pixels(4) })))).toBe("too-large");
    // 4096 x 4096 x 4 is 64 MiB, over the 32 MiB staging budget.
    expect(codeOf(() => parsePreviewMessage(artMsg({ width: side, height: side, bytes: pixels(4) })))).toBe("too-large");
    expect(parsePreviewMessage(artMsg({ width: side, height: 2048, bytes: pixels(4) })).slice?.width).toBe(side);
  });

  test("a full-size slice fits in one message", () => {
    const bytes = pixels(PREVIEW_ART_SLICE_BYTES);
    const message = artMsg({ width: 1024, height: 1024, bytes });
    expect(previewMessageBytes(message)).toBeLessThan(PREVIEW_LIMITS.maxMessageBytes);
    expect(parsePreviewMessage(message).slice?.bytes.length).toBe(PREVIEW_ART_SLICE_BYTES);
  });

  test("dispatch runs art on the backend and replies with its result; load passes the art flag", () => {
    const backend = fakeBackend();
    const allow = previewAllowlist(SELF, "");
    const reply = dispatchPreviewMessage(artMsg({ bytes: pixels(4) }), SELF, allow, backend);
    expect(reply).toEqual({ protocol: PREVIEW_PROTOCOL, type: "reply", requestId: "r1", ok: true, result: { received: 4, complete: false, staged: 1 } });
    dispatchPreviewMessage(msg({ type: "load", document: "{}", art: true }), SELF, allow, backend);
    dispatchPreviewMessage(msg({ type: "load", document: "{}" }), SELF, allow, backend);
    expect(backend.calls).toEqual(["art:sheet:town:0:4", "load:text:art", "load:text"]);
    const bad = dispatchPreviewMessage(artMsg({ rgba: "%%%%" }), SELF, allow, backend);
    expect(bad).toMatchObject({ requestId: "r1", ok: false, error: { code: "bad-message" } });
    expect(backend.calls).toHaveLength(3);
  });
});

describe("preview art staging", () => {
  const slice = (id: string, width: number, height: number, offset: number, bytes: Uint8Array, kind: "sheet" | "sprite" = "sheet") =>
    ({ kind, id, width, height, offset, bytes });

  test("slices fill an image in order; take() returns only complete images and empties the stage", () => {
    const stage = new PreviewArtStage();
    const full = pixels(16);
    expect(stage.add(slice("a", 2, 2, 0, full.subarray(0, 6)))).toEqual({ received: 6, complete: false, staged: 1 });
    expect(stage.add(slice("a", 2, 2, 6, full.subarray(6)))).toEqual({ received: 16, complete: true, staged: 1 });
    stage.add(slice("b", 2, 2, 0, full.subarray(0, 4)));
    stage.add(slice("a", 1, 1, 0, pixels(4), "sprite"));
    expect(stage.size).toBe(3);
    expect(stage.reserved).toBe(16 + 16 + 4);
    const taken = stage.take();
    expect(taken.map((image) => `${image.kind}:${image.id}`)).toEqual(["sheet:a", "sprite:a"]);
    expect(taken[0]!.rgba).toEqual(full);
    expect(stage.size).toBe(0);
    expect(stage.reserved).toBe(0);
    expect(stage.take()).toEqual([]);
  });

  test("a slice at the wrong offset, a different size or without a first slice is bad-message", () => {
    const stage = new PreviewArtStage();
    expect(codeOf(() => stage.add(slice("a", 2, 2, 4, pixels(4))))).toBe("bad-message");
    stage.add(slice("a", 2, 2, 0, pixels(4)));
    expect(() => stage.add(slice("a", 2, 2, 8, pixels(4)))).toThrow(/next slice at offset 4, not 8/);
    expect(() => stage.add(slice("a", 4, 1, 4, pixels(4)))).toThrow(/started at 2x2/);
    // A refused slice leaves the image where it was.
    expect(stage.add(slice("a", 2, 2, 4, pixels(12)))).toMatchObject({ received: 16, complete: true });
  });

  test("offset 0 starts an image afresh, releasing its old bytes", () => {
    const stage = new PreviewArtStage();
    stage.add(slice("a", 2, 2, 0, pixels(16)));
    expect(stage.add(slice("a", 1, 1, 0, pixels(2)))).toEqual({ received: 2, complete: false, staged: 1 });
    expect(stage.reserved).toBe(4);
    expect(stage.take()).toEqual([]);
  });

  test("more than maxArtImages images is too-large; clear() frees them", () => {
    const stage = new PreviewArtStage();
    for (let i = 0; i < PREVIEW_LIMITS.maxArtImages; i++) stage.add(slice(`s${i}`, 1, 1, 0, pixels(4)));
    expect(codeOf(() => stage.add(slice("one-more", 1, 1, 0, pixels(4))))).toBe("too-large");
    // Restarting an image already staged is not a new image.
    expect(stage.add(slice("s0", 1, 1, 0, pixels(4))).staged).toBe(PREVIEW_LIMITS.maxArtImages);
    stage.clear();
    expect(stage.add(slice("one-more", 1, 1, 0, pixels(4))).staged).toBe(1);
  });

  test("more than maxArtBytes staged is too-large", () => {
    const stage = new PreviewArtStage();
    const quarter = PREVIEW_LIMITS.maxArtBytes / 4; // 2048 x 1024 x 4
    for (let i = 0; i < 4; i++) stage.add(slice(`big${i}`, 2048, 1024, 0, pixels(4)));
    expect(stage.reserved).toBe(4 * quarter);
    expect(() => stage.add(slice("tiny", 1, 1, 0, pixels(4)))).toThrow(/at most 33554432 are staged/);
    // Replacing a staged image counts only the difference.
    expect(stage.add(slice("big0", 1024, 1024, 0, pixels(4))).staged).toBe(4);
    expect(stage.add(slice("tiny", 1, 1, 0, pixels(4))).staged).toBe(5);
  });
});
