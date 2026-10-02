// tools/rpgmaker-import/text.ts — RPG Maker message escape codes to kit
// dialog text.
//
// MV/MZ expand escape codes when a message is drawn (Window_Base
// convertEscapeCharacters, then processEscapeCharacter per code); codes are
// case-insensitive and `\\` is a literal backslash. The kit's text box knows
// one token, `{name}` (the player name), so:
//
//   \N[1], \P[1]      -> {name}                          Native
//   \N[n], \P[n]      -> the actor's database name       Degraded (renames
//                        and party changes are not reflected)
//   \G                -> System.currencyUnit literal     Native
//   \\                -> a backslash                     Native
//   \V[n]             -> a visible "[Vn]" marker         Degraded (no
//                        variable text token)
//   \C[n] \I[n] \{ \} \$ \. \| \! \> \< \^, MZ \PX[n] \PY[n] \FS[n] and
//   plugin codes      -> stripped                         Degraded (colour,
//                        icons, font size, gold window, message timing)
//
// Every occurrence records one "escape" coverage row keyed by the code
// ("\\V", "\\C", ...).

import type { Coverage, Disposition } from "./coverage.ts";
import type { RmProject } from "./rm-types.ts";

export interface TextContext {
  rm: RmProject;
  cov: Coverage;
}

/** The kit's player-name text token (src/engine/player-name.ts). */
export const NAME_TOKEN = "{name}";

const STRIP_REASONS: Record<string, string> = {
  C: "text colour not supported",
  I: "inline icons not supported",
  "{": "font size changes not supported",
  "}": "font size changes not supported",
  FS: "font size changes not supported",
  PX: "text position changes not supported",
  PY: "text position changes not supported",
  $: "gold window not shown",
  ".": "message timing codes not supported",
  "|": "message timing codes not supported",
  "!": "message timing codes not supported",
  ">": "message timing codes not supported",
  "<": "message timing codes not supported",
  "^": "message timing codes not supported",
};

/** Convert message lines (401/405 parameters, choice labels, MZ speaker
 *  names). Returns the same number of lines; wrapping to the kit's line
 *  width is the caller's job. */
export function convertMessage(lines: string[], ctx: TextContext): string[] {
  return lines.map((line) => convertLine(String(line ?? ""), ctx));
}

function convertLine(text: string, ctx: TextContext): string {
  let out = "";
  let i = 0;
  const rec = (code: string, d: Disposition, reason?: string): void =>
    ctx.cov.record("escape", `\\${code}`, d, reason);
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const rest = text.slice(i + 1);
    if (rest.startsWith("\\")) {
      out += "\\";
      rec("\\", "Native");
      i += 2;
      continue;
    }
    // convertEscapeCharacters replaces \V[n], \N[n], \P[n] and \G by
    // regex before any other code is read, so "\Gold" is the currency
    // unit followed by "old".
    const pre = /^([VNP])\[(\d+)\]|^G/i.exec(rest);
    if (pre) {
      const code = pre[0][0]!.toUpperCase();
      const n = pre[2] === undefined ? 0 : Number(pre[2]);
      if (code === "V") {
        out += `[V${n}]`;
        rec("V", "Degraded", "no variable text token; shown as a [Vn] marker");
      } else if (code === "N") {
        out += actorName(n, ctx, (d, r) => rec("N", d, r));
      } else if (code === "P") {
        out += partyMemberName(n, ctx, (d, r) => rec("P", d, r));
      } else {
        out += ctx.rm.system.currencyUnit ?? "";
        rec("G", "Native");
      }
      i += 1 + pre[0].length;
      continue;
    }
    // Window_Base.obtainEscapeCode: one symbol, or a run of letters. The
    // built-in codes (C, I, PX, PY, FS) take an [n] parameter; plugin codes
    // usually do too, so a following [n] is stripped with the code.
    const sym = /^[$.|^!><{}]/.exec(rest);
    if (sym) {
      rec(sym[0], "Degraded", STRIP_REASONS[sym[0]]);
      i += 2;
      continue;
    }
    const word = /^[A-Za-z]+/.exec(rest);
    if (!word) {
      // A lone backslash before anything else: MV drops it.
      i++;
      continue;
    }
    const code = word[0].toUpperCase();
    const paramMatch = /^\[\d+\]/.exec(rest.slice(word[0].length));
    const consumed = 1 + word[0].length + (paramMatch ? paramMatch[0].length : 0);
    rec(code, "Degraded", STRIP_REASONS[code] ?? "plugin or unknown escape code stripped");
    i += consumed;
  }
  return out;
}

/** \P[n]: party member n. The leader is taken to be the player. */
function partyMemberName(
  n: number,
  ctx: TextContext,
  rec: (d: Disposition, reason?: string) => void,
): string {
  if (n === 1) {
    rec("Native");
    return NAME_TOKEN;
  }
  const actor = ctx.rm.system.partyMembers?.[n - 1];
  rec("Degraded", "party member names are the initial party's database names");
  return (actor === undefined ? null : ctx.rm.actors[actor])?.name ?? "";
}

function actorName(
  n: number,
  ctx: TextContext,
  rec: (d: Disposition, reason?: string) => void,
): string {
  // Actor 1 is taken to be the protagonist, whose name the kit keeps as the
  // player name (renamed by Name Input Processing).
  if (n === 1) {
    rec("Native");
    return NAME_TOKEN;
  }
  const a = ctx.rm.actors[n];
  rec("Degraded", "actor names other than actor 1 are database literals");
  return a?.name ?? "";
}
