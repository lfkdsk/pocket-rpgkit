// Pure geometry for the large-project map picker. Keeping the window
// calculation outside Solid makes the node bound easy to test and lets
// pointer and gamepad navigation share the same scroll rules.

export const MAP_LIST_HEADER_H = 28;
export const MAP_LIST_ROW_H = 22;
export const MAP_LIST_PAD = 6;
export const MAP_LIST_OVERSCAN = 2;

export interface MapListWindow {
  first: number;
  end: number;
  maxScroll: number;
}

export function mapListWindow(
  count: number,
  viewportHeight: number,
  scrollY: number,
  overscan = MAP_LIST_OVERSCAN,
): MapListWindow {
  const rowsHeight = Math.max(0, viewportHeight - MAP_LIST_HEADER_H - MAP_LIST_PAD);
  const maxScroll = Math.max(0, count * MAP_LIST_ROW_H - rowsHeight);
  const scroll = Math.max(0, Math.min(maxScroll, scrollY));
  const firstVisible = Math.floor(scroll / MAP_LIST_ROW_H);
  const visibleRows = Math.max(1, Math.ceil(rowsHeight / MAP_LIST_ROW_H));
  return {
    first: Math.max(0, firstVisible - overscan),
    end: Math.min(count, firstVisible + visibleRows + overscan),
    maxScroll,
  };
}

/** Return a catalog index for a panel-local pointer coordinate. */
export function hitMapListRow(
  y: number,
  count: number,
  viewportHeight: number,
  scrollY: number,
): number | null {
  const rowsHeight = Math.max(0, viewportHeight - MAP_LIST_HEADER_H - MAP_LIST_PAD);
  const local = y - MAP_LIST_HEADER_H;
  if (local < 0 || local >= rowsHeight) return null;
  const maxScroll = Math.max(0, count * MAP_LIST_ROW_H - rowsHeight);
  const scroll = Math.max(0, Math.min(maxScroll, scrollY));
  const index = Math.floor((local + scroll) / MAP_LIST_ROW_H);
  return index >= 0 && index < count ? index : null;
}

/** Smallest scroll offset that keeps one row visible. */
export function revealMapListRow(
  index: number,
  count: number,
  viewportHeight: number,
  scrollY: number,
): number {
  const rowsHeight = Math.max(0, viewportHeight - MAP_LIST_HEADER_H - MAP_LIST_PAD);
  const maxScroll = Math.max(0, count * MAP_LIST_ROW_H - rowsHeight);
  const top = index * MAP_LIST_ROW_H;
  const bottom = top + MAP_LIST_ROW_H;
  let next = Math.max(0, Math.min(maxScroll, scrollY));
  if (top < next) next = top;
  else if (bottom > next + rowsHeight) next = bottom - rowsHeight;
  return Math.max(0, Math.min(maxScroll, next));
}
