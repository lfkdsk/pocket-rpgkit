import { PAL_W } from "./layout.ts";

export type ProposalPanelAction =
  | { kind: "focus-agent-input" }
  | { kind: "run-agent" }
  | { kind: "cancel-agent" }
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

export type ProposalPanelMode = "queue" | "compose" | "detail";

export interface ProposalPanelLayout {
  panel: ProposalRect;
  listClip: ProposalRect;
  footer: ProposalRect;
  agent: null | {
    heading: ProposalRect;
    input: ProposalRect;
    action: ProposalRect;
    status: ProposalRect;
    proposalHeading: ProposalRect;
  };
}

export const PROPOSAL_ROW_H = 30;
export const PROPOSAL_LIST_TOP = 28;
export const PROPOSAL_HUNK_TOP = 88;
export const PROPOSAL_HUNK_H = 26;
export const AGENT_PROPOSAL_TOP = 116;

function clippedRect(rect: ProposalRect, panel: ProposalRect): ProposalRect {
  const x = Math.min(panel.x + panel.w, Math.max(panel.x, rect.x));
  const y = Math.min(panel.y + panel.h, Math.max(panel.y, rect.y));
  const right = Math.min(panel.x + panel.w, rect.x + Math.max(0, rect.w));
  const bottom = Math.min(panel.y + panel.h, rect.y + Math.max(0, rect.h));
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** Shared responsive geometry for proposal rendering and pointer routing.
 * The compose controls stay fixed at readable sizes while the proposal list
 * absorbs the available height. Every returned region is clipped to the live
 * panel, so a small host can never expose an invisible click target. */
export function createProposalPanelLayout(panelHeight: number, mode: ProposalPanelMode): ProposalPanelLayout {
  const panelH = Math.max(0, Math.floor(panelHeight));
  const panel = { x: 0, y: 0, w: PAL_W, h: panelH };
  const footer = clippedRect({ x: 5, y: panelH - 25, w: PAL_W - 10, h: 22 }, panel);
  const listTop = mode === "detail"
    ? PROPOSAL_HUNK_TOP
    : mode === "compose"
      ? AGENT_PROPOSAL_TOP
      : PROPOSAL_LIST_TOP;
  const listBottom = mode === "detail"
    ? panelH - 76
    : mode === "compose"
      ? footer.y - 1
      : panelH - 28;
  const listClip = clippedRect({
    x: 4,
    y: listTop,
    w: PAL_W - 8,
    h: Math.max(0, listBottom - listTop),
  }, panel);
  const agent = mode === "compose" ? {
    heading: clippedRect({ x: 5, y: 4, w: PAL_W - 10, h: 12 }, panel),
    input: clippedRect({ x: 4, y: 20, w: PAL_W - 8, h: 36 }, panel),
    action: clippedRect({ x: 4, y: 60, w: PAL_W - 8, h: 20 }, panel),
    status: clippedRect({ x: 5, y: 84, w: PAL_W - 10, h: 20 }, panel),
    proposalHeading: clippedRect({ x: 5, y: 104, w: PAL_W - 10, h: 10 }, panel),
  } : null;
  return { panel, listClip, footer, agent };
}

export function proposalVisibleRows(panelH: number, detail: boolean, compose = false): number {
  const mode: ProposalPanelMode = detail ? "detail" : compose ? "compose" : "queue";
  const height = detail ? PROPOSAL_HUNK_H : PROPOSAL_ROW_H;
  return Math.max(0, Math.floor(createProposalPanelLayout(panelH, mode).listClip.h / height));
}

export function proposalRowRect(index: number, detail: boolean, compose = false): ProposalRect {
  const top = detail ? PROPOSAL_HUNK_TOP : compose ? AGENT_PROPOSAL_TOP : PROPOSAL_LIST_TOP;
  const height = detail ? PROPOSAL_HUNK_H : PROPOSAL_ROW_H;
  return { x: 4, y: top + index * height, w: PAL_W - 8, h: height - 2 };
}

export function proposalActionRects(panelH: number): { action: ProposalPanelAction; rect: ProposalRect }[] {
  const panel = createProposalPanelLayout(panelH, "detail").panel;
  const actions: { action: ProposalPanelAction; rect: ProposalRect }[] = [
    { action: { kind: "back" }, rect: { x: 4, y: 3, w: 46, h: 18 } },
    { action: { kind: "accept" }, rect: { x: 4, y: panelH - 72, w: 64, h: 20 } },
    { action: { kind: "reject" }, rect: { x: 72, y: panelH - 72, w: 64, h: 20 } },
    { action: { kind: "accept-all" }, rect: { x: 4, y: panelH - 49, w: 132, h: 20 } },
  ];
  return actions.map((item) => ({ ...item, rect: clippedRect(item.rect, panel) }));
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
  compose = false,
  agentRunning = false,
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
  if (compose) {
    const agent = createProposalPanelLayout(panelH, "compose").agent!;
    if (inside(x, y, agent.input)) return { kind: "focus-agent-input" };
    if (inside(x, y, agent.action)) return { kind: agentRunning ? "cancel-agent" : "run-agent" };
  }
  const visible = proposalVisibleRows(panelH, false, compose);
  for (let row = 0; row < visible; row++) {
    const index = scroll + row;
    if (index < proposalCount && inside(x, y, proposalRowRect(row, false, compose))) {
      return { kind: "select-proposal", index };
    }
  }
  return null;
}
