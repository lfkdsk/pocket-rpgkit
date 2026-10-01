// Pure map-inspector regressions. These tests deliberately exercise only
// layout and presentation helpers: no PocketJS host, renderer, or app state.

import { describe, expect, test } from "bun:test";
import {
  createMapInspectorLayout,
  formatMapInspectorReference,
  hitTestMapInspector,
  mapInspectorActionKey,
  mapInspectorDeletePrompt,
  mapInspectorReferenceHeading,
  visibleMapReferenceRange,
  wrapMapInspectorNotice,
  type MapInspectorLayout,
} from "../editor/engine/map-layout.ts";
import { HEADER_H, STATUS_H } from "../editor/engine/layout.ts";

function center(rect: { x: number; y: number; w: number; h: number }): [number, number] {
  return [rect.x + Math.floor(rect.w / 2), rect.y + Math.floor(rect.h / 2)];
}

function expectInside(layout: MapInspectorLayout, rect: { x: number; y: number; w: number; h: number }): void {
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.w).toBeGreaterThan(0);
  expect(rect.h).toBeGreaterThan(0);
  expect(rect.x + rect.w).toBeLessThanOrEqual(layout.width);
  expect(rect.y + rect.h).toBeLessThanOrEqual(layout.height);
}

for (const [screenWidth, screenHeight] of [[480, 272], [720, 480]] as const) {
  describe(`map inspector visibility at ${screenWidth}x${screenHeight}`, () => {
    const layout = createMapInspectorLayout({
      width: screenWidth,
      height: screenHeight - HEADER_H - STATUS_H,
      referenceCount: 23,
      referencePage: 0,
      showNotice: true,
    });

    test("keeps fields, actions, references, pager, and persistent notice on-screen", () => {
      expect(layout.referencePageSize).toBeGreaterThan(0);
      expect(layout.referencePageCount).toBeGreaterThan(1);
      expect(layout.referenceRows).toHaveLength(layout.referencePageSize);
      expectInside(layout, layout.refsClip);
      expectInside(layout, layout.noticeClip);
      expect(layout.refsClip.y + layout.refsClip.h).toBeLessThanOrEqual(layout.noticeClip.y);

      for (const control of [layout.close, ...layout.fields, ...layout.actions, ...layout.referencePager]) {
        expectInside(layout, control.rect);
        const [x, y] = center(control.rect);
        expect(hitTestMapInspector(layout, x, y)).toEqual(control.action);
      }
      for (const row of layout.referenceRows) expectInside(layout, row);
    });

    test("makes reference paging a distinct pointer action", () => {
      const next = layout.referencePager.find((control) =>
        control.action.kind === "reference-page" && control.action.delta === 1
      );
      expect(next).toBeDefined();
      expect(mapInspectorActionKey(next!.action)).toBe("reference-page:1");
    });

    test("fits a complete wrapped crop/undo notice when no reference panel competes for space", () => {
      const notice = "RESIZED; CROPPED 4 EVENT(S): north-gate, south-gate, inn-door, long-secret-passage — UNDO RESTORES";
      const noticeLayout = createMapInspectorLayout({
        width: screenWidth,
        height: screenHeight - HEADER_H - STATUS_H,
        showNotice: true,
      });
      const lines = wrapMapInspectorNotice(notice, noticeLayout.noticeClip.w);
      expect(noticeLayout.noticeClip.h).toBeGreaterThanOrEqual(3 + lines.length * 12);
    });
  });
}

describe("map inspector complete reference paging", () => {
  test("every reference appears on exactly one page and the page is clamped", () => {
    const referenceCount = 23;
    const first = createMapInspectorLayout({
      width: 480,
      height: 272 - HEADER_H - STATUS_H,
      referenceCount,
      referencePage: -99,
      showNotice: true,
    });
    expect(first.referencePage).toBe(0);

    const seen: number[] = [];
    for (let page = 0; page < first.referencePageCount; page++) {
      const layout = createMapInspectorLayout({
        width: 480,
        height: 272 - HEADER_H - STATUS_H,
        referenceCount,
        referencePage: page,
        showNotice: true,
      });
      const range = visibleMapReferenceRange(layout);
      for (let index = range.start; index < range.end; index++) seen.push(index);
    }
    expect(seen).toEqual(Array.from({ length: referenceCount }, (_, index) => index));

    const last = createMapInspectorLayout({
      width: 480,
      height: 272 - HEADER_H - STATUS_H,
      referenceCount,
      referencePage: 999,
      showNotice: true,
    });
    expect(last.referencePage).toBe(last.referencePageCount - 1);
    expect(visibleMapReferenceRange(last).end).toBe(referenceCount);
  });

  test("names common/map sources and distinguishes recursive command locations", () => {
    expect(formatMapInspectorReference({
      mapId: "(common)",
      eventId: "autosave",
      page: 0,
      command: "c1:option:0#2",
    })).toBe("COMMON autosave / CMD c1:option:0#2");
    expect(formatMapInspectorReference({
      mapId: "town",
      eventId: "door",
      page: 1,
      command: "i0:then#3",
    })).toBe("MAP town / EVENT door / PAGE 2 / CMD i0:then#3");
  });

  test("states the total and the destructive second-click consequence", () => {
    expect(mapInspectorReferenceHeading(23)).toBe("DELETE BLOCKED — 23 REFERENCES");
    expect(mapInspectorDeletePrompt()).toBe("DEL AGAIN TO DELETE MAP — UNDO RESTORES");
  });
});

describe("map inspector persistent notices", () => {
  test("wraps the complete save/crop notice instead of ellipsizing it", () => {
    const notice = "RESIZED; CROPPED 4 EVENT(S): north-gate, south-gate, inn-door, long-secret-passage — UNDO RESTORES";
    const lines = wrapMapInspectorNotice(notice, 220);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ").replace(/\s+/g, " ")).toBe(notice);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });
});
