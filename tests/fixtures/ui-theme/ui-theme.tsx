// tests/fixtures/ui-theme/ui-theme.tsx — sim fixture for the themeable
// DialogBox and SaveMenu (tests/ui-theme-sim.test.ts). A black screen with
// one DialogBox and one SaveMenu; the test picks a named scene (scenes.ts)
// through globalThis.__uiFixture.show() and renders the next frame.

import { batch, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { createOsk } from "@pocketjs/framework/osk";
import type { Modal } from "../../../src/engine/interpreter.ts";
import type { MenuState } from "../../../src/engine/save-menu.ts";
import { DialogBox, SaveMenu, type UiTheme } from "../../../src/ui/index.ts";
import { ChoiceIconBox, resolveChoiceIcon } from "../../../src/ui/ChoiceIconBox.tsx";
import { ICON_ART, ICON_SPRITES } from "./icons.ts";
import { CODE, FACES, ITEMS, MENUS, MODALS, SAVE_TITLE, SLOTS, THEMES, type FixtureScene } from "./scenes.ts";

declare global {
  // eslint-disable-next-line no-var
  var __uiFixture: { show(scene: FixtureScene): void } | undefined;
  /** Boot-time switch: leave DialogBox's opt-in icon box out. */
  // eslint-disable-next-line no-var
  var __uiFixtureNoIconBox: boolean | undefined;
}

function Fixture() {
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [menu, setMenu] = createSignal<MenuState>(MENUS.closed);
  const [theme, setTheme] = createSignal<Partial<UiTheme> | undefined>(undefined);
  const [faces, setFaces] = createSignal<Record<string, string> | undefined>(undefined);
  const [items, setItems] = createSignal<Record<string, { name: string }> | undefined>(undefined);
  const [title, setTitle] = createSignal<string | undefined>(undefined);
  const [code, setCode] = createSignal("");
  const legend = () => (modal()?.kind === "choices" ? "ok  back" : "next");
  const osk = createOsk({ value: code, setValue: setCode, onCommit: () => {} });

  globalThis.__uiFixture = {
    show(scene) {
      batch(() => {
        const next = MODALS[scene.modal ?? "none"];
        setModal(next?.kind === "text" && scene.revealed !== undefined
          ? { ...next, revealed: scene.revealed, complete: scene.revealed >= next.total }
          : next);
        setMenu(MENUS[scene.menu ?? "closed"]);
        setTheme(THEMES[scene.theme ?? "default"]);
        setFaces(scene.faces ? FACES : undefined);
        setItems(scene.items ? ITEMS : undefined);
        setTitle(scene.title ? SAVE_TITLE : undefined);
        setCode(CODE);
      });
    },
  };

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <DialogBox
        modal={modal}
        legend={legend}
        viewportWidth={480}
        theme={theme()}
        faces={faces()}
        items={items()}
        choiceIconBox={globalThis.__uiFixtureNoIconBox ? undefined : ChoiceIconBox}
        choiceIcon={(icon) => resolveChoiceIcon(icon, ICON_SPRITES, ICON_ART)}
      />
      <SaveMenu
        menu={menu}
        hasFs={true}
        slots={() => SLOTS}
        saveCode={code}
        osk={osk}
        legend={legend}
        theme={theme()}
        title={title()}
      />
    </View>
  );
}

mount(() => <Fixture />);
