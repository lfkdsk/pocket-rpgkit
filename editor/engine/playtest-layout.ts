// Pure geometry for the playtest chrome/debugger. Pointer routing lives in
// editor/app.tsx, while the renderer and sim tests consume these same rects.

export type PlaytestTab = "switch" | "variable" | "self" | "item" | "gold" | "run";
export const PLAYTEST_TABS: readonly PlaytestTab[] = ["switch", "variable", "self", "item", "gold", "run"];

export interface PlaytestRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PlaytestHit =
  | { kind: "stop" }
  | { kind: "debug" }
  | { kind: "tab"; tab: PlaytestTab }
  | { kind: "row"; row: number; delta: -1 | 1 }
  | { kind: "page"; delta: -1 | 1 };

export const PLAYTEST_BAR_H = 22;
export const PLAYTEST_ROW_H = 21;
export const PLAYTEST_PANEL_W = 252;

export function playtestStopRect(): PlaytestRect {
  return { x: 4, y: 3, w: 48, h: 16 };
}

export function playtestDebugRect(): PlaytestRect {
  return { x: 56, y: 3, w: 54, h: 16 };
}

export function playtestPanelRect(width: number, height: number, warning: boolean): PlaytestRect {
  const y = PLAYTEST_BAR_H + (warning ? 20 : 0);
  return { x: Math.max(0, width - PLAYTEST_PANEL_W), y, w: Math.min(width, PLAYTEST_PANEL_W), h: Math.max(0, height - y) };
}

export function playtestRowsPerPage(panel: PlaytestRect): number {
  return Math.max(1, Math.floor((panel.h - 54) / PLAYTEST_ROW_H));
}

export function playtestTabRects(panel: PlaytestRect): { tab: PlaytestTab; rect: PlaytestRect }[] {
  const w = Math.floor(panel.w / PLAYTEST_TABS.length);
  return PLAYTEST_TABS.map((tab, index) => ({
    tab,
    rect: { x: panel.x + index * w, y: panel.y + 22, w: index === PLAYTEST_TABS.length - 1 ? panel.w - index * w : w, h: 18 },
  }));
}

export function playtestRowRect(panel: PlaytestRect, row: number): PlaytestRect {
  return { x: panel.x + 4, y: panel.y + 43 + row * PLAYTEST_ROW_H, w: panel.w - 8, h: 19 };
}

function inside(x: number, y: number, rect: PlaytestRect): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export function hitTestPlaytest(
  x: number,
  y: number,
  width: number,
  height: number,
  debugOpen: boolean,
  warning: boolean,
): PlaytestHit | null {
  if (inside(x, y, playtestStopRect())) return { kind: "stop" };
  if (inside(x, y, playtestDebugRect())) return { kind: "debug" };
  if (!debugOpen) return null;
  const panel = playtestPanelRect(width, height, warning);
  for (const tab of playtestTabRects(panel)) {
    if (inside(x, y, tab.rect)) return { kind: "tab", tab: tab.tab };
  }
  for (let row = 0; row < playtestRowsPerPage(panel); row++) {
    const rect = playtestRowRect(panel, row);
    if (!inside(x, y, rect)) continue;
    if (x < rect.x + rect.w - 70) return null;
    return { kind: "row", row, delta: x < rect.x + rect.w - 38 ? -1 : 1 };
  }
  const footerY = panel.y + panel.h - 11;
  if (y >= footerY && y < panel.y + panel.h) {
    if (x >= panel.x + 4 && x < panel.x + 44) return { kind: "page", delta: -1 };
    if (x >= panel.x + panel.w - 44 && x < panel.x + panel.w - 4) return { kind: "page", delta: 1 };
  }
  return null;
}
