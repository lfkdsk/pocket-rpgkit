/// <reference lib="dom" />
// editor/studio/agent-panel.ts — the Agent panel, docked beside the canvas:
// a request box, Send / Cancel, a status line, and the proposals the local
// agent answered with, each with its changes, how they fit the open document
// and Accept / Reject. The state lives in AgentReview (agent-model.ts); this
// file only renders it. The agent itself runs in the host.

import { LOCAL_AGENT_MAX_PROMPT } from "../agent/types.ts";
import type { AgentReview, HunkReview, ProposalReview } from "./agent-model.ts";
import { h, icon, iconButton, MOD, replace } from "./dom.ts";

export interface AgentPanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

const STATUS_TEXT: Record<AgentReview["status"], string> = {
  idle: "Ready",
  running: "Working…",
  done: "Done",
  error: "Error",
  cancelled: "Cancelled",
};

const HUNK_STATE_TEXT: Record<HunkReview["state"], string> = {
  clean: "clean",
  "already-applied": "already applied",
  "partially-applied": "partly applied",
  conflict: "conflict",
};

const PROPOSAL_STATUS_TEXT: Record<ProposalReview["status"], string> = {
  pending: "pending",
  "partly-accepted": "partly accepted",
  accepted: "accepted",
};

/** Changes listed per hunk before "+N more". */
const MAX_CHANGES_SHOWN = 6;

/** `onLayout` runs after the panel opens or closes (the canvas changes width). */
export function mountAgentPanel(root: HTMLElement, review: AgentReview, onLayout: () => void): AgentPanel {
  let isOpen = false;

  const header = h("div", { class: "agent-header" });
  const prompt = h("textarea", {
    id: "studio-agent-prompt",
    class: "agent-prompt",
    rows: 4,
    maxLength: LOCAL_AGENT_MAX_PROMPT,
    placeholder: "Describe what to change, e.g. \"Add a villager by the well who greets the player\"",
    "aria-label": "Request for the agent",
    oninput: () => {
      review.draft = prompt.value;
      renderActions();
    },
    onkeydown: (event: KeyboardEvent) => {
      // Keep Studio's own shortcuts (Ctrl+Enter plays) out of the text box.
      event.stopPropagation();
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void review.send();
      }
    },
  });
  const actions = h("div", { class: "agent-actions" });
  const status = h("p", { class: "agent-status", id: "studio-agent-status", "aria-live": "polite" });
  const list = h("ul", { class: "agent-proposals", id: "studio-agent-proposals" });
  const hint = h("p", { class: "agent-hint" }, "The agent proposes changes; nothing reaches the document until you accept it. Each accepted proposal is one undo step.");
  replace(root, header, h("div", { class: "agent-compose" }, prompt, actions), status, list, hint);

  const renderHeader = () => {
    replace(header,
      h("span", { class: "panel-title" }, icon("agent"), " Agent"),
      h("span", { class: `agent-run ${review.status}`, id: "studio-agent-run" }, STATUS_TEXT[review.status]),
      h("div", { class: "spacer" }),
      iconButton("close", "Close the agent panel", () => panel.close(), { id: "studio-agent-close" }));
  };

  const renderActions = () => {
    const ready = review.availability();
    const running = review.status === "running";
    const length = review.draft.trim().length;
    prompt.disabled = !ready.available && !running;
    replace(actions,
      h("span", { class: "muted agent-count" }, `${review.draft.length} / ${LOCAL_AGENT_MAX_PROMPT}`),
      h("div", { class: "spacer" }),
      running
        ? h("button", { type: "button", class: "text-button", id: "studio-agent-cancel", onclick: () => review.cancel() }, "Cancel")
        : h("button", {
            type: "button",
            class: "primary-button",
            id: "studio-agent-send",
            disabled: !ready.available || length === 0,
            title: !ready.available ? ready.reason : length === 0 ? "Type a request first" : `Send the request with the open document (${MOD}+Enter)`,
            onclick: () => void review.send(),
          }, icon("agent"), " Send"));
  };

  const renderStatus = () => {
    const ready = review.availability();
    const text = review.message || (ready.available ? "Ask for a change to the open document." : ready.reason);
    status.className = `agent-status ${review.status}${ready.available ? "" : " unavailable"}`;
    status.dataset.status = review.status;
    replace(status, review.status === "error" || !ready.available ? icon("warn") : null, h("span", null, text));
  };

  const renderHunk = (hunk: HunkReview) => {
    const label = hunk.decision ?? HUNK_STATE_TEXT[hunk.state];
    const shown = hunk.changes.slice(0, MAX_CHANGES_SHOWN);
    return h("li", { class: "agent-hunk", dataset: { hunkId: hunk.id, state: hunk.state, decision: hunk.decision ?? "" } },
      h("div", { class: "agent-hunk-head" },
        h("span", { class: "agent-hunk-summary" }, hunk.summary),
        h("span", { class: `agent-badge ${hunk.decision ?? hunk.state}`, title: hunk.conflicts.length ? `Changed since the proposal: ${hunk.conflicts.join(", ")}` : undefined }, label)),
      h("ul", { class: "agent-changes" },
        shown.map((change) => h("li", { class: "agent-change", title: `${change.path}: ${change.before} → ${change.after}` },
          h("code", { class: "agent-path" }, change.path),
          h("span", { class: "agent-before" }, change.before),
          h("span", { class: "muted" }, " → "),
          h("span", { class: "agent-after" }, change.after))),
        hunk.changes.length > shown.length ? h("li", { class: "agent-change muted" }, `+${hunk.changes.length - shown.length} more`) : null));
  };

  const renderProposal = (item: ProposalReview) => {
    const done = item.status === "accepted";
    const note = item.problem ?? (done ? null : item.blocked);
    return h("li", { class: `agent-proposal ${item.status}`, dataset: { proposalId: item.id, status: item.status } },
      h("div", { class: "agent-proposal-head" },
        h("span", { class: "agent-proposal-title" }, item.title),
        h("span", { class: `agent-badge ${item.status}` }, PROPOSAL_STATUS_TEXT[item.status])),
      h("p", { class: "agent-rationale" }, item.rationale),
      h("p", { class: "agent-meta muted" }, `by ${item.author} · ${item.hunks.length} change group${item.hunks.length === 1 ? "" : "s"}${item.baseMatches || done ? "" : " · the document changed since"}`),
      h("ol", { class: "agent-hunks" }, item.hunks.map(renderHunk)),
      note ? h("p", { class: "agent-problem", role: "note" }, icon("warn"), h("span", null, note)) : null,
      h("div", { class: "agent-proposal-actions" },
        h("button", {
          type: "button",
          class: "primary-button",
          id: `agent-accept-${item.id}`,
          disabled: done || item.acceptable === 0,
          title: done ? "Accepted" : item.blocked ?? "Apply the clean changes as one undo step",
          onclick: () => review.accept(item.id),
        }, icon("check"), done ? " Accepted" : " Accept"),
        h("button", {
          type: "button",
          class: "text-button",
          id: `agent-reject-${item.id}`,
          title: done ? "Remove from the list (the accepted changes stay)" : "Discard this proposal",
          onclick: () => review.reject(item.id),
        }, done ? "Dismiss" : "Reject")));
  };

  const renderList = () => {
    const items = review.reviews();
    replace(list, items.length === 0
      ? h("li", { class: "agent-empty muted" }, "No proposals yet.")
      : items.map(renderProposal));
  };

  const renderAll = () => {
    root.hidden = !isOpen;
    if (!isOpen) return;
    renderHeader();
    renderActions();
    renderStatus();
    renderList();
  };

  review.on(renderAll);

  const panel: AgentPanel = {
    get isOpen() {
      return isOpen;
    },
    open() {
      if (!isOpen) {
        isOpen = true;
        if (prompt.value !== review.draft) prompt.value = review.draft;
        renderAll();
        onLayout();
      }
      prompt.focus();
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      renderAll();
      onLayout();
    },
    toggle() {
      if (isOpen) panel.close();
      else panel.open();
    },
  };
  renderAll();
  return panel;
}
