// Small data.fs bridge used by the desktop launcher. Proposal source files
// remain beside the project; this guest-visible snapshot is only transport.

import { file, fsHost, write } from "@pocketjs/framework/fs";
import { parseProposal } from "./model.ts";
import {
  EDITOR_SAVE_CAPABILITY_PATH,
  EDITOR_SAVE_PROTOCOL,
  EDITOR_SAVE_REQUEST_PATH,
  EDITOR_SAVE_RESULT_PATH,
  PROPOSAL_HOST_STATE_PATH,
  PROPOSAL_SESSION_PATH,
  type EditorSaveRequest,
  type EditorSaveResult,
  type ProposalHostState,
  type ProposalSession,
} from "./types.ts";

export {
  EDITOR_SAVE_CAPABILITY_PATH,
  EDITOR_SAVE_PROTOCOL,
  EDITOR_SAVE_REQUEST_PATH,
  EDITOR_SAVE_RESULT_PATH,
  PROPOSAL_HOST_STATE_PATH,
  PROPOSAL_SESSION_PATH,
} from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;

/** `absent` preserves the generic companion's legacy save channel. Any
 * malformed marker fails closed instead of silently bypassing managed CAS. */
export function editorSaveBridgeCapability(): "absent" | "ready" | "invalid" {
  if (fsHost() === null) return "absent";
  const entry = file(EDITOR_SAVE_CAPABILITY_PATH);
  if (!entry.exists()) return "absent";
  try {
    const value = JSON.parse(entry.text()) as Record<string, unknown>;
    return value.protocol === EDITOR_SAVE_PROTOCOL ? "ready" : "invalid";
  } catch {
    return "invalid";
  }
}

export function readEditorSaveResult(): EditorSaveResult | null {
  if (fsHost() === null) return null;
  const entry = file(EDITOR_SAVE_RESULT_PATH);
  if (!entry.exists()) return null;
  try {
    const value = JSON.parse(entry.text()) as Record<string, unknown>;
    if (!SHA256.test(String(value.id)) ||
        !["saved", "conflict", "invalid"].includes(String(value.status)) ||
        !SHA256.test(String(value.projectHash)) ||
        (value.message !== undefined && typeof value.message !== "string")) return null;
    return value as unknown as EditorSaveResult;
  } catch {
    return null;
  }
}

export function writeEditorSaveRequest(request: EditorSaveRequest): { ok: true } | { error: string } {
  if (fsHost() === null) return { error: "data.fs not mounted on this host" };
  try {
    write(EDITOR_SAVE_REQUEST_PATH, `${JSON.stringify(request)}\n`);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function readProposalHostState(): ProposalHostState | null {
  if (fsHost() === null) return null;
  const entry = file(PROPOSAL_HOST_STATE_PATH);
  if (!entry.exists()) return null;
  try {
    const value = JSON.parse(entry.text()) as Record<string, unknown>;
    if (typeof value.projectHash !== "string" || !SHA256.test(value.projectHash)) return null;
    return { projectHash: value.projectHash };
  } catch {
    return null;
  }
}

export function readProposalSession(): ProposalSession | null {
  if (fsHost() === null) return null;
  const entry = file(PROPOSAL_SESSION_PATH);
  if (!entry.exists()) return null;
  try {
    const value = JSON.parse(entry.text()) as Record<string, unknown>;
    if (typeof value.projectHash !== "string" || !Array.isArray(value.proposals)) return null;
    return {
      projectHash: value.projectHash,
      proposals: value.proposals.map(parseProposal),
    };
  } catch {
    return null;
  }
}

export function writeProposalSession(session: ProposalSession): { ok: true } | { error: string } {
  if (fsHost() === null) return { error: "data.fs not mounted on this host" };
  try {
    write(PROPOSAL_SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
