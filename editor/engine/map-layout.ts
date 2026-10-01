// editor/engine/map-layout.ts — pure geometry and presentation helpers for
// the map inspector. The renderer and pointer path consume the same layout,
// so every visible paging control has one explicit hit target.

import type { InspectorControl, InspectorRect } from "./event-layout.ts";

export type MapField = "id" | "name" | "width" | "height" | "sheets";
export type MapAction = "new" | "dup" | "del";

export type MapInspectorAction =
  | { kind: "close" }
  | { kind: "field"; field: MapField }
  | { kind: "action"; action: MapAction }
  | { kind: "reference-page"; delta: -1 | 1 };

/** Presentation shape produced by the reference scanner. `command` is a
 * stable recursive address (for example `root#3` or `i0:then#2`), not merely
 * an ordinal within the flattened UI. */
export interface MapInspectorReference {
  mapId: string;
  eventId: string;
  /** Zero-based page, retained for parity with the editor model. */
  page: number;
  command: string;
}

export interface MapInspectorLayout {
  width: number;
  height: number;
  close: InspectorControl<MapInspectorAction>;
  fields: InspectorControl<MapInspectorAction>[];
  actions: InspectorControl<MapInspectorAction>[];
  /** Full clipped panel for delete references; zero-height when empty. */
  refsClip: InspectorRect;
  /** Absolute rectangles for the visible reference strings. */
  referenceRows: InspectorRect[];
  referencePager: InspectorControl<MapInspectorAction>[];
  referenceCount: number;
  referencePage: number;
  referencePageCount: number;
  referencePageSize: number;
  /** Persistent status/error panel; zero-height when there is no notice. */
  noticeClip: InspectorRect;
  /** Front-to-back pointer regions. */
  hitRegions: InspectorControl<MapInspectorAction>[];
}

export interface MapInspectorOptions {
  width: number;
  height: number;
  /** Backward-compatible source for callers that already hold the lines. */
  references?: readonly unknown[];
  /** Count can be passed without allocating/formatting the reference list. */
  referenceCount?: number;
  referencePage?: number;
  /** Reserve a visible persistent notice panel below the reference list. */
  showNotice?: boolean;
}

const PAD = 4;
const CONTROL_H = 20;
const ROW_GAP = 3;
const FIELD_LABEL_W = 64;
const HEADER_H = 24;
const FIELD_TOP = 30;
const REF_LINE_H = 12;
const REF_HEADER_H = 28;
const PAGER_H = 18;
const NOTICE_MIN_H = 42;

function rect(x: number, y: number, w: number, h: number): InspectorRect {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function control<A extends MapInspectorAction>(label: string, r: InspectorRect, action: A): InspectorControl<A> {
  return { label, rect: r, action };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** `MapReference.mapId/eventId/page` was sufficient to find an event page,
 * but not to distinguish two transfer commands in that page. The UI accepts
 * the minimal strengthened shape with a stable recursive command address. */
export function formatMapInspectorReference(reference: string | MapInspectorReference): string {
  if (typeof reference === "string") return reference;
  const source = reference.mapId === "(common)"
    ? `COMMON ${reference.eventId}`
    : `MAP ${reference.mapId} / EVENT ${reference.eventId} / PAGE ${reference.page + 1}`;
  return `${source} / CMD ${reference.command}`;
}

export function mapInspectorReferenceHeading(total: number): string {
  return `DELETE BLOCKED — ${Math.max(0, Math.floor(total))} REFERENCES`;
}

export function mapInspectorDeletePrompt(): string {
  return "DEL AGAIN TO DELETE MAP — UNDO RESTORES";
}

/** Deterministic word wrapping used by the persistent error/status panel.
 * It never ellipsizes or discards words; an overlong token is kept intact and
 * clipped only by the renderer's ordinary viewport boundary. */
export function wrapMapInspectorNotice(value: string, width: number): string[] {
  const text = value.trim();
  if (text.length === 0) return [];
  const max = Math.max(4, Math.floor((Math.max(0, width) - 8) / 6));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= max) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Geometry for the map inspector. The five fields use three compact rows at
 * both supported profiles, leaving enough vertical room for a reference page
 * and a persistent error/confirmation message even at 480x272. */
export function createMapInspectorLayout(options: MapInspectorOptions): MapInspectorLayout {
  const width = Math.max(320, Math.floor(options.width));
  const height = Math.max(160, Math.floor(options.height));
  const hitRegions: InspectorControl<MapInspectorAction>[] = [];

  const close = control("BACK", rect(PAD, 3, 48, 18), { kind: "close" });
  hitRegions.push(close);

  const fieldW = Math.min(width - PAD * 2, 712);
  const columnGap = 4;
  const columnW = Math.floor((fieldW - columnGap) / 2);
  const fullW = columnW * 2 + columnGap;
  const fieldSpecs: readonly [MapField, string, number, number, number][] = [
    ["id", "ID", 0, 0, columnW],
    ["name", "NAME", 1, 0, columnW],
    ["width", "WIDTH", 0, 1, columnW],
    ["height", "HEIGHT", 1, 1, columnW],
    ["sheets", "SHEETS", 0, 2, fullW],
  ];
  const fields: InspectorControl<MapInspectorAction>[] = fieldSpecs.map(([field, label, column, row, w]) => {
    const c = control(
      label,
      rect(PAD + column * (columnW + columnGap), FIELD_TOP + row * (CONTROL_H + ROW_GAP), w, CONTROL_H),
      { kind: "field", field } as const,
    );
    hitRegions.push(c);
    return c;
  });

  const actionsY = FIELD_TOP + 3 * (CONTROL_H + ROW_GAP) + 4;
  const actionSpecs: readonly [MapAction, string][] = [
    ["new", "NEW"],
    ["dup", "DUP"],
    ["del", "DEL"],
  ];
  const actions: InspectorControl<MapInspectorAction>[] = actionSpecs.map(([action, label], index) => {
    const c = control(
      label,
      rect(PAD + index * 68, actionsY, 60, CONTROL_H),
      { kind: "action", action } as const,
    );
    hitRegions.push(c);
    return c;
  });

  const contentTop = actionsY + CONTROL_H + 6;
  const contentBottom = height - PAD;
  const contentH = Math.max(0, contentBottom - contentTop);
  const referenceCount = Math.max(0, Math.floor(options.referenceCount ?? options.references?.length ?? 0));
  const showNotice = options.showNotice === true;

  // With references present the notice gets a compact but readable footer;
  // without them it owns the whole remaining body, so long save/crop errors
  // wrap instead of being reduced to a single ellipsized status line.
  const noticeH = showNotice
    ? referenceCount > 0
      ? Math.min(Math.max(0, contentH - 48), NOTICE_MIN_H)
      : contentH
    : 0;
  const noticeY = showNotice ? contentBottom - noticeH : contentBottom;
  const noticeClip = rect(PAD, noticeY, fullW, noticeH);
  const refsBottom = showNotice ? Math.max(contentTop, noticeY - ROW_GAP) : contentBottom;
  const refsClip = rect(PAD, contentTop, fullW, referenceCount > 0 ? refsBottom - contentTop : 0);

  const rowSpaceWithoutPager = Math.max(0, refsClip.h - REF_HEADER_H);
  const sizeWithoutPager = Math.max(1, Math.floor(rowSpaceWithoutPager / REF_LINE_H));
  const needsPager = referenceCount > sizeWithoutPager;
  const rowSpace = Math.max(0, rowSpaceWithoutPager - (needsPager ? PAGER_H + ROW_GAP : 0));
  const referencePageSize = referenceCount > 0 ? Math.max(1, Math.floor(rowSpace / REF_LINE_H)) : 0;
  const referencePageCount = referenceCount > 0 ? Math.ceil(referenceCount / referencePageSize) : 0;
  const requestedPage = Math.floor(options.referencePage ?? 0);
  const referencePage = referencePageCount > 0 ? clamp(requestedPage, 0, referencePageCount - 1) : 0;
  const rangeStart = referencePage * referencePageSize;
  const rangeEnd = Math.min(referenceCount, rangeStart + referencePageSize);
  const referenceRows = Array.from({ length: Math.max(0, rangeEnd - rangeStart) }, (_, index) =>
    rect(PAD, refsClip.y + REF_HEADER_H + index * REF_LINE_H, fullW, REF_LINE_H)
  );

  const referencePager: InspectorControl<MapInspectorAction>[] = [];
  if (referencePageCount > 1) {
    const pagerY = refsClip.y + refsClip.h - PAGER_H;
    if (referencePage > 0) {
      const prev = control("PREV", rect(PAD, pagerY, 48, PAGER_H), { kind: "reference-page", delta: -1 });
      referencePager.push(prev);
      hitRegions.push(prev);
    }
    if (referencePage + 1 < referencePageCount) {
      const next = control("NEXT", rect(PAD + 52, pagerY, 48, PAGER_H), { kind: "reference-page", delta: 1 });
      referencePager.push(next);
      hitRegions.push(next);
    }
  }

  return {
    width,
    height,
    close,
    fields,
    actions,
    refsClip,
    referenceRows,
    referencePager,
    referenceCount,
    referencePage,
    referencePageCount,
    referencePageSize,
    noticeClip,
    hitRegions,
  };
}

export function visibleMapReferenceRange(layout: MapInspectorLayout): { start: number; end: number } {
  const start = layout.referencePage * layout.referencePageSize;
  return { start, end: Math.min(layout.referenceCount, start + layout.referenceRows.length) };
}

function inside(x: number, y: number, r: InspectorRect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Raw-pointer hit test against the front-to-back region list. */
export function hitTestMapInspector(
  layout: MapInspectorLayout,
  x: number,
  y: number,
): MapInspectorAction | null {
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return null;
  for (let i = layout.hitRegions.length - 1; i >= 0; i--) {
    const region = layout.hitRegions[i]!;
    if (inside(x, y, region.rect)) return region.action;
  }
  return null;
}

export function mapInspectorActionKey(action: MapInspectorAction | null): string {
  if (!action) return "";
  if (action.kind === "close") return "close";
  if (action.kind === "field") return `field:${action.field}`;
  if (action.kind === "reference-page") return `reference-page:${action.delta}`;
  return `action:${action.action}`;
}

export { FIELD_LABEL_W, HEADER_H as MAP_INSPECTOR_HEADER_H };
