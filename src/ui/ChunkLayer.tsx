// src/ui/ChunkLayer.tsx — shared prebaked world-layer renderer. GameView
// places 512x512 images on one row-major chunk grid; camera motion
// translates the parent node, so chunk images never rebind while the
// player walks.

import { Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { CHUNK_PX } from "../engine/tiles.ts";
import { startupProfileMark } from "../startup-profile.ts";

export interface ChunkLayerProps {
  names: readonly string[];
  columns: number;
  /** Fixed slot count keeps map swaps as image/style updates, without node
   *  creation. Omit it when the layer never swaps maps (MapView). */
  slots?: number;
  nodeRef?: (node: NodeMirror) => void;
  debugName?: string;
  /** Keeps the fixed node pool mounted; display alone changes. */
  visible?: boolean;
}

export function ChunkLayer(props: ChunkLayerProps) {
  startupProfileMark("ui-ground:start");
  const indices = Array.from({ length: props.slots ?? props.names.length }, (_, i) => i);
  const view = (
    <View
      class="absolute"
      style={{ display: props.visible === false ? 1 : 0 }}
      nodeRef={props.nodeRef}
      debugName={props.debugName}
    >
      {indices.map((i) => (
        <Image
          src={props.names[i] ?? ""}
          class="absolute w-[512] h-[512]"
          style={{
            posType: 1,
            insetL: (i % props.columns) * CHUNK_PX,
            insetT: Math.floor(i / props.columns) * CHUNK_PX,
            ...(props.slots === undefined ? {} : { display: i < props.names.length ? 0 : 1 }),
          }}
        />
      ))}
    </View>
  );
  startupProfileMark("ui-ground:end");
  return view;
}
