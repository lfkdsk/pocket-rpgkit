// tests/fixtures/no-truncation/no-truncation.tsx — sim fixture for
// tests/no-truncation-battle-save.test.ts: the battle MessageBand,
// CommandGrid and ListMenu and the SaveMenu, each fed whatever props the
// test hands globalThis.__noTruncation.show(). The test passes over-long
// Latin strings (ASCII is always baked) and Chinese strings drawn from the
// cjk-text fixture's character file, which fonts.json beside this entry
// bakes from that fixture's Noto Sans CJK SC subset.

import { batch, createSignal, Show } from "solid-js";
import { mount } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { createOsk } from "@pocketjs/framework/osk";
import type { MenuState } from "../../../src/engine/save-menu.ts";
import { CommandGrid, type CommandGridProps } from "../../../src/ui/battle/CommandGrid.tsx";
import { ListMenu, type ListMenuProps } from "../../../src/ui/battle/ListMenu.tsx";
import { MessageBand, type MessageBandProps } from "../../../src/ui/battle/MessageBand.tsx";
import { SaveMenu, type SlotInfo } from "../../../src/ui/SaveMenu.tsx";

export interface NoTruncationScene {
  band?: Pick<MessageBandProps, "lines" | "revealed" | "rows">;
  grid?: Pick<CommandGridProps, "cells" | "index" | "tick">;
  list?: Pick<ListMenuProps, "rows" | "index" | "title" | "description" | "visibleRows" | "width">;
  save?: { menu: MenuState; slots: SlotInfo; title?: string };
}

declare global {
  // eslint-disable-next-line no-var
  var __noTruncation: { show(scene: NoTruncationScene): void } | undefined;
}

function Fixture() {
  const [band, setBand] = createSignal<NoTruncationScene["band"]>(undefined);
  const [grid, setGrid] = createSignal<NoTruncationScene["grid"]>(undefined);
  const [list, setList] = createSignal<NoTruncationScene["list"]>(undefined);
  const [menu, setMenu] = createSignal<MenuState>({ kind: "closed" });
  const [slots, setSlots] = createSignal<SlotInfo>([null, null, null]);
  const [title, setTitle] = createSignal<string | undefined>(undefined);
  const [code, setCode] = createSignal("");
  const osk = createOsk({ value: code, setValue: setCode, onCommit: () => {} });

  globalThis.__noTruncation = {
    show(scene) {
      batch(() => {
        setBand(scene.band);
        setGrid(scene.grid);
        setList(scene.list);
        setMenu(scene.save?.menu ?? { kind: "closed" });
        setSlots(scene.save?.slots ?? [null, null, null]);
        setTitle(scene.save?.title);
      });
    },
  };

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <Show when={list()}>
        <ListMenu
          rows={list()!.rows}
          index={list()!.index}
          title={list()!.title}
          description={list()!.description}
          visibleRows={list()!.visibleRows}
          width={list()!.width}
          style={{ insetL: 8, insetT: 8 }}
          debugName="nt-list"
        />
      </Show>
      <Show when={grid()}>
        <CommandGrid
          cells={grid()!.cells}
          index={grid()!.index}
          tick={grid()!.tick}
          style={{ insetR: 8, insetT: 8 }}
          debugName="nt-grid"
        />
      </Show>
      <Show when={band()}>
        <MessageBand
          lines={band()!.lines}
          revealed={band()!.revealed}
          rows={band()!.rows}
          legend="OK"
          width={464}
          style={{ insetL: 8, insetB: 8 }}
          debugName="nt-band"
        />
      </Show>
      <SaveMenu
        menu={menu}
        hasFs={true}
        slots={slots}
        saveCode={code}
        osk={osk}
        legend={() => "ok  back"}
        title={title()}
      />
    </View>
  );
}

mount(() => <Fixture />);
