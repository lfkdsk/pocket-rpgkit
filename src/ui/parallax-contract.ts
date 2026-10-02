// src/ui/parallax-contract.ts — type-only GameView parallax seam.
//
// GameView imports this contract without reaching the concrete renderer.
// Games that carry parallax art opt into ParallaxLayer from the dedicated
// package entry, so ordinary games do not bundle the renderer.

import type { Accessor, JSX as SolidJSX } from "solid-js";
import type { CameraState } from "../engine/types.ts";
import type { SessionState } from "../engine/session.ts";
import type { ParallaxAsset } from "./game-assets.ts";

export interface ParallaxLayerProps {
  state: () => SessionState;
  camera: () => CameraState;
  viewport: () => { w: number; h: number };
  mapSize: (id: string) => { w: number; h: number };
  assets: Readonly<Record<string, ParallaxAsset>>;
  active?: Accessor<boolean>;
  debugName?: string;
}

export type ParallaxLayerComponent = (props: ParallaxLayerProps) => SolidJSX.Element;
