// src/engine/player-name.ts — the player's name and the {name} text token.
//
// The name lives in the switch bank (interpreter.ts SwitchState.playerName),
// so it is part of every save snapshot and survives transfers. A fresh
// session seeds it from Project.playerName (a game-configurable default);
// there is no rename op in rpgkit-project/v1 yet, but substituting at fold
// time instead of compile time keeps that door open without recompiling the
// map programs.
//
// Substitution runs inside the reducer when a text or choices modal is
// built. The typewriter reveal is counted over the EXPANDED string, so a
// 3-letter name and the 6-character "{name}" token type out over the right
// number of ticks. Pure and fold-only: no host clock, so it replays
// identically at every host rate.

/** The in-text token replaced with the player's name. */
export const NAME_TOKEN = "{name}";

/** Name a fresh playthrough uses when a project sets no playerName. */
export const DEFAULT_PLAYER_NAME = "Player";

/** Replace every literal {name} token with `name`. Other braces pass
 *  through unchanged; a name containing "{name}" is substituted once (the
 *  result is not rescanned), so expansion always terminates. */
export function substitutePlayerName(text: string, name: string): string {
  if (!text.includes(NAME_TOKEN)) return text;
  return text.split(NAME_TOKEN).join(name);
}

/** Apply the name token to every line of a text page. */
export function substituteLines(lines: readonly string[], name: string): string[] {
  return lines.map((line) => substitutePlayerName(line, name));
}

// --- text tokens ------------------------------------------------------------
//
// With Project.system.textVariables a text or choices string may also carry
// `{v:<id>}`: the live value of variable `id` (0 when unset, the RPG Maker
// \V[n] default). {name} and {v:…} are expanded in ONE left-to-right pass
// and the result is never rescanned, so a name or a string variable that
// itself contains a token prints it literally. Expansion runs once, when the
// box opens; the dialog box wraps and pages the expanded text.

/** A `{v:<id>}` token: the id runs to the next closing brace. */
const TEXT_TOKEN = /\{name\}|\{v:([^{}]*)\}/g;

/** Expand {name} and, when `variables` is given, {v:<id>} tokens. Without
 *  `variables` this is exactly substitutePlayerName. */
export function expandTextTokens(
  text: string,
  name: string,
  variables: Readonly<Record<string, number | string>> | null,
): string {
  if (variables === null) return substitutePlayerName(text, name);
  if (!text.includes("{")) return text;
  return text.replace(TEXT_TOKEN, (_token, id: string | undefined) => {
    if (id === undefined) return name;
    const value = Object.prototype.hasOwnProperty.call(variables, id) ? variables[id] : undefined;
    return value === undefined ? "0" : String(value);
  });
}

/** Apply expandTextTokens to every line of a text page. */
export function expandTextLines(
  lines: readonly string[],
  name: string,
  variables: Readonly<Record<string, number | string>> | null,
): string[] {
  return lines.map((line) => expandTextTokens(line, name, variables));
}
