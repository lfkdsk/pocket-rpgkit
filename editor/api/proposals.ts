// Proposal generation and sidecar storage for CLI, MCP and the editor launcher.

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Project } from "../../src/engine/types.ts";
import { serializeProject, serializeProjectPreservingSource } from "../engine/document.ts";
import { atomicWriteProjectFile, withProjectFileLock } from "./file.ts";
import { FileLockBusyError, withFileLock } from "./lock.ts";
import {
  applyEditPatch,
  createEditPatch,
  diffJson,
  EditApiError,
  executeEditOperation,
  semanticHash,
} from "./operations.ts";
import {
  applyProposalHunks,
  assessHunk,
  assessProposal,
  parseProposal,
  ProposalError,
  proposalComplete,
} from "../proposals/model.ts";
import type {
  EditProposal,
  ProposalRequest,
  ProposedOperation,
} from "../proposals/types.ts";

export const PROPOSAL_COMMANDS = [
  "propose",
  "list-proposals",
  "show-proposal",
  "withdraw-proposal",
] as const;
export type ProposalCommandName = (typeof PROPOSAL_COMMANDS)[number];

export interface ProposalFileRequest {
  command: ProposalCommandName;
  file: string;
  args?: unknown;
  dryRun?: boolean;
  root?: string;
}

export interface ProposalFileSuccess {
  ok: true;
  command: ProposalCommandName;
  file: string;
  proposalDirectory: string;
  dryRun: boolean;
  written: boolean;
  result: unknown;
}

export interface ProposalFileFailure {
  ok: false;
  command: ProposalCommandName;
  file?: string;
  dryRun?: boolean;
  written: false;
  error: {
    code: string;
    message: string;
    path?: string;
    expected?: unknown;
    actual?: unknown;
    details?: unknown;
  };
}

export type ProposalFileResponse = ProposalFileSuccess | ProposalFileFailure;

const MUTATION_COMMANDS = new Set([
  "update-map",
  "paint-tile",
  "paint-rect",
  "fill-region",
  "paint-passage",
  "add-event",
  "update-event",
  "delete-event",
  "add-page",
  "update-page",
  "delete-page",
  "insert-command",
  "delete-command",
  "update-command",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", `${path} must be an object`, path, "object", value);
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", `${path} must be a non-empty string`, path, "non-empty string", value);
  }
  return value;
}

function requestFrom(value: unknown, now: () => string): ProposalRequest {
  const input = record(value, "$");
  const allowed = new Set(["id", "title", "rationale", "author", "createdAt", "hunks"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", `unknown proposal request field(s): ${unknown.join(", ")}`, "$", [...allowed], unknown);
  }
  if (!Array.isArray(input.hunks) || input.hunks.length === 0) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", "$.hunks must be a non-empty array", "$.hunks", "non-empty array", input.hunks);
  }
  const hunks = input.hunks.map((rawHunk, hunkIndex) => {
    const hunk = record(rawHunk, `$.hunks[${hunkIndex}]`);
    const hunkAllowed = new Set(["id", "summary", "operations"]);
    const unknownHunk = Object.keys(hunk).filter((key) => !hunkAllowed.has(key));
    if (unknownHunk.length > 0) {
      throw new EditApiError("INVALID_PROPOSAL_REQUEST", `unknown hunk field(s): ${unknownHunk.join(", ")}`, `$.hunks[${hunkIndex}]`, [...hunkAllowed], unknownHunk);
    }
    if (!Array.isArray(hunk.operations) || hunk.operations.length === 0) {
      throw new EditApiError("INVALID_PROPOSAL_REQUEST", "hunk operations must be a non-empty array", `$.hunks[${hunkIndex}].operations`);
    }
    const operations = hunk.operations.map((rawOperation, operationIndex): ProposedOperation => {
      const path = `$.hunks[${hunkIndex}].operations[${operationIndex}]`;
      const operation = record(rawOperation, path);
      const operationUnknown = Object.keys(operation).filter((key) => key !== "command" && key !== "args");
      if (operationUnknown.length > 0) {
        throw new EditApiError("INVALID_PROPOSAL_REQUEST", `unknown operation field(s): ${operationUnknown.join(", ")}`, path);
      }
      const command = nonemptyString(operation.command, `${path}.command`);
      if (!MUTATION_COMMANDS.has(command)) {
        throw new EditApiError(
          "INVALID_PROPOSAL_OPERATION",
          `${path}.command must be an editing operation (save/read operations cannot form proposal hunks)`,
          `${path}.command`,
          [...MUTATION_COMMANDS],
          command,
        );
      }
      const args = operation.args === undefined ? {} : record(operation.args, `${path}.args`);
      return { command, args };
    });
    return {
      id: nonemptyString(hunk.id, `$.hunks[${hunkIndex}].id`),
      summary: nonemptyString(hunk.summary, `$.hunks[${hunkIndex}].summary`),
      operations,
    };
  });
  return {
    id: nonemptyString(input.id, "$.id"),
    title: nonemptyString(input.title, "$.title"),
    rationale: nonemptyString(input.rationale, "$.rationale"),
    author: nonemptyString(input.author, "$.author"),
    createdAt: input.createdAt === undefined ? now() : nonemptyString(input.createdAt, "$.createdAt"),
    hunks,
  };
}

function projectFromSource(source: string): Project {
  const opened = executeEditOperation(source, "open");
  if (!opened.response.ok) throw new EditApiError(
    opened.response.error.code,
    opened.response.error.message,
    opened.response.error.path,
    opened.response.error.expected,
    opened.response.error.actual,
    opened.response.error.details,
  );
  if (opened.response.project.documentKind !== "inline") {
    throw new EditApiError("READ_ONLY_PROJECT_SHELL", "proposals currently require an inline project", "$.mapIndex", "inline project with $.maps");
  }
  return JSON.parse(source) as Project;
}

/** Dry-run explicit operation groups against the same base. Operations inside
 * one hunk may depend on each other; different hunks must remain independent. */
export function createProposalFromOperations(
  source: string,
  requestValue: unknown,
  now: () => string = () => new Date().toISOString(),
): EditProposal {
  const base = projectFromSource(source);
  const request = requestFrom(requestValue, now);
  const hunks = request.hunks.map((requestHunk, hunkIndex) => {
    let hunkSource = source;
    for (let operationIndex = 0; operationIndex < requestHunk.operations.length; operationIndex++) {
      const operation = requestHunk.operations[operationIndex]!;
      const execution = executeEditOperation(hunkSource, operation.command, operation.args ?? {});
      if (!execution.response.ok) {
        throw new EditApiError(
          "PROPOSAL_OPERATION_FAILED",
          `hunk ${JSON.stringify(requestHunk.id)} operation ${operationIndex + 1} failed: ${execution.response.error.message}`,
          `$.hunks[${hunkIndex}].operations[${operationIndex}]`,
          undefined,
          undefined,
          execution.response.error,
        );
      }
      if (execution.output === undefined) {
        throw new EditApiError("INVALID_PROPOSAL_OPERATION", `${operation.command} did not produce an edited document`);
      }
      hunkSource = execution.output;
    }
    const changes = diffJson(base, JSON.parse(hunkSource));
    if (changes.length === 0) {
      throw new EditApiError("EMPTY_PROPOSAL_HUNK", `hunk ${JSON.stringify(requestHunk.id)} makes no semantic change`, `$.hunks[${hunkIndex}]`);
    }
    return { id: requestHunk.id, summary: requestHunk.summary, changes };
  });
  const proposal = parseProposal({
    id: request.id,
    title: request.title,
    rationale: request.rationale,
    author: request.author,
    createdAt: request.createdAt,
    baseHash: semanticHash(base),
    hunks,
  });

  // This is both a combined validity gate and a direct guarantee that the
  // proposal's unchanged EditChange payload can form a normal AI1 patch.
  const after = applyProposalHunks(base, proposal, hunks.map((hunk) => hunk.id));
  const changes = hunks.flatMap((hunk) => hunk.changes);
  const patch = {
    ...createEditPatch(base, after),
    changes,
  };
  applyEditPatch(base, patch);
  const validated = executeEditOperation(serializeProject(after), "validate");
  if (!validated.response.ok || !(validated.response.result as { valid?: boolean }).valid) {
    throw new EditApiError("INVALID_PROPOSAL", "combined proposal did not pass project validation", "$.hunks");
  }
  return proposal;
}

export function proposalDirectoryFor(projectFile: string): string {
  return `${projectFile}.proposals`;
}

export function proposalArchiveDirectoryFor(projectFile: string): string {
  return join(proposalDirectoryFor(projectFile), "archive");
}

function safeId(id: unknown): string {
  const text = nonemptyString(id, "$.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) {
    throw new EditApiError("INVALID_PROPOSAL_ID", "proposal id must be filesystem-safe", "$.id", "[A-Za-z0-9][A-Za-z0-9._-]{0,127}", text);
  }
  return text;
}

function proposalPath(projectFile: string, id: string, archived = false): string {
  return join(archived ? proposalArchiveDirectoryFor(projectFile) : proposalDirectoryFor(projectFile), `${id}.json`);
}

function assertStorageDirectory(projectFile: string, create: boolean): void {
  const directory = proposalDirectoryFor(projectFile);
  const archive = proposalArchiveDirectoryFor(projectFile);
  for (const path of [directory, archive]) {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal storage path must be a real directory: ${path}`, path);
      }
    } else if (create) {
      mkdirSync(path, { recursive: true });
    }
  }
}

function atomicReplace(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (existsSync(path)) chmodSync(temporary, statSync(path).mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function atomicCreate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Serialize sidecar transitions across CLI/bridge processes. A dead owner's
 * lock is reclaimed; a live owner fails fast instead of allowing last-writer
 * wins to reverse or lose decisions. */
function withStorageLock<T>(projectFile: string, key: string, run: () => T): T {
  assertStorageDirectory(projectFile, true);
  const path = join(proposalDirectoryFor(projectFile), `.lock-${key}`);
  try {
    return withFileLock(path, run);
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      throw new EditApiError("PROPOSAL_BUSY", `proposal storage is busy for ${JSON.stringify(key)}`, path);
    }
    throw error;
  }
}

function resolveProjectFile(file: string, root?: string): string {
  const project = realpathSync(resolve(file));
  if (root !== undefined) {
    const realRoot = realpathSync(resolve(root));
    const fromRoot = relative(realRoot, project);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      throw new EditApiError("PATH_OUTSIDE_ROOT", `path is outside the configured project root ${realRoot}`, project);
    }
  }
  return project;
}

function readProposalPath(path: string, expectedId?: string): EditProposal {
  let value: unknown;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("proposal files may not be symbolic links");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EditApiError("INVALID_PROPOSAL", `could not read proposal ${path}: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  const proposal = parseProposal(value);
  if (expectedId !== undefined && proposal.id !== expectedId) {
    throw new EditApiError(
      "INVALID_PROPOSAL",
      `proposal file name does not match its id ${JSON.stringify(proposal.id)}`,
      path,
      expectedId,
      proposal.id,
    );
  }
  return proposal;
}

function proposalWithoutDecisions(proposal: EditProposal): EditProposal {
  return {
    ...proposal,
    hunks: proposal.hunks.map(({ decision: _decision, ...hunk }) => hunk),
  };
}

/** Review persistence may only add decisions to the immutable proposal that
 * is already queued. This keeps a compromised/stale guest snapshot from
 * rewriting the operation payload or reversing a decision. */
function mergeReviewTransition(previous: EditProposal, next: EditProposal): EditProposal {
  if (semanticHash(proposalWithoutDecisions(previous)) !== semanticHash(proposalWithoutDecisions(next))) {
    throw new EditApiError(
      "INVALID_PROPOSAL_REVIEW",
      "review may not change proposal metadata, hunks, or edit changes",
      "$.proposal",
    );
  }
  const merged = structuredClone(next);
  for (let index = 0; index < previous.hunks.length; index++) {
    const before = previous.hunks[index]!.decision;
    const after = next.hunks[index]!.decision;
    if (before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
      throw new EditApiError(
        "INVALID_PROPOSAL_REVIEW",
        `review may not change the existing decision for hunk ${JSON.stringify(previous.hunks[index]!.id)}`,
        `$.hunks[${index}].decision`,
        before,
        after,
      );
    }
    if (before !== undefined && after === undefined) merged.hunks[index]!.decision = structuredClone(before);
  }
  return parseProposal(merged);
}

export function loadPendingProposals(projectFile: string): EditProposal[] {
  const directory = proposalDirectoryFor(projectFile);
  if (!existsSync(directory)) return [];
  assertStorageDirectory(projectFile, false);
  const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: directory, onlyFiles: true })).sort();
  const pending: EditProposal[] = [];
  for (const name of files) {
    const id = name.slice(0, -".json".length);
    const path = join(directory, name);
    const proposal = readProposalPath(path, id);
    if (!proposalComplete(proposal)) {
      pending.push(proposal);
      continue;
    }
    // Recover the only non-atomic boundary in archival (archive creation ->
    // pending removal). This also repairs files produced by older versions.
    withStorageLock(projectFile, id, () => {
      if (!existsSync(path)) return;
      const current = readProposalPath(path, id);
      if (!proposalComplete(current)) return;
      const archived = proposalPath(projectFile, id, true);
      if (existsSync(archived)) {
        const prior = readProposalPath(archived, id);
        if (semanticHash(prior) !== semanticHash(current)) {
          throw new EditApiError("INVALID_PROPOSAL_REVIEW", `pending and archived proposal ${JSON.stringify(id)} disagree`, path);
        }
      } else {
        atomicCreate(archived, `${JSON.stringify(current, null, 2)}\n`);
      }
      rmSync(path);
    });
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function persistMergedReview(projectFile: string, pending: string, proposal: EditProposal): string {
  const text = `${JSON.stringify(proposal, null, 2)}\n`;
  if (!proposalComplete(proposal)) {
    atomicReplace(pending, text);
    return pending;
  }
  const archived = proposalPath(projectFile, proposal.id, true);
  if (existsSync(archived)) {
    const prior = readProposalPath(archived, proposal.id);
    if (semanticHash(prior) !== semanticHash(proposal)) {
      throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `archived proposal ${JSON.stringify(proposal.id)} has different content`, "$.id");
    }
  } else {
    atomicCreate(archived, text);
  }
  rmSync(pending, { force: true });
  return archived;
}

function persistReviewedProposalLocked(projectFile: string, proposal: EditProposal): { path: string; proposal: EditProposal } {
  const pending = proposalPath(projectFile, proposal.id);
  if (!existsSync(pending)) {
    throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(proposal.id)} does not exist`, "$.id");
  }
  const merged = mergeReviewTransition(readProposalPath(pending, proposal.id), proposal);
  return { path: persistMergedReview(projectFile, pending, merged), proposal: merged };
}

export function persistReviewedProposal(projectFile: string, value: unknown): string {
  const proposal = parseProposal(value);
  return withStorageLock(projectFile, proposal.id, () => persistReviewedProposalLocked(projectFile, proposal).path);
}

export interface AppliedProposalReview {
  path: string;
  proposal: EditProposal;
  projectChanged: boolean;
}

/** Apply newly accepted hunks to the latest on-disk document under a
 * byte-checked atomic write, then record their decisions. Re-running after a
 * crash is safe: already-applied hunks skip the project write and finish the
 * sidecar transition. */
export function applyAcceptedProposalReview(projectFile: string, value: unknown): AppliedProposalReview {
  const proposal = parseProposal(value);
  const target = realpathSync(resolve(projectFile));
  return withProjectFileLock(target, () => withStorageLock(projectFile, proposal.id, () => {
    const pending = proposalPath(projectFile, proposal.id);
    if (!existsSync(pending)) {
      throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(proposal.id)} does not exist`, "$.id");
    }
    const previous = readProposalPath(pending, proposal.id);
    const merged = mergeReviewTransition(previous, proposal);
    const acceptedIds = merged.hunks.flatMap((hunk, index) =>
      previous.hunks[index]!.decision === undefined && hunk.decision?.status === "accepted" ? [hunk.id] : []);
    let projectChanged = false;
    if (acceptedIds.length > 0) {
      const source = readFileSync(target, "utf8");
      const project = projectFromSource(source);
      const clean: string[] = [];
      for (const id of acceptedIds) {
        const hunk = merged.hunks.find((candidate) => candidate.id === id)!;
        const assessment = assessHunk(project, hunk);
        if (assessment.state === "clean") clean.push(id);
        else if (assessment.state !== "already-applied") {
          throw new ProposalError(
            "PROPOSAL_HUNK_CONFLICT",
            `accepted hunk ${JSON.stringify(id)} is ${assessment.state} in the host project`,
            `$.hunks.${id}`,
            "clean or already-applied",
            assessment.state,
            assessment.conflicts,
          );
        }
      }
      if (clean.length > 0) {
        const edited = applyProposalHunks(project, merged, clean);
        const output = serializeProjectPreservingSource(source, project, edited);
        atomicWriteProjectFile(target, output, source);
        projectChanged = true;
      }
    }
    const persisted = persistMergedReview(projectFile, pending, merged);
    return { path: persisted, proposal: merged, projectChanged };
  }));
}

function failure(command: ProposalCommandName, file: string | undefined, dryRun: boolean, error: unknown): ProposalFileFailure {
  const known = error instanceof EditApiError || error instanceof ProposalError
    ? error
    : new EditApiError("PROPOSAL_IO_ERROR", error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    command,
    ...(file === undefined ? {} : { file }),
    dryRun,
    written: false,
    error: {
      code: known.code,
      message: known.message,
      ...(known.path === undefined ? {} : { path: known.path }),
      ...(known.expected === undefined ? {} : { expected: known.expected }),
      ...(known.actual === undefined ? {} : { actual: known.actual }),
      ...(known.details === undefined ? {} : { details: known.details }),
    },
  };
}

export function runProposalFileCommand(request: ProposalFileRequest): ProposalFileResponse {
  let file: string | undefined;
  const dryRun = request.dryRun === true;
  try {
    file = resolveProjectFile(request.file, request.root);
    const directory = proposalDirectoryFor(file);
    assertStorageDirectory(file, false);
    if (request.command === "propose") {
      const source = readFileSync(file, "utf8");
      const proposal = createProposalFromOperations(source, request.args);
      const path = proposalPath(file, proposal.id);
      if (!dryRun) {
        const projectFile = file;
        withStorageLock(projectFile, proposal.id, () => {
          if (existsSync(path) || existsSync(proposalPath(projectFile, proposal.id, true))) {
            throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `proposal ${JSON.stringify(proposal.id)} already exists`, "$.id");
          }
          atomicCreate(path, `${JSON.stringify(proposal, null, 2)}\n`);
        });
      } else if (existsSync(path) || existsSync(proposalPath(file, proposal.id, true))) {
        throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `proposal ${JSON.stringify(proposal.id)} already exists`, "$.id");
      }
      return { ok: true, command: request.command, file, proposalDirectory: directory, dryRun, written: !dryRun, result: { path, proposal } };
    }
    const args = record(request.args ?? {}, "$");
    const allowed = request.command === "list-proposals" ? [] : ["id"];
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new EditApiError("INVALID_ARGUMENT", `unknown argument(s): ${unknown.join(", ")}`, "$", allowed, unknown);
    if (request.command === "list-proposals") {
      const project = projectFromSource(readFileSync(file, "utf8"));
      const proposals = loadPendingProposals(file).map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        author: proposal.author,
        createdAt: proposal.createdAt,
        hunkCount: proposal.hunks.length,
        pendingHunks: proposal.hunks.filter((hunk) => hunk.decision === undefined).length,
        assessment: assessProposal(project, proposal),
      }));
      return { ok: true, command: request.command, file, proposalDirectory: directory, dryRun, written: false, result: proposals };
    }
    const id = safeId(args.id);
    const pending = proposalPath(file, id);
    const archived = proposalPath(file, id, true);
    if (request.command === "show-proposal") {
      const path = existsSync(pending) ? pending : archived;
      if (!existsSync(path)) throw new EditApiError("PROPOSAL_NOT_FOUND", `proposal ${JSON.stringify(id)} does not exist`, "$.id");
      const proposal = readProposalPath(path, id);
      const project = projectFromSource(readFileSync(file, "utf8"));
      return {
        ok: true,
        command: request.command,
        file,
        proposalDirectory: directory,
        dryRun,
        written: false,
        result: { path, archived: path === archived, proposal, assessment: assessProposal(project, proposal) },
      };
    }
    if (!existsSync(pending)) throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
    if (lstatSync(pending).isSymbolicLink()) throw new EditApiError("UNSAFE_PROPOSAL_PATH", "proposal files may not be symbolic links", pending);
    readProposalPath(pending, id);
    if (!dryRun) withStorageLock(file, id, () => {
      if (!existsSync(pending)) throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
      readProposalPath(pending, id);
      rmSync(pending);
    });
    return { ok: true, command: request.command, file, proposalDirectory: directory, dryRun, written: !dryRun, result: { id, withdrawn: true } };
  } catch (error) {
    return failure(request.command, file ?? request.file, dryRun, error);
  }
}
