// src/ui/choice-icons.ts — the sprite lookup behind choice-row icons
// (ChoiceOption.icon). A game that authors icons passes ChoiceIconBox
// (`pocket-rpgkit/ui/choice-icons`, ui/ChoiceIconBox.tsx) to GameView's
// `choiceIcons` prop; GameView then resolves each icon with
// resolveChoiceIcon over the project's sprites and its asset manifest.
// Games that leave the prop out never bundle the box. Plain TypeScript, so
// tests and tools can call it.

import { facingOfDir } from "../engine/start.ts";
import type { ChoiceIcon, SpriteDef } from "../engine/types.ts";
import type { NpcArt } from "./game-assets.ts";
import { playerImageKey } from "./PlayerSprite.tsx";
import type { ChoiceIconBoxProps } from "./ChoiceIconBox.tsx";
import type { Component } from "solid-js";

/** One resolved choice-row picture: a baked image key and its height. */
export interface ChoiceIconArt {
  src: string;
  /** 16 for a square image, 32 for a 16x32 walker frame. */
  h: 16 | 32;
}

/** Maps an option's icon to baked art; null when the sprite cannot paint. */
export type ChoiceIconResolver = (icon: ChoiceIcon) => ChoiceIconArt | null;

/** The component GameView/DialogBox mount for an icon choice. */
export type ChoiceIconBoxComponent = Component<ChoiceIconBoxProps>;

/** Look an icon up the way GameView paints characters: the project sprite
 *  must exist and paint, and the asset manifest must carry its art. A
 *  walker shows facing `dir` (default down) in pose `frame` (default 0). */
export function resolveChoiceIcon(
  icon: ChoiceIcon,
  sprites: Readonly<Record<string, SpriteDef>>,
  npcSrc: Readonly<Record<string, NpcArt>>,
): ChoiceIconArt | null {
  const def = sprites[icon.sprite];
  const art = def && (def.kind === "walker" || def.src) ? npcSrc[icon.sprite] : undefined;
  if (typeof art === "string") return art ? { src: art, h: 16 } : null;
  // `?.idle` also rejects inherited Object.prototype members.
  return art?.idle ? { src: playerImageKey(icon.frame ?? 0, facingOfDir(icon.dir ?? "down"), art), h: art.h } : null;
}
