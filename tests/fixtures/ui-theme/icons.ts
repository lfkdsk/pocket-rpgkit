// tests/fixtures/ui-theme/icons.ts — choice-row icon art for the ui-theme
// sim fixture (tests/choice-icon-render.test.ts). Three real 16x32 Tuxemon
// walkers and the 16x16 sign from the showcase example
// (examples/showcase/ATTRIBUTION.md); gen-assets.ts copies the PNGs into
// this fixture's assets/ before the build, so every key below is a baked
// image. The fixture resolves icons with the kit's own resolveChoiceIcon
// over ICON_SPRITES / ICON_ART, exactly as GameView does over a project's
// sprites and its asset manifest. "ghost" is deliberately absent.

import type { SpriteDef } from "../../../src/engine/types.ts";
import type { NpcArt } from "../../../src/ui/game-assets.ts";

/** Walkers copied from the showcase (12 frames each) and the static sign. */
export const ICON_WALKERS = ["curator", "guide", "alternate"] as const;
export const ICON_STATIC = "sign";

export const ICON_SPRITES: Record<string, SpriteDef> = {
  curator: { kind: "walker", sheet: "curator", h: 32 },
  guide: { kind: "walker", sheet: "guide", h: 32 },
  alternate: { kind: "walker", sheet: "alternate", h: 32 },
  sign: { kind: "image", src: "sign" },
  // Registered but never cooked: the manifest has no art for it.
  uncooked: { kind: "walker", sheet: "uncooked", h: 32 },
};

export const ICON_ART: Record<string, NpcArt> = {
  curator: {
    idle: ["assets/curator-idle-0.png", "assets/curator-idle-1.png", "assets/curator-idle-2.png", "assets/curator-idle-3.png"],
    walkL: ["assets/curator-left-0.png", "assets/curator-left-1.png", "assets/curator-left-2.png", "assets/curator-left-3.png"],
    walkR: ["assets/curator-right-0.png", "assets/curator-right-1.png", "assets/curator-right-2.png", "assets/curator-right-3.png"],
    h: 32,
  },
  guide: {
    idle: ["assets/guide-idle-0.png", "assets/guide-idle-1.png", "assets/guide-idle-2.png", "assets/guide-idle-3.png"],
    walkL: ["assets/guide-left-0.png", "assets/guide-left-1.png", "assets/guide-left-2.png", "assets/guide-left-3.png"],
    walkR: ["assets/guide-right-0.png", "assets/guide-right-1.png", "assets/guide-right-2.png", "assets/guide-right-3.png"],
    h: 32,
  },
  alternate: {
    idle: ["assets/alternate-idle-0.png", "assets/alternate-idle-1.png", "assets/alternate-idle-2.png", "assets/alternate-idle-3.png"],
    walkL: ["assets/alternate-left-0.png", "assets/alternate-left-1.png", "assets/alternate-left-2.png", "assets/alternate-left-3.png"],
    walkR: ["assets/alternate-right-0.png", "assets/alternate-right-1.png", "assets/alternate-right-2.png", "assets/alternate-right-3.png"],
    h: 32,
  },
  sign: "assets/sign.png",
};
