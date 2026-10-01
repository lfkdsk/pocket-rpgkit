// Character-bound balloon icons. The reducer owns target, age and lifetime;
// this layer only binds those descriptors to cooked animation frames and
// live actor pixels. Nodes are pooled so changing/clearing a balloon never
// churns the native scene graph.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import type { CompiledAnim } from "../engine/interpreter.ts";
import type { BalloonEffectState } from "../engine/screen.ts";
import type { SessionState } from "../engine/session.ts";
import { TILE } from "../engine/tiles.ts";
import type { GameAssets } from "./game-assets.ts";

export interface BalloonAnchor {
  /** Actor foot-cell top-left in world pixels. */
  x: number;
  y: number;
  /** Current actor art height (16 or 32). */
  height: number;
}

export interface BalloonLayerProps {
  state: () => SessionState;
  anims: () => ReadonlyMap<string, CompiledAnim>;
  assets: GameAssets;
  anchor: (balloon: Readonly<BalloonEffectState>) => BalloonAnchor;
  /** While false, the per-frame sync pauses (the layer stays mounted and
   *  hidden with the world). Omit for always active. */
  active?: Accessor<boolean>;
  /** Fired once per synced frame, after the active gate — a heartbeat tests
   *  use to prove the hook paused. Omit in production. */
  onSync?: () => void;
  debugName?: string;
}

interface Slot {
  node: NodeMirror;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
}

interface SlotStyle {
  posType: number;
  insetL: number;
  insetT: number;
  width: number;
  height: number;
}

const slotStyle = (w: number, h: number): SlotStyle => ({
  posType: 1,
  insetL: 0,
  insetT: 0,
  width: w,
  height: h,
});

/** Balloons always loop their sprite sheet while present. A finite command
 * controls lifetime independently; a persistent Tuxemon-style bubble uses
 * the same frame clock until an explicit clear. */
export function balloonFrameIndex(compiled: Readonly<CompiledAnim>, age: number): number {
  const tick = Math.max(0, age) % compiled.total;
  for (let index = 0; index < compiled.frames; index++) {
    if (tick < compiled.steps[index]!) return index;
  }
  return compiled.frames - 1;
}

export function BalloonLayer(props: BalloonLayerProps): SolidJSX.Element {
  const root = createElement("view");
  setProp(root, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0, zIndex: 2 });
  setProp(root, "debugName", props.debugName ?? "rpgkit-balloons");

  const live = new Map<string, Slot>();
  const pool: NodeMirror[] = [];

  const release = (slot: Slot): void => {
    setProp(slot.node, "src", "", slot.src);
    slot.src = "";
    live.delete(slot.id);
    pool.push(slot.node);
  };

  const acquire = (id: string): Slot => {
    const node = pool.pop() ?? (() => {
      const created = createElement("image");
      setProp(created, "style", slotStyle(TILE, TILE));
      insertNode(root, created);
      return created;
    })();
    const slot: Slot = { node, id, x: -1, y: -1, w: TILE, h: TILE, src: "" };
    setProp(node, "debugName", `rpgkit-balloon-${id}`);
    live.set(id, slot);
    return slot;
  };

  onFrame(() => {
    if (props.active && !props.active()) return;
    props.onSync?.();
    const state = props.state();
    const balloons = state.interp.screen?.balloons;
    if (!balloons) {
      if (live.size > 0) for (const [, slot] of [...live]) release(slot);
      return;
    }

    for (const [id, slot] of [...live]) {
      if (balloons[id] === undefined) release(slot);
    }
    const compiled = props.anims();
    const cooked = props.assets.anims;
    for (const id of Object.keys(balloons).sort()) {
      const balloon = balloons[id]!;
      let slot = live.get(id);
      if (!slot) slot = acquire(id);

      const timing = compiled.get(balloon.icon);
      const art = cooked?.[balloon.icon];
      let src = "";
      let w = TILE;
      let h = TILE;
      if (timing && art) {
        src = art.frames[balloonFrameIndex(timing, balloon.age)] ?? "";
        w = art.w;
        h = art.h;
      }
      const anchor = props.anchor(balloon);
      const x = anchor.x + Math.floor((TILE - w) / 2);
      const y = anchor.y + TILE - anchor.height - h;
      if (x !== slot.x || y !== slot.y) {
        jump(slot.node, "translateX", x);
        jump(slot.node, "translateY", y);
        slot.x = x;
        slot.y = y;
      }
      if (w !== slot.w || h !== slot.h) {
        const old = slot.node.domAttrs?.style as SlotStyle | undefined;
        setProp(slot.node, "style", slotStyle(w, h), old);
        slot.w = w;
        slot.h = h;
      }
      if (src !== slot.src) {
        setProp(slot.node, "src", src, slot.src);
        slot.src = src;
      }
    }
  });

  onCleanup(() => {
    for (const [, slot] of [...live]) release(slot);
  });
  return root as unknown as SolidJSX.Element;
}
