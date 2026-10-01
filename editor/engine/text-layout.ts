// Pixel-measured text fitting shared by the editor chrome.  The PocketJS
// text renderer only wraps at explicit newlines, so callers must fit or wrap
// dynamic labels before handing them to <Text>.

export type TextMeasure = (text: string) => number;

function hardFit(text: string, maxWidth: number, measure: TextMeasure, suffix = "…"): string {
  if (maxWidth <= 0) return "";
  if (measure(text) <= maxWidth) return text;
  const suffixWidth = measure(suffix);
  if (suffixWidth > maxWidth) return "";
  let fitted = "";
  for (const character of text) {
    if (measure(fitted + character) + suffixWidth > maxWidth) break;
    fitted += character;
  }
  return fitted + suffix;
}

/** Fit one line to a pixel budget. Multi-word text is shortened only between
 * complete words; a single overlong token falls back to code-point fitting so
 * identifiers and URLs cannot escape their container. */
export function fitTextToWidth(text: string, maxWidth: number, measure: TextMeasure): string {
  if (maxWidth <= 0) return "";
  if (measure(text) <= maxWidth) return text;

  const normalized = text.trim().replace(/\s+/g, " ");
  const words = normalized.split(" ");
  const suffix = "…";
  let fitted = "";
  for (const word of words) {
    const candidate = fitted ? `${fitted} ${word}` : word;
    if (measure(candidate + suffix) > maxWidth) break;
    fitted = candidate;
  }
  return fitted ? `${fitted}${suffix}` : hardFit(normalized, maxWidth, measure, suffix);
}

/** Greedy word wrap with a bounded number of visible lines. If content does
 * not fit, only the final visible line is ellipsized. */
export function wrapTextToWidth(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: TextMeasure,
): string[] {
  if (maxWidth <= 0 || maxLines <= 0) return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let line = "";
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (lines.length === maxLines - 1) {
      const remaining = [line, ...words.slice(index)].filter(Boolean).join(" ");
      lines.push(fitTextToWidth(remaining, maxWidth, measure));
      return lines;
    }
    if (line) lines.push(line);
    if (measure(word) <= maxWidth) {
      line = word;
    } else {
      lines.push(hardFit(word, maxWidth, measure));
      line = "";
    }
    if (lines.length === maxLines) return lines;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}
