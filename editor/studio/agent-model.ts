// editor/studio/agent-model.ts — the Agent panel's state, without a DOM: the
// request Studio hands a local agent (the prompt, the export bytes and what
// is selected), the proposals it answers with, and their review. Proposals
// are EditProposal values (editor/proposals/); accepting one applies its
// clean hunks to the document as one undo step through
// StudioApp.replaceProject(). agent-panel.ts renders this object; tests drive
// it directly on the in-memory host.

import { LOCAL_AGENT_MAX_PROMPT, type LocalAgentEditorContext } from "../agent/types.ts";
import type { PatchValue } from "../api/types.ts";
import {
  applyProposalHunks,
  assessProposal,
  decideProposalHunks,
  parseProposal,
} from "../proposals/model.ts";
import type { EditProposal, HunkApplyState, ProposalAssessment } from "../proposals/types.ts";
import type { StudioApp } from "./app.ts";
import { available, unavailable, type AgentOutcome, type AgentRequest, type FeatureStatus, type StudioHost } from "./host.ts";

export const AGENT_PACK_MESSAGE = "Agents work on single-file projects for now; this document is a sharded pack.";

export type AgentRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface ChangeReview {
  /** JSON pointer into the project ("/maps/0/ground/12"). */
  path: string;
  /** Compact JSON of each side; "(none)" when absent. */
  before: string;
  after: string;
}

export interface HunkReview {
  id: string;
  summary: string;
  /** How the hunk fits the open document now. */
  state: HunkApplyState;
  /** Paths whose current value matches neither side. */
  conflicts: string[];
  decision: "accepted" | "rejected" | null;
  changes: ChangeReview[];
}

export interface ProposalReview {
  id: string;
  title: string;
  rationale: string;
  author: string;
  /** "accepted" once every hunk is decided, "partly-accepted" while some
   * hunks were accepted and others still conflict. */
  status: "pending" | "partly-accepted" | "accepted";
  /** The proposal was made against exactly the open document. */
  baseMatches: boolean;
  hunks: HunkReview[];
  /** Undecided hunks Accept would take (clean ones apply, already applied
   * ones are only marked). */
  acceptable: number;
  /** Why Accept cannot take anything now, or null. */
  blocked: string | null;
  /** Why the last Accept was refused, or null. */
  problem: string | null;
}

interface Entry {
  proposal: EditProposal;
  problem: string | null;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One side of a change as short JSON for the review list. */
export function compactSide(side: PatchValue, max = 48): string {
  if (!side.exists) return "(none)";
  const text = JSON.stringify(side.value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The open map and the selected cell or event, as the agent protocol
 * describes them; undefined without an open map. */
export function agentContext(app: StudioApp): LocalAgentEditorContext | undefined {
  const map = app.currentMap();
  if (!map) return undefined;
  const selection = app.selection;
  const event = selection.kind === "event" ? map.events?.find((item) => item.id === selection.eventId) : undefined;
  return {
    map: { id: map.id, ...(map.name === undefined ? {} : { name: map.name }), width: map.width, height: map.height },
    selectedCell: selection.kind === "cell" ? { mapId: map.id, x: selection.x, y: selection.y } : null,
    selectedEvent: event && selection.kind === "event"
      ? {
          id: event.id,
          ...(event.name === undefined ? {} : { name: event.name }),
          x: event.x,
          y: event.y,
          w: event.w ?? 1,
          h: event.h ?? 1,
          page: selection.page,
        }
      : null,
  };
}

/** Why a hunk in this state cannot be accepted. */
function hunkBlocked(hunk: HunkReview): string {
  return hunk.state === "partially-applied"
    ? `"${hunk.summary}" is already partly in the document, so it cannot be applied cleanly. Ask the agent again.`
    : `"${hunk.summary}" conflicts at ${hunk.conflicts.join(", ")}: the document changed there since the agent proposed it. Ask the agent again.`;
}

export class AgentReview {
  /** The request being typed (the panel's text box). */
  draft = "";
  status: AgentRunStatus = "idle";
  /** The status line: what happened last, or why something was refused. */
  message = "";
  private entries: Entry[] = [];
  private runId = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly app: StudioApp, private readonly host: StudioHost) {
    app.on((reason) => {
      // Proposals belong to the document they were made for.
      if (reason === "load") this.reset();
      else if (reason === "edit" || reason === "history") this.emit();
    });
  }

  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private reset(): void {
    if (this.status === "running") this.runId++;
    this.entries = [];
    this.status = "idle";
    this.message = "";
    this.emit();
  }

  /** Whether a request can be sent for the open document, and why not. */
  availability(): FeatureStatus {
    const feature = this.host.capabilities().agent;
    if (!feature.available) return feature;
    const session = this.app.session;
    if (!session) return unavailable("Open a document first.");
    if (session.kind !== "inline") return unavailable(AGENT_PACK_MESSAGE);
    return available(feature.reason);
  }

  /** The request for `prompt` and the open document, or why there is none. */
  request(prompt: string = this.draft): AgentRequest | { error: string } {
    const status = this.availability();
    if (!status.available) return { error: status.reason };
    const text = prompt.trim();
    if (text.length === 0) return { error: "Describe what the agent should change." };
    if (text.length > LOCAL_AGENT_MAX_PROMPT) {
      return { error: `The request is ${text.length} characters long; the limit is ${LOCAL_AGENT_MAX_PROMPT}.` };
    }
    const context = agentContext(this.app);
    return { prompt: text, projectText: this.app.session!.exportText(), ...(context ? { context } : {}) };
  }

  /** Send the request and wait for the agent's proposals. False when
   * nothing was sent, the run failed or it was cancelled meanwhile. */
  async send(prompt: string = this.draft): Promise<boolean> {
    if (this.status === "running") return false;
    const request = this.request(prompt);
    if ("error" in request) {
      this.status = "error";
      this.message = request.error;
      this.emit();
      return false;
    }
    const run = ++this.runId;
    this.status = "running";
    this.message = "The agent is working on your request…";
    this.emit();
    let outcome: AgentOutcome;
    try {
      outcome = await this.host.runAgent(request);
    } catch (error) {
      outcome = { ok: false, code: "FAILED", message: `The agent run failed: ${errorText(error)}` };
    }
    // Cancelled, or another document was opened, while the agent worked.
    if (run !== this.runId) return false;
    if (!outcome.ok) {
      this.status = "error";
      this.message = outcome.message;
      this.emit();
      return false;
    }
    const { added, invalid } = this.receive(outcome.proposals);
    this.status = "done";
    this.message = [
      added === 0 ? "The agent finished without proposing a change." : `${plural(added, "proposal")} to review.`,
      ...invalid,
    ].join(" ");
    this.emit();
    return true;
  }

  /** Stop waiting for the running request and ask the host to stop it. */
  cancel(): void {
    if (this.status !== "running") return;
    this.runId++;
    this.status = "cancelled";
    this.message = "Cancelled. Nothing from this request will be shown.";
    const host = this.host;
    try {
      void Promise.resolve(host.cancelAgent?.()).catch(() => {});
    } catch {
      // The run is already abandoned on this side.
    }
    this.emit();
  }

  /** Add proposals (JSON texts of EditProposal values). A proposal with an
   * id already listed replaces that entry. */
  receive(texts: readonly string[]): { added: number; invalid: string[] } {
    let added = 0;
    const invalid: string[] = [];
    texts.forEach((text, index) => {
      let proposal: EditProposal;
      try {
        proposal = parseProposal(JSON.parse(text));
      } catch (error) {
        invalid.push(`Proposal ${index + 1} could not be read: ${errorText(error)}`);
        return;
      }
      const at = this.entries.findIndex((entry) => entry.proposal.id === proposal.id);
      if (at >= 0) this.entries[at] = { proposal, problem: null };
      else this.entries.push({ proposal, problem: null });
      added++;
    });
    if (texts.length > 0) this.emit();
    return { added, invalid };
  }

  /** The listed proposals, oldest first. */
  proposals(): readonly EditProposal[] {
    return this.entries.map((entry) => entry.proposal);
  }

  private entry(id: string): Entry | undefined {
    return this.entries.find((item) => item.proposal.id === id);
  }

  /** Each listed proposal as it fits the open document now. */
  reviews(): ProposalReview[] {
    return this.entries.map((entry) => this.reviewOf(entry));
  }

  review(id: string): ProposalReview | undefined {
    const entry = this.entry(id);
    return entry ? this.reviewOf(entry) : undefined;
  }

  private reviewOf(entry: Entry): ProposalReview {
    const { proposal } = entry;
    const session = this.app.session;
    let assessment: ProposalAssessment | null = null;
    let unassessable: string | null = null;
    if (!session) unassessable = "No document is open.";
    else if (session.kind !== "inline") unassessable = AGENT_PACK_MESSAGE;
    else {
      try {
        assessment = assessProposal(session.project(), proposal);
      } catch (error) {
        unassessable = errorText(error);
      }
    }
    const hunks = proposal.hunks.map((hunk, index): HunkReview => ({
      id: hunk.id,
      summary: hunk.summary,
      state: assessment?.hunks[index]?.state ?? "conflict",
      conflicts: assessment?.hunks[index]?.conflicts ?? [],
      decision: hunk.decision?.status ?? null,
      changes: hunk.changes.map((change) => ({ path: change.path || "/", before: compactSide(change.before), after: compactSide(change.after) })),
    }));
    const undecided = hunks.filter((hunk) => hunk.decision === null);
    const acceptable = assessment ? undecided.filter((hunk) => hunk.state === "clean" || hunk.state === "already-applied").length : 0;
    const accepted = hunks.some((hunk) => hunk.decision === "accepted");
    let blocked: string | null = null;
    if (unassessable !== null) blocked = unassessable;
    else if (undecided.length === 0) blocked = "Every change in this proposal has been decided.";
    else if (acceptable === 0) blocked = hunkBlocked(undecided[0]!);
    return {
      id: proposal.id,
      title: proposal.title,
      rationale: proposal.rationale,
      author: proposal.author,
      status: undecided.length === 0 && accepted ? "accepted" : accepted ? "partly-accepted" : "pending",
      baseMatches: assessment?.baseMatches ?? false,
      hunks,
      acceptable,
      blocked,
      problem: entry.problem,
    };
  }

  /** Apply every clean, undecided hunk as one undo step ("Accept proposal:
   * <title>") and mark it, and any hunk already in the document, accepted.
   * Conflicting hunks stay undecided. */
  accept(id: string): { ok: boolean; message: string } {
    const entry = this.entry(id);
    if (!entry) return this.refuse(null, `No proposal ${id} is listed.`);
    const review = this.reviewOf(entry);
    if (review.blocked !== null) return this.refuse(entry, review.blocked);
    const session = this.app.session!;
    const chosen = review.hunks.filter((hunk) => hunk.decision === null && (hunk.state === "clean" || hunk.state === "already-applied"));
    const clean = chosen.filter((hunk) => hunk.state === "clean").map((hunk) => hunk.id);
    if (clean.length > 0) {
      let next;
      try {
        next = applyProposalHunks(session.project(), entry.proposal, clean);
      } catch (error) {
        return this.refuse(entry, `Not accepted: ${errorText(error)}`);
      }
      const response = this.app.replaceProject(`Accept proposal: ${entry.proposal.title}`, next);
      if (!response?.ok) return this.refuse(entry, `Not accepted: ${response ? response.error.message : "no document is open"}`);
    }
    entry.proposal = decideProposalHunks(entry.proposal, chosen.map((hunk) => hunk.id), "accepted");
    entry.problem = null;
    const left = review.hunks.filter((hunk) => hunk.decision === null).length - chosen.length;
    const message = `Accepted "${entry.proposal.title}".${left > 0 ? ` ${plural(left, "change")} left undecided: ${left === 1 ? "it conflicts" : "they conflict"} with the document.` : ""}`;
    this.message = message;
    this.emit();
    return { ok: true, message };
  }

  private refuse(entry: Entry | null, message: string): { ok: false; message: string } {
    if (entry) entry.problem = message;
    this.message = message;
    this.emit();
    return { ok: false, message };
  }

  /** Drop a proposal from the list; the document is not touched. */
  reject(id: string): boolean {
    const before = this.entries.length;
    const entry = this.entry(id);
    this.entries = this.entries.filter((item) => item.proposal.id !== id);
    if (this.entries.length === before) return false;
    this.message = `Rejected "${entry!.proposal.title}".`;
    this.emit();
    return true;
  }
}
