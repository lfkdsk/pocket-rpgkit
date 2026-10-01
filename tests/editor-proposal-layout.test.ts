import { describe, expect, test } from "bun:test";
import {
  createProposalPanelLayout,
  hitProposalPanel,
  proposalActionRects,
  proposalRowRect,
  proposalVisibleRows,
  type ProposalRect,
} from "../editor/engine/proposal-layout.ts";
import { HEADER_H, STATUS_H } from "../editor/engine/layout.ts";

const PROFILES = [
  { width: 400, height: 240, composeRows: 2, detailRows: 1 },
  { width: 480, height: 272, composeRows: 3, detailRows: 2 },
  { width: 720, height: 480, composeRows: 10, detailRows: 10 },
] as const;

function panelHeight(height: number): number {
  return height - HEADER_H - STATUS_H;
}

function contains(outer: ProposalRect, inner: ProposalRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

function overlaps(a: ProposalRect, b: ProposalRect): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

function center(rect: ProposalRect): { x: number; y: number } {
  return { x: rect.x + Math.floor(rect.w / 2), y: rect.y + Math.floor(rect.h / 2) };
}

describe("responsive proposal panel layout", () => {
  for (const profile of PROFILES) {
    test(`keeps compose controls, rows, and footer separate at ${profile.width}×${profile.height}`, () => {
      const height = panelHeight(profile.height);
      const layout = createProposalPanelLayout(height, "compose");
      const agent = layout.agent!;
      const controls = [agent.heading, agent.input, agent.action, agent.status, agent.proposalHeading];

      for (const control of controls) expect(contains(layout.panel, control)).toBe(true);
      for (let index = 1; index < controls.length; index++) {
        expect(overlaps(controls[index - 1]!, controls[index]!)).toBe(false);
      }
      expect(proposalVisibleRows(height, false, true)).toBe(profile.composeRows);
      expect(overlaps(layout.listClip, layout.footer)).toBe(false);

      for (let row = 0; row < profile.composeRows; row++) {
        const rect = proposalRowRect(row, false, true);
        expect(contains(layout.listClip, rect)).toBe(true);
        expect(overlaps(rect, layout.footer)).toBe(false);
      }

      const inputPoint = center(agent.input);
      expect(hitProposalPanel(inputPoint.x, inputPoint.y, height, 20, 0, false, 0, true, false))
        .toEqual({ kind: "focus-agent-input" });
      const actionPoint = center(agent.action);
      expect(hitProposalPanel(actionPoint.x, actionPoint.y, height, 20, 0, false, 0, true, false))
        .toEqual({ kind: "run-agent" });
      expect(hitProposalPanel(actionPoint.x, actionPoint.y, height, 20, 0, false, 0, true, true))
        .toEqual({ kind: "cancel-agent" });
      const lastRow = center(proposalRowRect(profile.composeRows - 1, false, true));
      expect(hitProposalPanel(lastRow.x, lastRow.y, height, 20, 0, false, 0, true, false))
        .toEqual({ kind: "select-proposal", index: profile.composeRows - 1 });
      const footerPoint = center(layout.footer);
      expect(hitProposalPanel(footerPoint.x, footerPoint.y, height, 20, 0, false, 0, true, false)).toBeNull();
    });
  }

  for (const profile of PROFILES) {
    test(`keeps detail rows above review actions at ${profile.width}×${profile.height}`, () => {
      const height = panelHeight(profile.height);
      const layout = createProposalPanelLayout(height, "detail");
      const actions = proposalActionRects(height);
      expect(proposalVisibleRows(height, true)).toBe(profile.detailRows);

      for (let row = 0; row < profile.detailRows; row++) {
        const rect = proposalRowRect(row, true);
        expect(contains(layout.listClip, rect)).toBe(true);
        for (const action of actions.slice(1)) expect(overlaps(rect, action.rect)).toBe(false);
        expect(overlaps(rect, layout.footer)).toBe(false);
      }
      for (const action of actions) expect(contains(layout.panel, action.rect)).toBe(true);
    });
  }

  test("clips pointer regions when a transient host resize makes the panel shorter", () => {
    const height = 70;
    const layout = createProposalPanelLayout(height, "compose");
    const agent = layout.agent!;
    expect(agent.action.h).toBe(10);
    expect(agent.status.h).toBe(0);
    expect(agent.proposalHeading.h).toBe(0);
    expect(proposalVisibleRows(height, false, true)).toBe(0);
    expect(hitProposalPanel(10, 69, height, 1, 0, false, 0, true, false)).toEqual({ kind: "run-agent" });
    expect(hitProposalPanel(10, 70, height, 1, 0, false, 0, true, false)).toBeNull();
  });

  test("never overlaps a compose row with the footer at intermediate heights", () => {
    for (let height = panelHeight(240); height <= panelHeight(480); height++) {
      const layout = createProposalPanelLayout(height, "compose");
      const visible = proposalVisibleRows(height, false, true);
      for (let row = 0; row < visible; row++) {
        const rect = proposalRowRect(row, false, true);
        expect(contains(layout.listClip, rect)).toBe(true);
        expect(overlaps(rect, layout.footer)).toBe(false);
      }
    }
  });
});
