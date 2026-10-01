// src/ui/LazyImage.tsx — opt-in, bounded TILESET-backed images.
//
// Plain string sources keep PocketJS's legacy registered ui:img path. A tile
// descriptor is loaded only when this component becomes active, then borrowed
// from a caller-owned cache. Cache eviction owns freeTexture; image nodes are
// always detached from a handle before their borrow is released.

import { createRenderEffect, onCleanup, type JSX as SolidJSX } from "solid-js";
import { Image, type ImageProps } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { setProp, type NodeMirror } from "@pocketjs/framework/renderer";
import {
  TileTextureCache,
  type RpgImageSource,
} from "./tile-texture-cache.ts";
export type {
  RpgImageSource,
  TileImageSource,
  TileTextureCacheOptions,
  TileTextureCacheStats,
} from "./tile-texture-cache.ts";
export { TileTextureCache } from "./tile-texture-cache.ts";

export interface LazyImageProps extends Omit<ImageProps, "src"> {
  src: RpgImageSource;
  /** Shared battle/scene cache. Omit for an isolated one-component cache. */
  cache?: TileTextureCache;
  /** False detaches and unpins tile sources. Legacy images are hidden too. */
  active?: boolean;
}

/** One image primitive that accepts both legacy eager names and tile refs. */
export function LazyImage(props: LazyImageProps): SolidJSX.Element {
  let node: NodeMirror | undefined;
  const owned = props.cache ? undefined : new TileTextureCache({ maxEntries: 8 });
  const cache = props.cache ?? owned!;
  let binding: { kind: "legacy"; src: string } | { kind: "tile"; ref: string } | undefined;

  const detach = (): void => {
    if (!node || !binding) return;
    getOps().setImage(node.id, -1);
    if (binding.kind === "tile") cache.release(binding.ref);
    binding = undefined;
  };

  const result = (
    <Image
      ref={(value) => {
        node = value;
        const forwarded = props.ref;
        if (typeof forwarded === "function") forwarded(value);
        else if (forwarded && "current" in forwarded) forwarded.current = value;
      }}
      nodeRef={props.nodeRef}
      class={props.class}
      style={props.style}
      debugName={props.debugName}
    />
  );
  createRenderEffect(() => {
    const source = props.src;
    const active = props.active ?? true;
    const nextKind = typeof source === "string" ? "legacy" : "tile";
    const nextRef = typeof source === "string" ? source : source.ref;
    if (!active || nextRef === "") {
      detach();
      return;
    }
    if (binding?.kind === nextKind && (binding.kind === "legacy" ? binding.src : binding.ref) === nextRef) return;
    detach();
    if (!node) return;
    if (typeof source === "string") {
      setProp(node, "src", source);
      binding = { kind: "legacy", src: source };
    } else {
      const handle = cache.acquire(source);
      getOps().setImage(node.id, handle);
      binding = { kind: "tile", ref: source.ref };
    }
  });
  onCleanup(() => {
    detach();
    owned?.clear();
  });
  return result;
}
