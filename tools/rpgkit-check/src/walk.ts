// tools/rpgkit-check/src/walk.ts — walk an rpgkit-project/v1 command tree.
//
// Every check (lint and dynamic) needs to descend through `if` / `choices`
// / `battle` / `scene` branches the same way, so the recursion lives here
// once. A command path is a sequence of sequence indexes interleaved with
// branch tags, so a nested command points back at ONE place in the document:
//
//   [2]                      command 2 at the page root
//   [2, "then", 0]           command 2 is an `if`; its then-branch, cmd 0
//   [2, "options", 1, 0]     command 2 is `choices`; option 1, cmd 0
//   [2, "cancel", 0]         ... the cancel branch, cmd 0
//   [2, "onWin", 0]          command 2 is `battle`; its onWin branch, cmd 0
//   [2, "onDone", 0]         command 2 is `scene`; its onDone branch, cmd 0
//   [3, "common", "heal", 0] command 3 calls common event "heal"; its cmd 0
//
// `extChoice` has no static branches (the option list comes from a live
// extension), so the walker visits the command itself only.

import type { Command, Project } from "../../../src/engine/types.ts";

/** A path from a command list root to one command. Numbers are sequence
 *  indexes; strings name the branch taken at a nesting command. */
export type CommandPath = readonly (number | string)[];

/** Visit every command in the tree (branch bodies included). */
export function walkCommands(
  commands: readonly Command[],
  visit: (command: Command, path: CommandPath) => void,
  path: CommandPath = [],
): void {
  commands.forEach((command, index) => {
    const here = [...path, index];
    visit(command, here);
    switch (command.op) {
      case "if":
        walkCommands(command.then, visit, [...here, "then"]);
        if (command.else) walkCommands(command.else, visit, [...here, "else"]);
        break;
      case "choices":
        command.options.forEach((option, optionIndex) =>
          walkCommands(option.commands, visit, [...here, "options", optionIndex]));
        if (command.cancel) walkCommands(command.cancel.commands, visit, [...here, "cancel"]);
        break;
      case "battle":
        if (command.onWin) walkCommands(command.onWin, visit, [...here, "onWin"]);
        if (command.onLose) walkCommands(command.onLose, visit, [...here, "onLose"]);
        if (command.onEscape) walkCommands(command.onEscape, visit, [...here, "onEscape"]);
        break;
      case "scene":
        if (command.onDone) walkCommands(command.onDone, visit, [...here, "onDone"]);
        if (command.onCancel) walkCommands(command.onCancel, visit, [...here, "onCancel"]);
        break;
      default:
        break;
    }
  });
}

/** Walk a command tree as it runs on the caller's fiber: `common` ops are
 *  inlined (the interpreter executes the common program on the caller's
 *  fiber), so writes inside a common event are attributed to every caller.
 *  A common event already being expanded on this path is not re-expanded
 *  (self-recursive common events would otherwise loop forever); the
 *  `common` op itself is still visited. */
export function walkProjectCommands(
  project: Project,
  commands: readonly Command[],
  visit: (command: Command, path: CommandPath) => void,
  path: CommandPath = [],
  expanding: ReadonlySet<string> = new Set(),
): void {
  walkCommands(commands, (command, here) => {
    visit(command, here);
    if (command.op === "common" && !expanding.has(command.id)) {
      const common = project.commonEvents?.find((c) => c.id === command.id);
      if (common) {
        walkProjectCommands(
          project,
          common.commands,
          visit,
          [...here, "common", command.id],
          new Set(expanding).add(command.id),
        );
      }
    }
  }, path);
}

/** Project-aware count: commands with the given op anywhere in the tree,
 *  following `common` ops into the common event's own program (the
 *  interpreter runs it on the caller's fiber). */
export function countProjectOp(
  project: Project,
  commands: readonly Command[],
  op: Command["op"],
): number {
  let count = 0;
  walkProjectCommands(project, commands, (command) => {
    if (command.op === op) count++;
  });
  return count;
}

/** Project-aware collect: every command with the given op, common programs
 *  inlined. */
export function collectProjectOp<T extends Command["op"]>(
  project: Project,
  commands: readonly Command[],
  op: T,
): Extract<Command, { op: T }>[] {
  const out: Extract<Command, { op: T }>[] = [];
  walkProjectCommands(project, commands, (command) => {
    if (command.op === op) out.push(command as Extract<Command, { op: T }>);
  });
  return out;
}

/** Whether any command in the tree (common programs included) matches. */
export function anyProjectCommand(
  project: Project,
  commands: readonly Command[],
  pred: (command: Command) => boolean,
): boolean {
  let found = false;
  walkProjectCommands(project, commands, (command) => {
    if (pred(command)) found = true;
  });
  return found;
}

/** Whether the exact command object (identity) appears in the tree, common
 *  programs included. */
export function containsProjectCommand(
  project: Project,
  commands: readonly Command[],
  target: Command,
): boolean {
  return anyProjectCommand(project, commands, (command) => command === target);
}

/** Count commands with the given op anywhere in the tree. */
export function countOp(commands: readonly Command[], op: Command["op"]): number {
  let count = 0;
  walkCommands(commands, (command) => {
    if (command.op === op) count++;
  });
  return count;
}

/** Collect every command with the given op anywhere in the tree. */
export function collectOp<T extends Command["op"]>(
  commands: readonly Command[],
  op: T,
): Extract<Command, { op: T }>[] {
  const out: Extract<Command, { op: T }>[] = [];
  walkCommands(commands, (command) => {
    if (command.op === op) out.push(command as Extract<Command, { op: T }>);
  });
  return out;
}

/** Whether any command in the tree matches the predicate. */
export function anyCommand(
  commands: readonly Command[],
  pred: (command: Command) => boolean,
): boolean {
  let found = false;
  walkCommands(commands, (command) => {
    if (pred(command)) found = true;
  });
  return found;
}

/** Whether the exact command object (identity) appears in the tree. */
export function containsCommand(commands: readonly Command[], target: Command): boolean {
  return anyCommand(commands, (command) => command === target);
}
