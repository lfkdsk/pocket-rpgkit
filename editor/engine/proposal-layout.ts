import { PAL_W } from "./layout.ts";

export type ProposalPanelAction =
  | { kind: "select-proposal"; index: number }
  | { kind: "back" }
  | { kind: "select-hunk"; index: number }
  | { kind: "accept" }
  | { kind: "reject" }
  | { kind: "accept-all" };

export interface ProposalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PROPOSAL_ROW_H = 30;
export const PROPOSAL_LIST_TOP = 28;
export const PROPOSAL_HUNK_TOP = 88;
export const PROPOSAL_HUNK_H = 22;

export function proposalVisibleRows(panelH: number, detail: boolean): number {
  const top = detail ? PROPOSAL_HUNK_TOP : PROPOSAL_LIST_TOP;
  const bottom = detail ? 58 : 4;
  const height = detail ? PROPOSAL_HUNK_H : PROPOSAL_ROW_H;
  return Math.max(1, Math.floor((panelH - top - bottom) / height));
}

export function proposalRowRect(index: number, detail: boolean): ProposalRect {
  const top = detail ? PROPOSAL_HUNK_TOP : PROPOSAL_LIST_TOP;
  const height = detail ? PROPOSAL_HUNK_H : PROPOSAL_ROW_H;
  return { x: 4, y: top + index * height, w: PAL_W - 8, h: height - 2 };
}

export function proposalActionRects(panelH: number): { action: ProposalPanelAction; rect: ProposalRect }[] {
  return [
    { action: { kind: "back" }, rect: { x: 4, y: 3, w: 42, h: 18 } },
    { action: { kind: "accept" }, rect: { x: 4, y: panelH - 49, w: 42, h: 20 } },
    { action: { kind: "reject" }, rect: { x: 49, y: panelH - 49, w: 42, h: 20 } },
    { action: { kind: "accept-all" }, rect: { x: 94, y: panelH - 49, w: 42, h: 20 } },
  ];
}

function inside(x: number, y: number, rect: ProposalRect): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export function hitProposalPanel(
  x: number,
  y: number,
  panelH: number,
  proposalCount: number,
  hunkCount: number,
  detail: boolean,
  scroll: number,
): ProposalPanelAction | null {
  if (x < 0 || x >= PAL_W || y < 0 || y >= panelH) return null;
  if (detail) {
    for (const item of proposalActionRects(panelH)) if (inside(x, y, item.rect)) return item.action;
    const visible = proposalVisibleRows(panelH, true);
    for (let row = 0; row < visible; row++) {
      const index = scroll + row;
      if (index < hunkCount && inside(x, y, proposalRowRect(row, true))) {
        return { kind: "select-hunk", index };
      }
    }
    return null;
  }
  const visible = proposalVisibleRows(panelH, false);
  for (let row = 0; row < visible; row++) {
    const index = scroll + row;
    if (index < proposalCount && inside(x, y, proposalRowRect(row, false))) {
      return { kind: "select-proposal", index };
    }
  }
  return null;
}
