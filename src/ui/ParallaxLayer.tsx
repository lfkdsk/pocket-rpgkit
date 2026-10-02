// src/ui/ParallaxLayer.tsx — deterministic map parallax below ground art.
//
// Scroll phase belongs to InterpState and advances on the reducer's 60 Hz
// reference clock. This component only projects that saved phase plus the
// current camera into a small image-node grid; it never owns a host clock.

import { onCleanup, type JSX as SolidJSX } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createElement, insertNode, setProp, type NodeMirror } from "@pocketjs/framework/renderer";
import type { ParallaxLayerProps } from "./parallax-contract.ts";
import { startupProfileMark } from "../startup-profile.ts";

export type { ParallaxLayerComponent, ParallaxLayerProps } from "./parallax-contract.ts";

interface Slot {
  node: NodeMirror;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export interface ParallaxAxisProjection {
  /** Viewport-local start of the active map's visible interval. */
  inset: number;
  /** Length of the active map's visible interval. */
  size: number;
  /** Image positions relative to `inset`. */
  positions: readonly number[];
}

const positiveMod = (value: number, size: number): number => {
  const result = value % size;
  return result < 0 ? result + size : result;
};

/** Project one parallax axis with RPG Maker MV's origin rules. `camera` is
 * map-local, so it may be negative when a connected-world viewport includes
 * a neighbour of the active map. The returned clip keeps this map-owned
 * backdrop out of those neighbouring maps. */
export const projectParallaxAxis = (
  camera: number,
  phase: number,
  image: number,
  viewport: number,
  map: number,
  loop: boolean,
  zero: boolean,
): ParallaxAxisProjection => {
  const inset = Math.max(0, Math.min(viewport, -camera));
  const edge = Math.max(0, Math.min(viewport, map - camera));
  const size = Math.max(0, edge - inset);
  if (size === 0 || image <= 0) return { inset, size, positions: [] };

  // Looping images retain MV's full-rate leading-! or half-rate ordinary
  // origin. For a non-looping whole-map picture, map travel is mapped onto
  // image overflow: both leading edges coincide at camera 0 and both
  // trailing edges coincide at the far end. This differs from MV, which
  // pins an ordinary non-looping parallax to the screen (ox 0); following
  // the map lets parallax-mapped scenes line up with their events. A
  // leading-! non-looping image remains fixed to map pixels. `inset` matters only to viewport-origin
  // sampling; the ratio path is already expressed at the visible map edge.
  const origin = loop
    ? (zero ? camera + phase : (camera + phase) / 2) + inset
    : zero
      ? camera + inset
      : (() => {
          const mapTravel = Math.max(0, map - viewport);
          const imageOverflow = Math.max(0, image - viewport);
          return mapTravel > 0
            ? Math.max(0, Math.min(mapTravel, camera)) * imageOverflow / mapTravel
            : 0;
        })();
  const first = -positiveMod(origin, image);
  const count = Math.max(1, Math.ceil((size - first) / image));
  return {
    inset,
    size,
    positions: Array.from({ length: count }, (_, index) => first + index * image),
  };
};

const nodeStyle = (w: number, h: number, visible: boolean) => ({
  posType: 1,
  insetL: 0,
  insetT: 0,
  width: w,
  height: h,
  display: visible ? 0 : 1,
});

export function ParallaxLayer(props: ParallaxLayerProps): SolidJSX.Element {
  startupProfileMark("ui-parallax:start");
  const root = createElement("view");
  setProp(root, "style", { posType: 1, insetL: 0, insetT: 0, width: 0, height: 0 });
  setProp(root, "debugName", props.debugName ?? "rpgkit-parallax");
  const slots: Slot[] = [];
  let rootX = 0;
  let rootY = 0;
  let rootW = 0;
  let rootH = 0;

  const acquire = (): Slot => {
    const node = createElement("image");
    const slot: Slot = { node, src: "", x: 0, y: 0, w: 1, h: 1, visible: false };
    setProp(node, "style", nodeStyle(1, 1, false));
    setProp(node, "debugName", `${props.debugName ?? "rpgkit-parallax"}-${slots.length}`);
    insertNode(root, node);
    slots.push(slot);
    return slot;
  };

  const hideFrom = (index: number): void => {
    for (let i = index; i < slots.length; i++) {
      const slot = slots[i]!;
      if (!slot.visible) continue;
      setProp(slot.node, "style", nodeStyle(slot.w, slot.h, false), slot.node.domAttrs?.style);
      slot.visible = false;
    }
  };

  onFrame(() => {
    if (props.active && !props.active()) return;
    const state = props.state();
    const config = state.interp.parallax;
    const art = config?.image ? props.assets[config.image] : undefined;
    if (!config || !art || art.w <= 0 || art.h <= 0) {
      hideFrom(0);
      return;
    }
    const viewport = props.viewport();
    const camera = props.camera();
    const map = props.mapSize(state.mapId);
    const x = projectParallaxAxis(camera.x, config.phaseX, art.w, viewport.w, map.w, config.loopX, config.zero === true);
    const y = projectParallaxAxis(camera.y, config.phaseY, art.h, viewport.h, map.h, config.loopY, config.zero === true);
    if (x.inset !== rootX || y.inset !== rootY || x.size !== rootW || y.size !== rootH) {
      setProp(root, "style", {
        posType: 1,
        insetL: x.inset,
        insetT: y.inset,
        width: x.size,
        height: y.size,
        overflow: 1,
      }, root.domAttrs?.style);
      rootX = x.inset;
      rootY = y.inset;
      rootW = x.size;
      rootH = y.size;
    }
    let index = 0;
    for (const py of y.positions) {
      for (const px of x.positions) {
        const slot = slots[index] ?? acquire();
        if (slot.src !== art.image) {
          setProp(slot.node, "src", art.image, slot.src);
          slot.src = art.image;
        }
        if (slot.w !== art.w || slot.h !== art.h || !slot.visible) {
          setProp(slot.node, "style", nodeStyle(art.w, art.h, true), slot.node.domAttrs?.style);
          slot.w = art.w;
          slot.h = art.h;
          slot.visible = true;
        }
        if (slot.x !== px) {
          jump(slot.node, "translateX", px);
          slot.x = px;
        }
        if (slot.y !== py) {
          jump(slot.node, "translateY", py);
          slot.y = py;
        }
        index++;
      }
    }
    hideFrom(index);
  });

  onCleanup(() => {
    for (const slot of slots) setProp(slot.node, "src", "", slot.src);
  });
  startupProfileMark("ui-parallax:end");
  return root as unknown as SolidJSX.Element;
}
