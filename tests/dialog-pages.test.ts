// tests/dialog-pages.test.ts — a message longer than the dialog box
// continues on further pages instead of being cut (src/ui/dialog-pages.ts,
// TextModal.pageStarts in src/engine/interpreter.ts). Headless: the pages
// are cut with the build-time font measurer, the same advances the core
// bakes (tests/cjk-font.test.ts proves the parity), so a long player name
// substituted into a pre-wrapped page gives the same pages here as on a
// device. The rendered boxes are tests/cjk-text-sim.test.ts.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ATTRACT_TYPEWRITER_CPS, AttractController, attractReadHoldSeconds } from "../src/engine/attract.ts";
import { deepClone } from "../src/engine/clone.ts";
import { createInterpState, textModalPage, type TextModal } from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { canSave, createSnapshot } from "../src/engine/save.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../src/engine/session.ts";
import { scalarLength, sliceScalars } from "../src/engine/text-break.ts";
import type { Project } from "../src/engine/types.ts";
import {
  createDialogPaginator,
  dialogRowWidth,
  messagePage,
  messagePageStarts,
  pageRevealed,
} from "../src/ui/dialog-pages.ts";
import { flowRows, revealRows } from "../src/ui/text-flow.ts";
import { createFontMeasure } from "../tools/lib/font-measure.ts";
import { PAGES } from "./fixtures/cjk-text/fixture-data.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "cjk-text");
const measure = createFontMeasure({ px: 12, fallbacks: [join(FIXTURE, "fonts", "NotoSansCJKsc-subset.otf")] });
/** The 480 px box's row width: 480 - 36 px of chrome. */
const ROW_W = 444;
const BTN_CIRCLE = 0x2000;
const BTN_LTRIGGER = 0x0100;

/** A 24-character name (the save format's cap) made of characters the
 *  fixture subset has. */
const LONG_NAME = "海边灯塔守护人的好朋友和帕帕镇训练师们的老朋友小";
/** The fixture's pre-wrapped four-row page with the name twice in its
 *  last line: with the default name it fits one box, with LONG_NAME it
 *  needs a second. */
const NAME_PAGE = [...PAGES[3]!.slice(0, 3), "有一天，{name}终于下定了决心，要坐上港口那艘白色的小帆船！{name}说：我们出发吧！"];

function project(playerName?: string): Project {
  return {
    format: "rpgkit-project/v1",
    title: "dialog pages",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    ...(playerName ? { playerName } : {}),
    maps: [{
      id: "m",
      name: "m",
      width: 4,
      height: 4,
      sheets: ["plain"],
      ground: new Array(16).fill("plain.0"),
      events: [{
        id: "talk",
        x: 2,
        y: 2,
        pages: [
          {
            trigger: "autorun",
            commands: [
              { op: "text", lines: [...NAME_PAGE] },
              { op: "text", lines: ["{name}！"] },
              { op: "switch", id: "done", value: true },
            ],
          },
          { condition: { switch: "done" }, trigger: "action", commands: [] },
        ],
      }],
    }],
  };
}

const paginate = createDialogPaginator({}, measure);
const substituted = NAME_PAGE.map((line) => line.split("{name}").join(LONG_NAME));

function textModal(state: SessionState): TextModal | null {
  const m = state.interp.modal;
  return m?.kind === "text" ? m : null;
}

function step(session: Session, state: SessionState, confirm = false): SessionState {
  return stepSession(session, state, { buttons: confirm ? BTN_CIRCLE : 0, confirmEdge: confirm });
}

describe("pages of a message", () => {
  test("a long player name pushes a pre-wrapped page onto a second page", () => {
    // With the default name the page reflows into four rows: one page.
    expect(messagePageStarts(NAME_PAGE.map((l) => l.split("{name}").join("Player")), { viewportWidth: 480 }, measure)).toBeNull();
    const starts = messagePageStarts(substituted, { viewportWidth: 480 }, measure)!;
    expect(starts).not.toBeNull();
    expect(starts[0]).toBe(0);
    expect(starts.length).toBe(2);
    // Each page fits the box; together they are the message, in order,
    // with nothing added (no ellipsis) and nothing dropped.
    const source = substituted.join("\n");
    let drawn = "";
    for (let page = 0; page < starts.length; page++) {
      const rows = flowRows(messagePage(substituted, 0, starts, page), ROW_W, 4, measure).rows;
      expect(rows.length).toBeLessThanOrEqual(4);
      for (const row of rows) {
        expect(measure(row.text)).toBeLessThanOrEqual(ROW_W);
        expect(row.text).not.toContain("…");
        drawn += row.text;
      }
    }
    expect(drawn).toBe(source.replace(/\n/g, ""));
    // The page break sits at a row start of the whole message.
    const end = sliceScalars(source, starts[1]!);
    expect(end.length).toBeGreaterThan(0);
  });

  test("a message that fits one box gets no page state", () => {
    for (const lines of PAGES) expect(messagePageStarts(lines, { viewportWidth: 480 }, measure)).toBeNull();
  });

  test("a speaker prefix counts in the offsets but not in the rows", () => {
    const faces = { KEEPER: "face.png" };
    const lines = [`KEEPER: ${substituted[0]}`, ...substituted.slice(1)];
    const starts = messagePageStarts(lines, { viewportWidth: 480, faces }, measure)!;
    expect(starts.length).toBeGreaterThan(1);
    const cut = "KEEPER: ".length;
    const shown = [substituted[0]!, ...substituted.slice(1)];
    expect(messagePage(shown, cut, starts, 0)[0]!.startsWith(substituted[0]!.slice(0, 4))).toBe(true);
    // Typing has reached the start of page 2: nothing of it shows yet.
    expect(pageRevealed(starts[1]!, cut, starts, 1)).toBe(0);
    // Each later page begins exactly at a row the box lays out (four rows a
    // page), and the pages together hold every character once.
    const rows = flowRows(shown, dialogRowWidth({ viewportWidth: 480, faces }, true), 4, measure).rows;
    for (let page = 1; page < starts.length; page++) {
      expect(messagePage(shown, cut, starts, page)[0]!.startsWith(rows[page * 4]!.text)).toBe(true);
    }
    const all = starts.map((_, page) => messagePage(shown, cut, starts, page).join("")).join("");
    expect(all.replace(/ /g, "")).toBe(shown.join("").replace(/ /g, ""));
    // The portrait narrows the column: at least as many pages as without.
    const plain = messagePageStarts(substituted, { viewportWidth: 480 }, measure)!;
    expect(starts.length).toBeGreaterThanOrEqual(plain.length);
  });
});

describe("the interpreter turns pages", () => {
  test("each page types from its start and takes one confirm; the last closes", () => {
    const p = project(LONG_NAME);
    const session = createSession(p, 60, { paginateText: paginate });
    let state = startSession(p, session);
    for (let i = 0; i < 2 && !textModal(state); i++) state = step(session, state);
    const opened = textModal(state)!;
    expect(opened.lines).toEqual(substituted);
    expect(opened.pageStarts).toEqual(paginate(substituted)!);
    expect(opened.page).toBe(0);
    const starts = opened.pageStarts!;
    const pageText = (page: number) => messagePage(opened.lines, 0, starts, page).join("\n");
    for (let page = 0; page < starts.length; page++) {
      let m = textModal(state)!;
      expect(m.page).toBe(page);
      const { start, end } = textModalPage(m);
      expect(m.revealed).toBe(start);
      // Type a few frames: the box shows a prefix of this page only.
      for (let i = 0; i < 6; i++) state = step(session, state);
      m = textModal(state)!;
      const shown = pageRevealed(m.revealed, 0, starts, page);
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(end - start);
      const flow = flowRows(messagePage(m.lines, 0, starts, page), ROW_W, 4, measure);
      expect(revealRows(flow, shown).join("")).toBe(sliceScalars(pageText(page).replace(/\n/g, ""), shown));
      // First confirm completes the page, the second turns it.
      state = step(session, state, true);
      expect(textModal(state)!.complete).toBe(true);
      expect(textModal(state)!.revealed).toBe(end);
      state = step(session, state);
      state = step(session, state, true);
      if (page + 1 < starts.length) {
        // The turn restarts the typewriter: the new page shows nothing on
        // the turn frame and only a few characters a few frames later.
        const turned = textModal(state)!;
        expect(turned.revealed).toBe(starts[page + 1]!);
        expect(turned.complete).toBe(false);
        let later = state;
        for (let i = 0; i < 3; i++) later = step(session, later);
        const typed = textModal(later)!.revealed - starts[page + 1]!;
        expect(typed).toBeGreaterThan(0);
        expect(typed).toBeLessThan(5);
      }
    }
    // The last confirm closed the long box; the next text opened.
    expect(textModal(state)?.lines ?? textModal(step(session, state))?.lines).toEqual([`${LONG_NAME}！`]);
  });

  test("without a paginator a message is one page, as before", () => {
    const p = project(LONG_NAME);
    const session = createSession(p, 60);
    let state = startSession(p, session);
    for (let i = 0; i < 2 && !textModal(state); i++) state = step(session, state);
    const m = textModal(state)!;
    expect(m.pageStarts).toBeUndefined();
    expect(m.page).toBeUndefined();
    expect(Object.keys(m).sort()).toEqual(["complete", "fiber", "kind", "lines", "revealed", "total"]);
    state = step(session, state, true);
    state = step(session, state);
    state = step(session, state, true);
    state = step(session, state);
    expect(textModal(state)?.lines).toEqual([`${LONG_NAME}！`]);
  });

  test("60/30/20 Hz: the same virtual-time tape turns the same pages", () => {
    // Confirm every 0.4 s of virtual time and sample the state at that
    // instant. A host frame delivers its edge on its first 60 Hz tick, so
    // the press goes in the frame that starts right after the sample.
    const run = (hz: 60 | 30 | 20) => {
      const p = project(LONG_NAME);
      const session = createSession(p, hz, { paginateText: paginate });
      let state = startSession(p, session);
      const samples: unknown[] = [];
      const every = (hz * 2) / 5;
      for (let frame = 1; frame <= hz * 8; frame++) {
        state = step(session, state, frame > 1 && (frame - 1) % every === 0);
        if (frame % every === 0) {
          const m = state.interp.modal as TextModal | null;
          samples.push(m ? { page: m.page ?? 0, revealed: m.revealed, complete: m.complete, lines: m.lines } : null);
        }
      }
      return { samples, done: state.sw.switches["done"] === true };
    };
    const at60 = run(60);
    expect(at60.done).toBe(true);
    expect(at60.samples.filter((s) => (s as { page?: number } | null)?.page === 1).length).toBeGreaterThan(0);
    expect(run(30)).toEqual(at60);
    expect(run(20)).toEqual(at60);
  });

  test("a snapshot taken on page 2 replays to the same states", () => {
    const p = project(LONG_NAME);
    const session = createSession(p, 60, { paginateText: paginate });
    let state = startSession(p, session);
    for (let i = 0; i < 2 && !textModal(state); i++) state = step(session, state);
    state = step(session, state, true); // complete page 1
    state = step(session, state);
    state = step(session, state, true); // turn to page 2
    for (let i = 0; i < 3; i++) state = step(session, state);
    expect(textModal(state)!.page).toBe(1);
    // An open box is never a save point; the in-memory snapshot (rewind
    // keyframes) carries the pages with it.
    expect(canSave(state.move, state.interp)).toBe(false);
    const snapshot = deepClone(state);
    const tape = [false, false, true, false, true, false, false, true, false];
    const replay = (from: SessionState) => tape.map((press) => (from = step(session, from, press)));
    expect(replay(snapshot)).toEqual(replay(state));
  });

  test("rewind inside page 2 restores the replayed state", () => {
    const p = project(LONG_NAME);
    const masks: number[] = [];
    // Hold confirm for one frame every 20 frames.
    for (let frame = 0; frame < 240; frame++) masks.push(frame % 20 === 10 ? BTN_CIRCLE : 0);
    const make = () => {
      const c = new AttractController(p, [], {
        hz: 60,
        attractEnabled: false,
        rewindSeconds: 0.5,
        idleFrames: 1_000_000,
        paginateText: paginate,
      });
      c.startPlay();
      return c;
    };
    const live = make();
    let k = 0;
    // Run until page 2 has been typing for a while.
    for (; k < masks.length; k++) {
      live.step(masks[k]!);
      const m = textModal(live.state);
      if (m?.page === 1 && !m.complete && m.revealed > m.pageStarts![1]! + 5) break;
    }
    expect(textModal(live.state)?.page).toBe(1);
    const logged = live.inputLog.length;
    live.step(BTN_LTRIGGER);
    expect(live.inputLog.length).toBe(logged - 30);
    const fresh = make();
    for (const mask of live.inputLog) fresh.step(mask);
    expect(live.state).toEqual(fresh.state);
    // Both continue identically to the end of the dialog.
    for (let i = 0; i < 120; i++) {
      const mask = i % 20 === 10 ? BTN_CIRCLE : 0;
      live.step(mask);
      fresh.step(mask);
    }
    expect(live.state).toEqual(fresh.state);
    expect(live.state.sw.switches["done"]).toBe(true);
  });

  test("the page offsets count code points (a supplementary character is one)", () => {
    const lines = ["\u{20BB7}".repeat(150)];
    const starts = messagePageStarts(lines, { viewportWidth: 480 }, measure)!;
    expect(starts.length).toBeGreaterThan(1);
    expect(starts.at(-1)!).toBeLessThan(scalarLength(lines[0]!));
  });

  test("attract mode types and holds each page by its own length", () => {
    // A 60 Hz tape that confirms every half second.
    const tape: number[] = [];
    for (let frame = 0; frame < 1200; frame++) tape.push(frame % 30 === 29 ? BTN_CIRCLE : 0);
    const c = new AttractController(project(LONG_NAME), tape, { hz: 60, tapeHz: 60, paginateText: paginate });
    c.startAttract();
    let turnSeen = false;
    let lastPage = -1;
    let maxHold = 0;
    let pageLength = 0;
    let total = 0;
    for (let i = 0; i < 6000 && c.state.sw.switches["done"] !== true; i++) {
      c.step(0);
      const shown = c.presentedModal();
      if (shown?.kind !== "text" || !shown.pageStarts) {
        lastPage = -1;
        continue;
      }
      const { start, end } = textModalPage(shown);
      expect(shown.revealed).toBeGreaterThanOrEqual(start);
      expect(shown.revealed).toBeLessThanOrEqual(end);
      const page = shown.page ?? 0;
      if (page === 1) {
        if (lastPage === 0) {
          // The turn frame shows nothing of the new page yet.
          expect(shown.revealed).toBe(start);
          turnSeen = true;
        }
        pageLength = end - start;
        total = shown.total;
        maxHold = Math.max(maxHold, c.status().readHold);
      }
      lastPage = page;
    }
    expect(c.state.sw.switches["done"]).toBe(true);
    expect(turnSeen).toBe(true);
    // The reading hold after page 2 is sized by page 2, not by the message.
    const pageHold = Math.ceil(attractReadHoldSeconds(pageLength) * 60);
    const wholeHold = Math.ceil(attractReadHoldSeconds(total) * 60);
    expect(pageHold).toBeLessThan(wholeHold - 2);
    expect(maxHold).toBeGreaterThanOrEqual(pageHold - 1);
    expect(maxHold).toBeLessThanOrEqual(pageHold);
    expect(ATTRACT_TYPEWRITER_CPS).toBeGreaterThan(0);
  });
});

describe("page state in snapshots", () => {
  const FIBER = "map/p";
  const snapshotWith = (modal: unknown) => {
    const snapshot = createSnapshot("map", initialMovement(1, 2, 0, { tile: 16, speed: 2 }), createInterpState(), 0);
    snapshot.interp.parallels[FIBER] = {
      key: FIBER, pageIndex: 0, parallel: true, stack: [{ prog: [], pc: 0 }], mode: "run", since: 0, erase: false,
    } as never;
    snapshot.interp.modal = modal as never;
    return snapshot;
  };
  const text = (extra: Record<string, unknown>) =>
    ({ kind: "text", fiber: FIBER, lines: ["a"], total: 10, revealed: 6, complete: false, ...extra });
  const OPEN = "state.interp.modal: a save cannot hold an open modal";

  test("well-formed page state passes the modal checks", () => {
    // A save never holds an open box; reaching that rule proves the
    // modal itself was structurally valid.
    expect(validateSnapshot(snapshotWith(text({})))).toBe(OPEN);
    expect(validateSnapshot(snapshotWith(text({ pageStarts: [0, 5], page: 1 })))).toBe(OPEN);
    expect(validateSnapshot(snapshotWith(text({ pageStarts: [0, 4, 8], page: 0, revealed: 2 })))).toBe(OPEN);
  });

  test("malformed page state is refused", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["descending", { pageStarts: [0, 5, 3], page: 0 }],
      ["not from 0", { pageStarts: [1, 5], page: 0 }],
      ["one page", { pageStarts: [0], page: 0 }],
      ["past total", { pageStarts: [0, 11], page: 0 }],
      ["page out of range", { pageStarts: [0, 5], page: 2 }],
      ["page without starts", { page: 1 }],
      ["starts without page", { pageStarts: [0, 5] }],
    ];
    for (const [name, extra] of bad) {
      const error = validateSnapshot(snapshotWith(text(extra)));
      expect({ name, refused: error?.startsWith("state.interp.modal.page") ?? false }).toEqual({ name, refused: true });
    }
  });
});
