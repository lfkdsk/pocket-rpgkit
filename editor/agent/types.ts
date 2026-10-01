export const LOCAL_AGENT_PROTOCOL = "rpgkit-local-agent/v1";
export const LOCAL_AGENT_MAX_PROMPT = 4096;

export interface LocalAgentCellContext {
  mapId: string;
  x: number;
  y: number;
}

export interface LocalAgentEventContext {
  id: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

export interface LocalAgentEditorContext {
  map: { id: string; name?: string; width: number; height: number };
  selectedCell: LocalAgentCellContext | null;
  selectedEvent: LocalAgentEventContext | null;
}

export interface LocalAgentStart {
  t: "agent-start";
  protocol: typeof LOCAL_AGENT_PROTOCOL;
  id: string;
  request: string;
  projectHash: string;
  context: LocalAgentEditorContext;
}

export interface LocalAgentCancel {
  t: "agent-cancel";
  protocol: typeof LOCAL_AGENT_PROTOCOL;
  id: string;
}

export interface LocalAgentReady {
  t: "agent-ready";
  protocol: typeof LOCAL_AGENT_PROTOCOL;
  available: boolean;
  adapter: string;
  message: string;
  maxPromptChars: number;
}

export type LocalAgentRunStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out";

export interface LocalAgentState {
  t: "agent-state";
  protocol: typeof LOCAL_AGENT_PROTOCOL;
  id: string;
  status: LocalAgentRunStatus;
  message: string;
  proposalIds?: string[];
}

export type LocalAgentGuestMessage = LocalAgentStart | LocalAgentCancel;
export type LocalAgentHostMessage = LocalAgentReady | LocalAgentState;

const LOCAL_AGENT_RUN_STATUSES = new Set<LocalAgentRunStatus>([
  "starting",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function parseLocalAgentGuestMessage(value: unknown): LocalAgentGuestMessage | null {
  const input = record(value);
  if (!input || input.protocol !== LOCAL_AGENT_PROTOCOL || !safeId(input.id)) return null;
  if (input.t === "agent-cancel") {
    return { t: "agent-cancel", protocol: LOCAL_AGENT_PROTOCOL, id: input.id };
  }
  if (input.t !== "agent-start" || typeof input.request !== "string" ||
      input.request.length === 0 || input.request.length > LOCAL_AGENT_MAX_PROMPT ||
      !safeId(input.projectHash)) return null;
  const context = record(input.context);
  const map = record(context?.map);
  if (!context || !map || typeof map.id !== "string" ||
      !Number.isInteger(map.width) || !Number.isInteger(map.height)) return null;
  const selectedCell = context.selectedCell === null ? null : record(context.selectedCell);
  if (selectedCell !== null && (typeof selectedCell.mapId !== "string" ||
      !Number.isInteger(selectedCell.x) || !Number.isInteger(selectedCell.y))) return null;
  const selectedEvent = context.selectedEvent === null ? null : record(context.selectedEvent);
  if (selectedEvent !== null && (typeof selectedEvent.id !== "string" ||
      !Number.isInteger(selectedEvent.x) || !Number.isInteger(selectedEvent.y) ||
      !Number.isInteger(selectedEvent.w) || !Number.isInteger(selectedEvent.h) ||
      !Number.isInteger(selectedEvent.page))) return null;
  return input as unknown as LocalAgentStart;
}

/** Validate host traffic before it reaches editor state. The SVC transport is
 * deliberately generic, so an unrelated or older companion must not be able
 * to make the editor claim an agent is ready or running. */
export function parseLocalAgentHostMessage(value: unknown): LocalAgentHostMessage | null {
  const input = record(value);
  if (!input || input.protocol !== LOCAL_AGENT_PROTOCOL) return null;
  if (input.t === "agent-ready") {
    if (typeof input.available !== "boolean" || typeof input.adapter !== "string" ||
        typeof input.message !== "string" || !Number.isInteger(input.maxPromptChars) ||
        Number(input.maxPromptChars) < 1 || Number(input.maxPromptChars) > LOCAL_AGENT_MAX_PROMPT) return null;
    return input as unknown as LocalAgentReady;
  }
  if (input.t !== "agent-state" || !safeId(input.id) ||
      typeof input.status !== "string" || !LOCAL_AGENT_RUN_STATUSES.has(input.status as LocalAgentRunStatus) ||
      typeof input.message !== "string") return null;
  if (input.proposalIds !== undefined &&
      (!Array.isArray(input.proposalIds) || input.proposalIds.some((id) => typeof id !== "string" || id.length === 0))) return null;
  return input as unknown as LocalAgentState;
}

