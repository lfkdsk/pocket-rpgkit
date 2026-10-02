// src/ui/ItemIconRow.tsx — one icon-bearing item row shared by item lists.
//
// The cursor and icon stay fixed while a long name or price marquees inside
// its own clip. A 16x16 image is centred in the 24 px first row; a 16x32
// image is bottom-anchored and clipped the same way as a choice-row walker.

import { Image, Text, View } from "@pocketjs/framework/components";
import { ITEM_ICON_GAP, ITEM_ICON_ROW_H, ITEM_ICON_W, type ItemIconRowProps } from "./item-icon.ts";

export type { ItemIconArt, ItemIconRowComponent, ItemIconRowProps } from "./item-icon.ts";

/** One visual line of an item row. The first line is 24 px tall and owns the
 * icon cell; continuation lines are normally 14 px but reserve its gutter. */
export function ItemIconRow(props: ItemIconRowProps) {
  const icon = () => props.icon;
  const iconH = () => icon()?.h ?? 16;
  const labelLeft = () => props.cursorWidth + ITEM_ICON_W + ITEM_ICON_GAP;
  const labelWidth = () => Math.max(0, props.leftWidth - labelLeft());
  const textTop = () => Math.max(0, (props.height - props.lineHeight) / 2);

  return (
    <View
      style={{ width: props.width, height: props.height, overflow: 1 }}
      debugName={props.debugName}
    >
      <Text
        class="text-xs"
        style={{
          posType: 1,
          insetL: 0,
          insetT: textTop(),
          width: props.cursorWidth,
          height: props.lineHeight,
          lineHeight: props.lineHeight,
          textColor: props.textColor,
        }}
      >
        {props.cursor}
      </Text>
      <View
        style={{
          posType: 1,
          insetL: props.cursorWidth,
          insetT: 0,
          width: ITEM_ICON_W,
          height: ITEM_ICON_ROW_H,
          overflow: 1,
          display: props.firstLine ? 0 : 1,
        }}
        debugName={`${props.debugName}-icon`}
      >
        <Image
          src={icon()?.src ?? ""}
          style={{
            posType: 1,
            insetL: 0,
            insetT: iconH() === 32 ? ITEM_ICON_ROW_H - 32 : (ITEM_ICON_ROW_H - 16) / 2,
            width: ITEM_ICON_W,
            height: iconH(),
            display: icon() ? 0 : 1,
          }}
        />
        <Text
          class="text-xs"
          style={{
            posType: 1,
            insetL: 0,
            insetT: 4,
            width: ITEM_ICON_W,
            height: ITEM_ICON_W,
            lineHeight: ITEM_ICON_W,
            textAlign: 1,
            textColor: props.dimColor,
            bgColor: props.paperColor,
            borderWidth: 1,
            borderColor: props.dimColor,
            display: icon() ? 1 : 0,
          }}
        >
          ?
        </Text>
      </View>
      <View
        style={{
          posType: 1,
          insetL: labelLeft(),
          insetT: textTop(),
          width: labelWidth(),
          height: props.lineHeight,
          overflow: 1,
        }}
      >
        <Text
          class="text-xs"
          style={{
            height: props.lineHeight,
            lineHeight: props.lineHeight,
            shrink: 0,
            translateX: -props.leftMarquee,
            textColor: props.textColor,
          }}
        >
          {props.label}
        </Text>
      </View>
      <View
        style={{
          posType: 1,
          insetR: 0,
          insetT: textTop(),
          width: props.priceWidth,
          height: props.lineHeight,
          overflow: 1,
        }}
      >
        <Text
          class="text-xs"
          style={{
            height: props.lineHeight,
            lineHeight: props.lineHeight,
            width: props.priceWidth,
            textAlign: 2,
            textColor: props.textColor,
            display: props.rightClipped ? 1 : 0,
          }}
        >
          {props.price}
        </Text>
        <Text
          class="text-xs"
          style={{
            posType: 1,
            insetL: 0,
            insetT: 0,
            height: props.lineHeight,
            lineHeight: props.lineHeight,
            shrink: 0,
            translateX: -props.rightMarquee,
            textColor: props.textColor,
            display: props.rightClipped ? 0 : 1,
          }}
        >
          {props.price}
        </Text>
      </View>
    </View>
  );
}
