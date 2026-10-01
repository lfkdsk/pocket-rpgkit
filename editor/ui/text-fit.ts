import { getOps } from "@pocketjs/framework";
import { fitTextToWidth, wrapTextToWidth } from "../engine/text-layout.ts";

/** `text-xs` is the baked 12 px regular face (slot zero). */
export const EDITOR_TEXT_SLOT = 0;

const widthCache = new Map<string, number>();

export function editorTextWidth(text: string): number {
  if (text === "") return 0;
  let width = widthCache.get(text);
  if (width === undefined) {
    width = getOps().measureText(text, EDITOR_TEXT_SLOT);
    widthCache.set(text, width);
  }
  return width;
}

export function fitEditorText(text: string, maxWidth: number): string {
  return fitTextToWidth(text, maxWidth, editorTextWidth);
}

export function wrapEditorText(text: string, maxWidth: number, maxLines: number): string[] {
  return wrapTextToWidth(text, maxWidth, maxLines, editorTextWidth);
}
