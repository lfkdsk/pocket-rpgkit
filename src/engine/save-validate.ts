// src/engine/save-validate.ts — deep structural validation for a
// decoded save snapshot (F4/task-1173).
//
// The FNV checksum proves a file was not truncated or typoed; it does not
// prove the content is a legal session, because a hand-crafted file can
// carry a correct checksum over structurally invalid state. The reducer
// indexes fiber stacks and compiled programs without further guards, so a
// snapshot missing `parallels` or carrying facing=99 is accepted by the
// checksum and then crashes the NEXT frame. validateSnapshot() rejects such
// input with a reason before any live state is replaced.
//
// This checker is deliberately map-agnostic (the core has no World): it
// verifies types, value ranges, internal cross-references and the save
// safe-point invariant. Whether `map` is a map THIS build runs is decided
// by the host when restoring (MapView compares against its runtime map).

import { MAX_FIBER_STACK_DEPTH } from "./interpreter.ts";
import { extensionCallNameValid, jsonValueProblem } from "./extensions.ts";

const INTEGER_OPS = new Set([
  "text", "choices", "switch", "variable", "selfSwitch", "if", "jmp",
  "wait", "gold", "item", "se", "erase", "exit", "transfer",
  "moveRoute", "common", "lockInput", "unlockInput", "place", "shop",
  "ext", "extChoice", "battle",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isU32(v: unknown): v is number {
  return isNonNegInt(v) && v <= 0xffffffff;
}

/** B1 (fix 3): the four numeric SwitchState banks
 *  (items/variables/gold/shopStock) must be SAFE integers, not merely
 *  finite, because every runtime write and every construction/restore
 *  entry point normalizes through interpreter.ts's clampFiniteVar, which
 *  never produces a value outside +/-Number.MAX_SAFE_INTEGER. A save
 *  carrying e.g. 1e308 in one of these banks cannot come from normal play;
 *  it is a hand-crafted file this checker must refuse. */
function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function fail(path: string, msg: string): string {
  return `${path}: ${msg}`;
}

// Condition vocabulary (engine/types.ts Condition). The reducer's
// evalCondition switches on `kind` without a default guard, so an unknown
// kind silently evaluates false; a malformed comparison field would feed
// undefined to a relational check. Saves carry compiled programs only, but
// programs are attacker-controlled JSON, so the vocabulary is checked.
function validateCondition(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "condition must be an object");
  switch (v.kind) {
    case "switch":
      if (typeof v.id !== "string") return fail(`${path}.id`, "string required");
      if (v.value !== undefined && typeof v.value !== "boolean") {
        return fail(`${path}.value`, "boolean required");
      }
      return null;
    case "selfSwitch":
      if (!["A", "B", "C", "D"].includes(v.key as string)) {
        return fail(`${path}.key`, "self switch must be A..D");
      }
      if (v.value !== undefined && typeof v.value !== "boolean") {
        return fail(`${path}.value`, "boolean required");
      }
      return null;
    case "variable": {
      if (typeof v.id !== "string") return fail(`${path}.id`, "string required");
      if (![">=", "<=", "==", "!="].includes(v.op as string)) {
        return fail(`${path}.op`, "unknown variable comparison");
      }
      if (!isFiniteNumber(v.value)) return fail(`${path}.value`, "number required");
      return null;
    }
    case "item":
      if (typeof v.id !== "string") return fail(`${path}.id`, "string required");
      if (!isNonNegInt(v.count)) return fail(`${path}.count`, "non-negative integer required");
      return null;
    case "gold":
      if (!isFiniteNumber(v.amount)) return fail(`${path}.amount`, "number required");
      return null;
    case "facing":
      if (!["down", "left", "right", "up"].includes(v.dir as string)) {
        return fail(`${path}.dir`, "bad direction");
      }
      return null;
    case "worldIdle":
      if (v.negate !== undefined && typeof v.negate !== "boolean") {
        return fail(`${path}.negate`, "boolean required");
      }
      return null;
    case "ext":
      if (typeof v.call !== "string" || !extensionCallNameValid(v.call)) {
        return fail(`${path}.call`, "namespaced extension call required");
      }
      {
        const problem = jsonValueProblem(v.args, `${path}.args`);
        if (problem) return problem;
      }
      return null;
    default:
      return fail(`${path}.kind`, "unknown condition kind");
  }
}

// PageCondition vocabulary (engine/types.ts PageCondition), reused by a
// compiled shop's ShopGood.condition (T2-10/B1): the goods list is
// embedded literally in the compiled Instr, unlike a page's own
// `condition`, which lives in the MapDef rather than a fiber stack.
function validatePageCondition(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "condition must be an object");
  if (v.switch !== undefined && typeof v.switch !== "string") {
    return fail(`${path}.switch`, "string required");
  }
  if (v.selfSwitch !== undefined && !["A", "B", "C", "D"].includes(v.selfSwitch as string)) {
    return fail(`${path}.selfSwitch`, "self switch must be A..D");
  }
  if (v.variable !== undefined) {
    const vv = v.variable;
    if (
      !isRecord(vv) || typeof vv.id !== "string" ||
      ![">=", "<=", "==", "!="].includes(vv.op as string) || !isFiniteNumber(vv.value)
    ) {
      return fail(`${path}.variable`, "{id, op, value} required");
    }
  }
  if (v.item !== undefined && typeof v.item !== "string") return fail(`${path}.item`, "string required");
  if (v.all !== undefined) {
    if (!Array.isArray(v.all) || v.all.length === 0) return fail(`${path}.all`, "non-empty array required");
    for (let i = 0; i < v.all.length; i++) {
      const e = validateCondition(v.all[i], `${path}.all[${i}]`);
      if (e) return e;
    }
  }
  return null;
}

const MOVE_STEPS = new Set([
  "moveDown", "moveLeft", "moveRight", "moveUp",
  "stepForward",
  "faceDown", "faceLeft", "faceRight", "faceUp",
  "wait", "turnRandom",
  "turnTowardPlayer",
]);

const MOVE_DIRS = new Set(["down", "left", "right", "up"]);

/** One route step: a legacy verb string or an object step
 *  ({turnToward}/{pathTo}/{approach}). */
function validateMoveStep(step: unknown, path: string): string | null {
  if (typeof step === "string") {
    return MOVE_STEPS.has(step) ? null : fail(path, "unknown move-step verb");
  }
  if (!isRecord(step)) return fail(path, "move step must be a string or object");
  if ("turnToward" in step) {
    const t = step.turnToward;
    if (t !== "player" && !(isRecord(t) && typeof t.event === "string" && t.event.length > 0)) {
      return fail(`${path}.turnToward`, "'player' or {event} required");
    }
    return null;
  }
  if ("pathTo" in step) {
    const p = step.pathTo;
    if (!isRecord(p) || !isNonNegInt(p.x) || !isNonNegInt(p.y)) {
      return fail(`${path}.pathTo`, "{x,y} non-negative integers required");
    }
    if (p.retries !== undefined && !isNonNegInt(p.retries)) {
      return fail(`${path}.pathTo.retries`, "non-negative integer required");
    }
    return null;
  }
  if ("approach" in step) {
    const a = step.approach;
    if (!isRecord(a)) return fail(`${path}.approach`, "object required");
    if (a.target !== "player" && !(isRecord(a.target) && typeof a.target.event === "string" && a.target.event.length > 0)) {
      return fail(`${path}.approach.target`, "'player' or {event} required");
    }
    if (a.side !== undefined && !MOVE_DIRS.has(a.side as string)) {
      return fail(`${path}.approach.side`, "down|left|right|up required");
    }
    if (a.distance !== undefined && (!isNonNegInt(a.distance) || a.distance < 1)) {
      return fail(`${path}.approach.distance`, "positive integer required");
    }
    if (a.retries !== undefined && !isNonNegInt(a.retries)) {
      return fail(`${path}.approach.retries`, "non-negative integer required");
    }
    return null;
  }
  return fail(path, "unknown move-step object");
}

function validateMoveRoute(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "move route must be an object");
  if (!Array.isArray(v.steps)) return fail(`${path}.steps`, "array of move steps required");
  for (let i = 0; i < v.steps.length; i++) {
    const e = validateMoveStep(v.steps[i], `${path}.steps[${i}]`);
    if (e) return e;
  }
  if (typeof v.repeat !== "boolean") return fail(`${path}.repeat`, "boolean required");
  if (typeof v.skippable !== "boolean") return fail(`${path}.skippable`, "boolean required");
  return null;
}

function validateVariableRef(v: unknown, path: string): string | null {
  if (!isRecord(v) || Object.keys(v).length !== 1 || typeof v.variable !== "string" || v.variable.length === 0) {
    return fail(path, "{variable: non-empty string} required");
  }
  return null;
}

/** Validate a compiled instruction tree (the programs serialized inside
 *  fiber stacks). An unknown op would wedge the run loop (pc never
 *  advances), so the vocabulary is checked exhaustively. */
function validateProg(prog: unknown, path: string): string | null {
  if (!Array.isArray(prog)) return fail(path, "stack program must be an array");
  for (let i = 0; i < prog.length; i++) {
    const ins = prog[i];
    const here = `${path}[${i}]`;
    if (!isRecord(ins) || typeof ins.op !== "string" || !INTEGER_OPS.has(ins.op)) {
      return fail(here, "unknown instruction op");
    }
    const needNum = (key: string): string | null =>
      isFiniteNumber(ins[key]) ? null : fail(`${here}.${key}`, "number required");
    const needStr = (key: string): string | null =>
      typeof ins[key] === "string" ? null : fail(`${here}.${key}`, "string required");
    const needBool = (key: string): string | null =>
      typeof ins[key] === "boolean" ? null : fail(`${here}.${key}`, "boolean required");
    switch (ins.op) {
      case "text": {
        if (!Array.isArray(ins.lines) || !ins.lines.every((l) => typeof l === "string")) {
          return fail(`${here}.lines`, "string array required");
        }
        if (!isFiniteNumber(ins.cps)) return fail(`${here}.cps`, "number required");
        break;
      }
      case "choices": {
        const e = needStr("prompt");
        if (e) return e;
        if (!Array.isArray(ins.texts) || !ins.texts.every((t) => typeof t === "string")) {
          return fail(`${here}.texts`, "string array required");
        }
        if (!Array.isArray(ins.branches) || ins.branches.length !== ins.texts.length) {
          return fail(`${here}.branches`, "one program per choice required");
        }
        for (const b of ins.branches) {
          const e = validateProg(b, `${here}.branches`);
          if (e) return e;
        }
        if (ins.cancel !== null && !Array.isArray(ins.cancel)) {
          return fail(`${here}.cancel`, "cancel program must be an array or null");
        }
        if (Array.isArray(ins.cancel)) {
          const e = validateProg(ins.cancel, `${here}.cancel`);
          if (e) return e;
        }
        break;
      }
      case "switch": {
        const e = needStr("id") || needBool("value");
        if (e) return e;
        break;
      }
      case "variable": {
        if (needStr("id")) return fail(`${here}.id`, "string required");
        const set = ins.set;
        if (!isRecord(set)) return fail(`${here}.set`, "object required");
        if (set.op === "random") {
          const { min, max } = set;
          if (!isFiniteNumber(min) || !isFiniteNumber(max) || min > max) {
            return fail(`${here}.set`, "random needs min <= max numbers");
          }
        } else if (typeof set.from === "string") {
          // T2-16 variable-operand variant: shares "add"/"sub" spellings
          // with the literal-value variant below, disambiguated by the
          // presence of `from` rather than `value`.
          if (!["copy", "add", "sub", "mul", "div", "mod"].includes(set.op as string)) {
            return fail(`${here}.set.op`, "unknown variable-ref op");
          }
        } else if (set.op === "set" || set.op === "add" || set.op === "sub") {
          if (!isFiniteNumber(set.value)) return fail(`${here}.set.value`, "number required");
        } else {
          return fail(`${here}.set.op`, "unknown variable set op");
        }
        break;
      }
      case "selfSwitch": {
        if (!["A", "B", "C", "D"].includes(ins.key as string)) {
          return fail(`${here}.key`, "self switch must be A..D");
        }
        if (typeof ins.value !== "boolean") return fail(`${here}.value`, "boolean required");
        break;
      }
      case "if":
        if (!isRecord(ins.cond)) return fail(`${here}.cond`, "object required");
        {
          const ce = validateCondition(ins.cond, `${here}.cond`);
          if (ce) return ce;
        }
        // The structured command vocabulary (engine/types.ts Command) has
        // no loop: compile() emits onFalse STRICTLY AFTER the IF and
        // pc=length is the "past the end" sentinel (the run loop pops the
        // frame). A backward/self edge is therefore compiler-impossible,
        // and accepting one lets a checksum-valid save enter a cycle the
        // runtime can only stop via the runaway backstop (review 1274 B1).
        // Forward edges alone make every run-mode advance strictly
        // increasing in pc: a fiber that neither suspends (wait/text/
        // choices/external) nor pops cannot exist in a save this gate
        // accepts.
        if (typeof ins.onFalse !== "number" || !Number.isInteger(ins.onFalse) ||
          ins.onFalse <= i || ins.onFalse > prog.length) {
          return fail(`${here}.onFalse`, "forward integer target after the if required");
        }
        break;
      case "jmp":
        // compile() emits the post-then JMP strictly after itself (it
        // skips the else block); end-of-program jumps compile to
        // prog.length. A self/backward jmp is a cycle (a direct self jump
        // or part of a multi-instruction loop) and is refused here.
        if (typeof ins.to !== "number" || !Number.isInteger(ins.to) ||
          ins.to <= i || ins.to > prog.length) {
          return fail(`${here}.to`, "forward integer target after the jmp required");
        }
        break;
      case "wait":
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        break;
      case "gold":
        if (ins.set !== "add" && ins.set !== "sub") return fail(`${here}.set`, "add|sub required");
        if (needNum("amount")) return fail(`${here}.amount`, "number required");
        break;
      case "item": {
        const e = needStr("item");
        if (e) return e;
        if (ins.set !== "add" && ins.set !== "sub") return fail(`${here}.set`, "add|sub required");
        if (!isFiniteNumber(ins.count)) return fail(`${here}.count`, "number required");
        break;
      }
      case "se": {
        const e = needStr("name") || needNum("volume") || needNum("pitch");
        if (e) return e;
        break;
      }
      case "erase":
      case "exit":
        break;
      case "lockInput":
      case "unlockInput":
        break;
      case "place": {
        if (ins.target !== "this" && !(isRecord(ins.target) && typeof ins.target.event === "string")) {
          return fail(`${here}.target`, '"this" or {event: id} required');
        }
        if (!isNonNegInt(ins.x) || !isNonNegInt(ins.y)) {
          return fail(`${here}`, "x/y non-negative integers required");
        }
        if (ins.dir !== null && !["down", "left", "right", "up"].includes(ins.dir as string)) {
          return fail(`${here}.dir`, "bad direction");
        }
        break;
      }
      case "transfer": {
        if (typeof ins.map !== "string") {
          const e = validateVariableRef(ins.map, `${here}.map`);
          if (e) return e;
        }
        if (!isFiniteNumber(ins.x)) {
          const e = validateVariableRef(ins.x, `${here}.x`);
          if (e) return e;
        }
        if (!isFiniteNumber(ins.y)) {
          const e = validateVariableRef(ins.y, `${here}.y`);
          if (e) return e;
        }
        if (ins.dir !== "keep" && !["down", "left", "right", "up"].includes(ins.dir as string)) {
          const e = validateVariableRef(ins.dir, `${here}.dir`);
          if (e) return e;
        }
        if (!isFiniteNumber(ins.fadeFrames)) return fail(`${here}.fadeFrames`, "number required");
        break;
      }
      case "moveRoute": {
        if (
          ins.target !== "player" &&
          ins.target !== "this" &&
          !(isRecord(ins.target) && typeof ins.target.event === "string" && ins.target.event.length > 0)
        ) {
          return fail(`${here}.target`, "player|this|{event: id} required");
        }
        const e = validateMoveRoute(ins.route, `${here}.route`);
        if (e) return e;
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "common":
        if (needStr("id")) return fail(`${here}.id`, "string required");
        break;
      case "shop": {
        {
          const e = needStr("id");
          if (e) return e;
        }
        if (!Array.isArray(ins.goods) || ins.goods.length === 0) {
          return fail(`${here}.goods`, "non-empty array required");
        }
        for (const g of ins.goods) {
          if (!isRecord(g) || typeof g.item !== "string") {
            return fail(`${here}.goods`, "each good needs an item id");
          }
          if (g.price !== undefined && !isFiniteNumber(g.price)) {
            return fail(`${here}.goods`, "price must be a number when present");
          }
          if (g.sellPrice !== undefined && !isFiniteNumber(g.sellPrice)) {
            return fail(`${here}.goods`, "sellPrice must be a number when present");
          }
          if (g.stock !== undefined && !isNonNegInt(g.stock)) {
            return fail(`${here}.goods`, "stock must be a non-negative integer when present");
          }
          if (g.condition !== undefined) {
            const e = validatePageCondition(g.condition, `${here}.goods.condition`);
            if (e) return e;
          }
        }
        if (typeof ins.sell !== "boolean") return fail(`${here}.sell`, "boolean required");
        if (ins.sellList !== "disable" && ins.sellList !== "hide") {
          return fail(`${here}.sellList`, "'disable' or 'hide' required");
        }
        break;
      }
      case "ext": {
        if (typeof ins.call !== "string" || !extensionCallNameValid(ins.call)) {
          return fail(`${here}.call`, "namespaced extension call required");
        }
        const problem = jsonValueProblem(ins.args, `${here}.args`);
        if (problem) return problem;
        break;
      }
      case "extChoice": {
        if (typeof ins.call !== "string" || !extensionCallNameValid(ins.call)) {
          return fail(`${here}.call`, "namespaced extension call required");
        }
        if (typeof ins.prompt !== "string") return fail(`${here}.prompt`, "string required");
        if (typeof ins.cancel !== "boolean") return fail(`${here}.cancel`, "boolean required");
        const problem = jsonValueProblem(ins.args, `${here}.args`);
        if (problem) return problem;
        if (ins.write !== null) {
          if (!isRecord(ins.write)) return fail(`${here}.write`, "record or null required");
          const ids: string[] = [];
          for (const field of ["index", "key", "cancelled"] as const) {
            const id = ins.write[field];
            if (id === undefined) continue;
            if (typeof id !== "string" || id.length === 0) {
              return fail(`${here}.write.${field}`, "non-empty variable id required");
            }
            ids.push(id);
          }
          if (ids.length === 0) return fail(`${here}.write`, "at least one destination required");
          if (new Set(ids).size !== ids.length) {
            return fail(`${here}.write`, "destinations must be distinct");
          }
        }
        break;
      }
      case "battle": {
        const problem = jsonValueProblem(ins.setup, `${here}.setup`);
        if (problem) return problem;
        for (const branch of ["onWin", "onLose", "onEscape"] as const) {
          if (ins[branch] !== null && !Array.isArray(ins[branch])) {
            return fail(`${here}.${branch}`, "program array or null required");
          }
          if (Array.isArray(ins[branch])) {
            const e = validateProg(ins[branch], `${here}.${branch}`);
            if (e) return e;
          }
        }
        break;
      }
    }
  }
  return null;
}

const FIBER_MODES = new Set(["run", "text", "choices", "shop", "wait", "external"]);

function validateFiber(
  v: unknown,
  path: string,
  wantParallel: boolean,
  mapId: string,
): string | null {
  if (!isRecord(v)) return fail(path, "fiber must be an object");
  if (typeof v.key !== "string" || !v.key.includes("/")) {
    return fail(`${path}.key`, "fiber key must be map/event-id");
  }
  if (v.key !== `${mapId}/${v.key.slice(v.key.indexOf("/") + 1)}`) {
    return fail(`${path}.key`, "fiber key does not belong to the saved map");
  }
  if (typeof v.parallel !== "boolean" || v.parallel !== wantParallel) {
    return fail(`${path}.parallel`, "fiber parallel flag mismatch");
  }
  if (!isNonNegInt(v.pageIndex)) return fail(`${path}.pageIndex`, "non-negative integer required");
  if (!FIBER_MODES.has(v.mode as string)) return fail(`${path}.mode`, "unknown fiber mode");
  if (!isNonNegInt(v.since)) return fail(`${path}.since`, "non-negative integer required");
  if (typeof v.erase !== "boolean") return fail(`${path}.erase`, "boolean required");
  if (!Array.isArray(v.stack) || v.stack.length === 0) {
    return fail(`${path}.stack`, "non-empty stack array required");
  }
  if (v.stack.length > MAX_FIBER_STACK_DEPTH) {
    return fail(`${path}.stack`, `at most ${MAX_FIBER_STACK_DEPTH} frames allowed`);
  }
  for (let i = 0; i < v.stack.length; i++) {
    const frame = v.stack[i];
    const here = `${path}.stack[${i}]`;
    if (!isRecord(frame)) return fail(here, "stack frame must be an object");
    if (!Array.isArray(frame.prog)) return fail(`${here}.prog`, "program array required");
    const pc = frame.pc;
    if (typeof pc !== "number" || !Number.isInteger(pc) || pc < 0 || pc > frame.prog.length) {
      return fail(`${here}.pc`, "pc must index inside the program");
    }
    const e = validateProg(frame.prog, `${here}.prog`);
    if (e) return e;
  }
  // Mode / pc / current-instruction cross-check. On resume the reducer
  // indexes stack[0].prog[pc] WITHOUT a guard for the suspending modes:
  //   wait    -> reads prog[pc].frames
  //   text    -> reads prog[pc].op/lines
  //   choices -> reads prog[pc].op/texts
  // so a suspended fiber whose pc sits at (or past) end of program crashes
  // the next frame even though every field is well-typed (R1202-1).
  const top = v.stack[0]! as { prog: unknown[]; pc: number };
  switch (v.mode) {
    case "run":
      // pc == length is the normal "pop this frame" sentinel the run loop
      // handles; only the suspended modes below need a live instruction.
      break;
    case "wait": {
      const ins = top.pc < top.prog.length ? top.prog[top.pc] : undefined;
      if (!isRecord(ins) || ins.op !== "wait") {
        return fail(`${path}.mode`, "a wait fiber must park on a wait instruction");
      }
      break;
    }
    case "text":
    case "choices":
    case "shop":
    case "external":
      // A safe point carries no open modal and no parked external request,
      // so a fiber suspended in one of these modes cannot be resumed: the
      // modal/pending fields it would read back are absent by construction.
      return fail(`${path}.mode`, `a save cannot park a fiber in ${v.mode as string} mode`);
  }
  return null;
}

function validateSwitchState(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "switch state must be an object");
  const booleanRecord = (key: string): string | null => {
    const rec = v[key];
    if (!isRecord(rec)) return fail(`${path}.${key}`, "record required");
    for (const [k, val] of Object.entries(rec)) {
      if (typeof val !== "boolean") return fail(`${path}.${key}.${k}`, "boolean required");
    }
    return null;
  };
  const numberRecord = (key: string): string | null => {
    const rec = v[key];
    if (!isRecord(rec)) return fail(`${path}.${key}`, "record required");
    for (const [k, val] of Object.entries(rec)) {
      if (!isSafeInt(val)) return fail(`${path}.${key}.${k}`, "safe integer required");
    }
    return null;
  };
  const variableRecord = (key: string): string | null => {
    const rec = v[key];
    if (!isRecord(rec)) return fail(`${path}.${key}`, "record required");
    for (const [k, val] of Object.entries(rec)) {
      if (typeof val !== "string" && !isSafeInt(val)) {
        return fail(`${path}.${key}.${k}`, "string or safe integer required");
      }
    }
    return null;
  };
  let e = booleanRecord("switches");
  if (e) return e;
  e = numberRecord("items");
  if (e) return e;
  e = variableRecord("variables");
  if (e) return e;
  // T2-10/B1: absent (an older bank without any shop stock) is allowed and
  // defaults to empty at load, matching playerName's back-compat rule
  // below; a present entry must be a non-negative safe integer (units
  // remaining; B1 (fix 3) tightened this from a merely
  // non-negative integer).
  if (v.shopStock !== undefined) {
    if (!isRecord(v.shopStock)) return fail(`${path}.shopStock`, "record required");
    for (const [k, val] of Object.entries(v.shopStock)) {
      if (!isSafeInt(val) || val < 0) return fail(`${path}.shopStock.${k}`, "non-negative safe integer required");
    }
  }
  if (!isRecord(v.self)) return fail(`${path}.self`, "record required");
  for (const [k, val] of Object.entries(v.self)) {
    if (val !== undefined && !["A", "B", "C", "D"].includes(val as string)) {
      return fail(`${path}.self.${k}`, "self switch must be A..D or absent");
    }
  }
  if (!isSafeInt(v.gold)) return fail(`${path}.gold`, "safe integer required");
  if (!isU32(v.rng)) return fail(`${path}.rng`, "u32 RNG cursor required");
  // The player name is present in every snapshot a current runtime writes;
  // an older bank without it is allowed and defaults at load, but a present
  // value must be a non-empty, bounded string.
  if (v.playerName !== undefined) {
    if (typeof v.playerName !== "string" || v.playerName.length < 1 || v.playerName.length > 24) {
      return fail(`${path}.playerName`, "string of length 1..24 required");
    }
  }
  return null;
}

function validateLatchRecord(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [k, val] of Object.entries(v)) {
    if (val !== true) return fail(`${path}.${k}`, "latch values must be true");
  }
  return null;
}

/** Durable `place` overrides: event id -> {x, y, dir|null}. */
function validatePlacements(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [id, p] of Object.entries(v)) {
    const at = `${path}.${id}`;
    if (!isRecord(p)) return fail(at, "placement must be an object");
    if (!isNonNegInt(p.x) || !isNonNegInt(p.y)) return fail(`${at}`, "x/y non-negative integers required");
    if (p.dir !== null && !["down", "left", "right", "up"].includes(p.dir as string)) {
      return fail(`${at}.dir`, "bad direction or null");
    }
  }
  return null;
}

function validateModal(v: unknown, path: string, liveKeys: ReadonlySet<string>): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return fail(path, "modal must be an object or null");
  if (typeof v.fiber !== "string" || !liveKeys.has(v.fiber)) {
    return fail(`${path}.fiber`, "modal must reference a live fiber");
  }
  if (v.kind === "text") {
    if (!Array.isArray(v.lines) || !v.lines.every((l) => typeof l === "string")) {
      return fail(`${path}.lines`, "string array required");
    }
    if (!isNonNegInt(v.revealed) || !isNonNegInt(v.total) || v.revealed > v.total) {
      return fail(`${path}`, "revealed must be within 0..total");
    }
    if (typeof v.complete !== "boolean") return fail(`${path}.complete`, "boolean required");
    return null;
  }
  if (v.kind === "choices") {
    if (typeof v.prompt !== "string") return fail(`${path}.prompt`, "string required");
    if (!Array.isArray(v.options) || !v.options.every((o) => typeof o === "string")) {
      return fail(`${path}.options`, "string array required");
    }
    if (typeof v.cancellable !== "boolean") return fail(`${path}.cancellable`, "boolean required");
    const dynamic = v.keys !== undefined || v.enabled !== undefined;
    if (dynamic) {
      if (!Array.isArray(v.keys) || v.keys.length !== v.options.length ||
        !v.keys.every((key) => typeof key === "string" && key.length > 0)) {
        return fail(`${path}.keys`, "one non-empty string key per option required");
      }
      if (new Set(v.keys).size !== v.keys.length) {
        return fail(`${path}.keys`, "choice keys must be unique");
      }
      if (!Array.isArray(v.enabled) || v.enabled.length !== v.options.length ||
        !v.enabled.every((enabled) => typeof enabled === "boolean")) {
        return fail(`${path}.enabled`, "one boolean per option required");
      }
      if (!v.cancellable && !v.enabled.some((enabled) => enabled === true)) {
        return fail(`${path}.enabled`, "a non-cancellable dynamic choice needs an enabled option");
      }
    } else if (v.options.length === 0) {
      return fail(`${path}.options`, "non-empty string array required");
    }
    if (!isNonNegInt(v.index) || (
      v.options.length === 0 ? v.index !== 0 : v.index >= v.options.length
    )) {
      return fail(`${path}.index`, "choice index out of range");
    }
    return null;
  }
  if (v.kind === "shop") {
    if (!isNonNegInt(v.gold)) return fail(`${path}.gold`, "non-negative integer required");
    if (typeof v.sell !== "boolean") return fail(`${path}.sell`, "boolean required");
    if (v.stage !== "buy" && v.stage !== "sell") return fail(`${path}.stage`, "'buy' or 'sell' required");
    if (!Array.isArray(v.rows) || v.rows.length === 0) {
      return fail(`${path}.rows`, "non-empty array required");
    }
    for (const row of v.rows) {
      if (!isRecord(row)) return fail(`${path}.rows`, "row must be an object");
      if (row.kind === "item") {
        if (typeof row.item !== "string") return fail(`${path}.rows`, "item row requires an item id");
        if (!isNonNegInt(row.price) || !isNonNegInt(row.owned)) {
          return fail(`${path}.rows`, "item row requires non-negative price/owned");
        }
        if (typeof row.canAfford !== "boolean" || typeof row.atCap !== "boolean") {
          return fail(`${path}.rows`, "item row requires canAfford/atCap booleans");
        }
        if (row.stock !== null && !isNonNegInt(row.stock)) {
          return fail(`${path}.rows`, "item row requires stock: non-negative integer or null");
        }
        if (typeof row.sellable !== "boolean") {
          return fail(`${path}.rows`, "item row requires a sellable boolean");
        }
      } else if (row.kind !== "sell" && row.kind !== "leave" && row.kind !== "back") {
        return fail(`${path}.rows`, "unknown row kind");
      }
    }
    if (!isNonNegInt(v.index) || v.index >= v.rows.length) {
      return fail(`${path}.index`, "shop row index out of range");
    }
    return null;
  }
  return fail(`${path}.kind`, "unknown modal kind");
}

/** Deep-validate a decoded snapshot and its save-time invariants. Returns
 *  null when the session is safe to restore, otherwise a reason string. */
export function validateSnapshot(snap: unknown): string | null {
  if (!isRecord(snap)) return "state: snapshot must be an object";
  if (typeof snap.map !== "string" || snap.map.length === 0) {
    return "state.map: non-empty string required";
  }
  if (!isU32(snap.held)) return "state.held: u32 button mask required";
  const extProblem = jsonValueProblem(snap.ext, "state.ext");
  if (extProblem) return extProblem;

  // player
  const p = snap.player;
  if (!isRecord(p)) return "state.player: object required";
  const ints = ["tx", "ty", "px", "py", "facing", "phase", "stepDir"] as const;
  for (const key of ints) {
    if (!isNonNegInt(p[key])) return `state.player.${key}: non-negative integer required`;
  }
  // The loop above proved these are non-negative integers.
  const { facing, stepDir, tx, ty, px, py } = p as Record<(typeof ints)[number], number>;
  if (facing > 3 || stepDir > 3) return "state.player: facing/stepDir must be 0..3";
  if (typeof p.moving !== "boolean" || typeof p.walking !== "boolean") {
    return "state.player: moving/walking must be booleans";
  }
  // Safe-point invariant: saves are taken on a tile boundary with the
  // interpolation finished, so px/py sit exactly on an origin tile.
  if (p.moving !== false || p.phase !== 0) {
    return "state.player: a save must rest on a tile boundary (moving=false, phase=0)";
  }
  if (px !== tx * 16 || py !== ty * 16) {
    return "state.player: pixel position must match the tile origin";
  }

  // interp
  const it = snap.interp;
  if (!isRecord(it)) return "state.interp: object required";
  if (!isNonNegInt(it.frame)) return "state.interp.frame: non-negative integer required";
  // A fatalized interpreter is frozen runtime state, never a save point:
  // loading one would restore a hung session (review 1274 B1 backstop).
  if (it.error !== undefined) {
    return "state.interp.error: a fatal interpreter state cannot be saved";
  }
  const e = validateSwitchState(it.sw, "state.interp.sw");
  if (e) return e;

  // A save never carries a blocking fiber (canSave gate). Parallel fibers
  // serialize live, including one parked mid-wait.
  if (it.main !== null) {
    const fe = validateFiber(it.main, "state.interp.main", false, snap.map);
    if (fe) return fe;
    return "state.interp.main: a save cannot hold a blocking fiber";
  }
  if (!isRecord(it.parallels)) return "state.interp.parallels: record required";
  for (const [key, fiber] of Object.entries(it.parallels)) {
    if (typeof key !== "string") return "state.interp.parallels: string keys required";
    // The reducer resolves modal ownership, erasure and page state through
    // the fiber's OWN .key, while scanTriggers indexes the dictionary by the
    // map/event key it computes; a mismatched pair would resume a fiber
    // under an event the live world does not own.
    if (isRecord(fiber) && fiber.key !== key) {
      return "state.interp.parallels: fiber key must match its dictionary key";
    }
    const fe = validateFiber(fiber, `state.interp.parallels.${key}`, true, snap.map);
    if (fe) return fe;
  }

  const liveKeys = new Set(Object.keys(it.parallels));
  const me = validateModal(it.modal, "state.interp.modal", liveKeys);
  if (me) return me;
  if (it.modal !== null) return "state.interp.modal: a save cannot hold an open modal";

  const er = validateLatchRecord(it.erased, "state.interp.erased");
  if (er) return er;
  const tt = validateLatchRecord(it.touched, "state.interp.touched");
  if (tt) return tt;
  if (typeof it.inputLocked !== "boolean") {
    return "state.interp.inputLocked: boolean required";
  }
  const pl = validatePlacements(it.placements, "state.interp.placements");
  if (pl) return pl;
  if (!Array.isArray(it.cues)) return "state.interp.cues: array required";
  if (it.cues.length !== 0) return "state.interp.cues: cues must drain before save";
  if (it.pendingTransfer !== null) {
    return "state.interp.pendingTransfer: no parked transfer at a save point";
  }
  if (!Array.isArray(it.pendingMoveRoutes) || it.pendingMoveRoutes.length !== 0) {
    return "state.interp.pendingMoveRoutes: no parked move routes at a save point";
  }
  if (!Array.isArray(it.pendingBattles) || it.pendingBattles.length !== 0) {
    return "state.interp.pendingBattles: no queued battles at a save point";
  }
  if (!Array.isArray(it.pendingPlacements) || it.pendingPlacements.length !== 0) {
    return "state.interp.pendingPlacements: no pending event placements at a save point";
  }
  if (!Array.isArray(it.abortedRoutes) || it.abortedRoutes.length !== 0) {
    return "state.interp.abortedRoutes: route aborts must drain before save";
  }
  return null;
}

/** Validate the envelope-level cross fields F5 requires: the advertised
 *  frame clock must be the snapshot's own frame. */
export function envelopeConsistent(
  envelope: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return envelope.frame === (snapshot.interp as Record<string, unknown>).frame;
}
