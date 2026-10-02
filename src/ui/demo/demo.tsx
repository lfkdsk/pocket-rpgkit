// src/ui/demo/demo.tsx — opt-in chapter, warp and autoplay controls for
// GameView. This module is reachable only through pocket-rpgkit/ui/demo;
// GameView depends on the tiny demo-contract seam in the opposite direction.
//
// The menu's own words are DEMO_MENU_UI_TEXT's keys (engine/ui-text.ts),
// replaced by the game's table GameView passes to render(); a translation
// wider than its row wraps and the panel grows. Error bodies are the
// developer-facing messages of the failed request and stay as thrown.

import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import type { AttractSpeed } from "../../engine/attract.ts";
import { MapNotReadyError } from "../../engine/map-repository.ts";
import type {
  GameViewDemoConfig,
  GameViewDemoHost,
  GameViewDemoRuntime,
  GameViewDemoStepResult,
} from "../demo-contract.ts";
import { Panel } from "../Panel.tsx";
import { resolveUiTheme, type UiTheme } from "../theme.ts";
import { fitBounded, marqueeOffset, windowByRows, wrapLabel, type BoundedCell } from "../list-window.ts";
import { useMarqueeTick } from "../use-marquee-tick.ts";
import { BoundedLine } from "../BoundedLine.tsx";
import { slotMeasure, TEXT_XS_SLOT } from "../text-measure.ts";
import { formatUiText, withUiText, type UiTextOverrides } from "../../engine/ui-text.ts";
import { DEMO_MENU_UI_TEXT } from "./text.ts";
import {
  chapterTapeFrames,
  demoMaps,
  loadDemoChapter,
  loadDemoWarp,
  parseDemoCoordinate,
  parseDemoSpeed,
  validateDemoOptions,
  validatedDemoRewind,
} from "./runtime.ts";
import type {
  DemoBootRequest,
  DemoChapter,
  DemoOptions,
  DemoPage,
  DemoSpawn,
  RpgkitDemoHook,
} from "./types.ts";

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitBoot: DemoBootRequest | undefined;
  // eslint-disable-next-line no-var
  var __rpgkitDemo: RpgkitDemoHook | undefined;
}

interface DemoRow {
  key: string;
  label: string;
  detail?: string;
}

type DemoMenuText = { readonly [K in keyof typeof DEMO_MENU_UI_TEXT]: string };
/** A menu message's title: one of the table's error titles. */
type DemoMessageTitle = "demo.error" | "demo.badLink";
/** A fixed sentence the demo runtime produces (a uiText template, so a
 *  translation can reword it) or an arbitrary exception's diagnostic text
 *  (kept as thrown). */
type DemoMessageBody =
  | { kind: "uiText"; key: DemoErrorKey; params?: Record<string, string> }
  | { kind: "text"; text: string };
type DemoErrorKey =
  | "demo.errorUnknownChapter"
  | "demo.errorUnknownMap"
  | "demo.errorUnknownAutoplay"
  | "demo.errorXY"
  | "demo.badLinkChooseOne"
  | "demo.badLinkSpeed";

interface DemoMenuModel {
  open: boolean;
  page: DemoPage;
  pageNumber: number;
  rows: readonly DemoRow[];
  selected: number;
  message: { title: DemoMessageTitle; body: DemoMessageBody } | null;
  busy: boolean;
  toast: "demo.warped" | null;
}

const PAGES: readonly DemoPage[] = ["chapters", "warp", "autoplay"];
const PAGE_TITLES: Readonly<Record<DemoPage, keyof typeof DEMO_MENU_UI_TEXT>> = {
  chapters: "demo.tabChapters",
  warp: "demo.tabWarp",
  autoplay: "demo.tabAutoplay",
};
/** Content width of the menu panel (430 px less border and padding) and of
 *  the toast (360 px less 10 px each side). */
const MENU_TEXT_W = 430 - 2 * (2 + 8);
const TOAST_TEXT_W = 360 - 2 * 10;
/** Font slot of `text-sm`. */
const TEXT_SM_SLOT = 1;
const SPEEDS: readonly AttractSpeed[] = [1, 2, 4];
const TOAST_FRAMES = 180;

/** The panel is capped to PANEL_CAP_H (top >= 8 on the 272 playfield); the
 *  chrome (title, tabs, legend) is bounded to a few rows each and the row
 *  list is budgeted the pixels left, scrolling by selection. */
const PANEL_CAP_H = 256;
const PANEL_FRAME = 2 * (2 + 8);
const TITLE_MAX_ROWS = 2;
const TABS_MAX_ROWS = 2;
const LEGEND_MAX_ROWS = 2;
const ERROR_TITLE_MAX_ROWS = 2;
const ROW_LABEL_MAX_ROWS = 2;
const ROW_DETAIL_MAX_ROWS = 2;
const LIST_ROW_H = 19;
const MAX_LIST_ITEMS = 8;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DemoMenu(props: { model: Accessor<DemoMenuModel>; theme?: Partial<UiTheme>; text: DemoMenuText }) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  // Read through an accessor so a new table handed to render() rewords the
  // menu on the next frame (GameView's uiText prop is reactive).
  const text = () => props.text;
  const wrapXs = (line: string, width = MENU_TEXT_W): string[] => wrapLabel(line, width, slotMeasure(TEXT_XS_SLOT));
  const sameCell = (a: BoundedCell, b: BoundedCell): boolean =>
    a.kind === b.kind && a.overflow === b.overflow &&
    a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]);
  const title = createMemo(
    () => fitBounded(text()["demo.menuTitle"], MENU_TEXT_W, TITLE_MAX_ROWS, slotMeasure(TEXT_SM_SLOT)),
    undefined,
    { equals: sameCell },
  );
  const tabs = createMemo(
    () => fitBounded(PAGES.map((page) => {
      const word = text()[PAGE_TITLES[page]];
      return page === props.model().page ? formatUiText(text()["demo.tabSelected"], { tab: word }) : word;
    }).join("  "), MENU_TEXT_W, TABS_MAX_ROWS, slotMeasure(TEXT_XS_SLOT)),
    undefined,
    { equals: sameCell },
  );
  const legend = createMemo(() => {
    const model = props.model();
    return fitBounded(text()[model.busy ? "demo.loading" : model.message ? "demo.legendBack" : "demo.legend"], MENU_TEXT_W, LEGEND_MAX_ROWS, slotMeasure(TEXT_XS_SLOT));
  }, undefined, { equals: sameCell });
  const errorTitle = createMemo(() => {
    const message = props.model().message;
    return message
      ? fitBounded(text()[message.title], MENU_TEXT_W, ERROR_TITLE_MAX_ROWS, slotMeasure(TEXT_SM_SLOT))
      : { kind: "wrap" as const, rows: [] as string[], overflow: 0 };
  }, undefined, { equals: sameCell });
  const toast = createMemo(() => {
    const key = props.model().toast;
    return key ? wrapXs(text()[key], TOAST_TEXT_W) : [""];
  });
  // A row's label and detail wrap separately (they are two replaceable
  // fields, not one concatenated line), each bounded to two rows; the row
  // grows by the taller column and scrolls sideways when longer.
  const DETAIL_W = 120;
  const LABEL_W = MENU_TEXT_W - DETAIL_W - 12;
  const rowMeasure = slotMeasure(TEXT_SM_SLOT);
  const cursorW = Math.max(rowMeasure("> "), rowMeasure("  "));
  const rowLayout = (row: DemoRow): { label: BoundedCell; detail: BoundedCell; h: number } => {
    // The clip holds both the cursor prefix and label. Fit the label to the
    // pixels left after that prefix so the terminal marquee offset really
    // brings its final character inside the clip.
    const label = fitBounded(row.label, (row.detail ? LABEL_W : MENU_TEXT_W) - cursorW, ROW_LABEL_MAX_ROWS, rowMeasure);
    const detail = row.detail ? fitBounded(row.detail, DETAIL_W, ROW_DETAIL_MAX_ROWS, rowMeasure) : { kind: "wrap" as const, rows: [] as string[], overflow: 0 };
    return { label, detail, h: LIST_ROW_H * Math.max(label.rows.length, detail.rows.length, 1) };
  };
  // The panel keeps its 242 px unless the chrome needs more, capped to
  // PANEL_CAP_H; the row list is budgeted the pixels left.
  const chromeH = () => title().rows.length * 18 + tabs().rows.length * 15 + 4 + legend().rows.length * 14;
  const panelH = createMemo(() => {
    const extra = (title().rows.length - 1) * 18 + (tabs().rows.length - 1) * 15 + (legend().rows.length - 1) * 14;
    return Math.min(PANEL_CAP_H, 242 + extra);
  });
  const listH = () => panelH() - PANEL_FRAME - chromeH();
  // The error view replaces the list; its title takes two rows (38 px) and a
  // 6 px gap, so with the chrome at its two-row maximum the body has the
  // list area's remainder: six 15 px rows. A longer body scrolls sideways.
  const errorBodyMaxRows = () => Math.max(1, Math.floor((listH() - 38 - 6) / 15));
  // The error body: a fixed runtime sentence is a uiText template (formatted
  // with the current table), an arbitrary exception's message is diagnostic
  // text. Either is bounded to the error area's rows; nothing is cut.
  const errorBody = createMemo(() => {
    const message = props.model().message;
    if (!message) return { kind: "wrap" as const, rows: [] as string[], overflow: 0 };
    const body = message.body;
    const raw = body.kind === "uiText" ? formatUiText(text()[body.key], body.params ?? {}) : body.text;
    return fitBounded(raw, MENU_TEXT_W, errorBodyMaxRows(), slotMeasure(TEXT_XS_SLOT));
  }, undefined, { equals: sameCell });
  // The row window: whole items around the cursor, narrowed to the list's
  // pixel budget. A pure function of the selection, so it never desyncs.
  const rowWindow = createMemo(() => {
    const model = props.model();
    const heights = model.rows.map((row) => rowLayout(row).h);
    const { start, end } = windowByRows(model.selected, heights, MAX_LIST_ITEMS, listH());
    return { start, rows: model.rows.slice(start, end) };
  });
  const emptyMaxRows = () => Math.max(1, Math.floor(listH() / 20));
  const emptyCell = createMemo(
    () => fitBounded(text()["demo.empty"], MENU_TEXT_W, emptyMaxRows(), slotMeasure(TEXT_SM_SLOT)),
    undefined,
    { equals: sameCell },
  );
  // One tick for every marquee cell; it rests when none scroll.
  const marqueeTick = useMarqueeTick(createMemo(() =>
    title().kind === "marquee" || tabs().kind === "marquee" || legend().kind === "marquee" ||
    errorTitle().kind === "marquee" || errorBody().kind === "marquee" || emptyCell().kind === "marquee" ||
    rowWindow().rows.some((row) => {
      const layout = rowLayout(row);
      return layout.label.kind === "marquee" || layout.detail.kind === "marquee";
    }),
  ));
  return (
    <>
      <Show when={props.model().open}>
        <View
          class="absolute inset-0 flex-row justify-center items-center"
          style={{ posType: 1, bgColor: theme().backdrop }}
          debugName="rpgkit-demo-menu-overlay"
        >
          <Panel
            theme={theme()}
            style={{ posType: 1, width: 430, height: panelH() }}
            paperClass="flex-col grow p-[8]"
            debugName="rpgkit-demo-menu-panel"
          >
            <BoundedLine
              cell={title()}
              tick={marqueeTick}
              textColor={theme().accent}
              rowH={18}
              width={MENU_TEXT_W}
              sizeClass="text-sm"
              debugName="rpgkit-demo-menu-title"
            />
            <BoundedLine
              cell={tabs()}
              tick={marqueeTick}
              textColor={theme().dim}
              rowH={15}
              width={MENU_TEXT_W}
              debugName="rpgkit-demo-menu-tabs"
            />
            <View style={{ height: 4 }} />
            <Show
              when={!props.model().message}
              fallback={
                <View class="flex-col justify-center" style={{ height: listH(), overflow: 1 }}>
                  <BoundedLine
                    cell={errorTitle()}
                    tick={marqueeTick}
                    textColor="#ff8a8a"
                    rowH={19}
                    width={MENU_TEXT_W}
                    sizeClass="text-sm"
                    debugName="rpgkit-demo-menu-error-title"
                  />
                  <View style={{ height: 6 }} />
                  <BoundedLine
                    cell={errorBody()}
                    tick={marqueeTick}
                    textColor={theme().ink}
                    rowH={15}
                    width={MENU_TEXT_W}
                    debugName="rpgkit-demo-menu-error-body"
                  />
                </View>
              }
            >
              <View class="flex-col" style={{ height: listH(), overflow: 1 }}>
                <Show when={props.model().rows.length === 0}>
                  <BoundedLine
                    cell={emptyCell()}
                    tick={marqueeTick}
                    textColor={theme().dim}
                    rowH={20}
                    width={MENU_TEXT_W}
                    sizeClass="text-sm"
                    debugName="rpgkit-demo-menu-empty"
                  />
                </Show>
                <For each={rowWindow().rows}>
                  {(row, windowIndex) => {
                    // model.rows is derived afresh on every read, so object
                    // identity cannot locate `row` in another copy. The
                    // window's stable start plus For's live index identifies
                    // the same logical row and keeps its cursor reactive.
                    const selected = () => rowWindow().start + windowIndex() === props.model().selected;
                    const layout = () => rowLayout(row);
                    const colour = () => (selected() ? theme().accent : theme().ink);
                    const prefix = () => (selected() ? "> " : "  ");
                    return (
                      <View
                        class="flex-row"
                        style={{ height: layout().h }}
                        debugName={`rpgkit-demo-menu-row-${row.key}`}
                      >
                        {layout().label.kind === "wrap" ? (
                          <Text
                            class="text-sm"
                            style={{ textColor: colour(), lineHeight: 19, height: 19 * layout().label.rows.length, width: row.detail ? LABEL_W : MENU_TEXT_W }}
                          >
                            {`${prefix()}${layout().label.rows.join("\n  ")}`}
                          </Text>
                        ) : (
                          <View style={{ width: row.detail ? LABEL_W : MENU_TEXT_W, height: LIST_ROW_H, overflow: 1 }}>
                            <Text
                              class="text-sm"
                              style={{ textColor: colour(), lineHeight: 19, height: LIST_ROW_H, shrink: 0, translateX: -marqueeOffset(layout().label.overflow, marqueeTick()) }}
                            >
                              {`${prefix()}${layout().label.rows[0]}`}
                            </Text>
                          </View>
                        )}
                        {row.detail ? (
                          layout().detail.kind === "wrap" ? (
                            <Text
                              class="text-sm"
                              style={{ textColor: colour(), lineHeight: 19, height: 19 * layout().detail.rows.length, width: DETAIL_W, textAlign: 2 }}
                            >
                              {layout().detail.rows.join("\n")}
                            </Text>
                          ) : (
                            <View style={{ width: DETAIL_W, height: LIST_ROW_H, overflow: 1 }}>
                              <Text
                                class="text-sm"
                                style={{ textColor: colour(), lineHeight: 19, height: LIST_ROW_H, shrink: 0, translateX: -marqueeOffset(layout().detail.overflow, marqueeTick()), textAlign: 2 }}
                              >
                                {layout().detail.rows[0]}
                              </Text>
                            </View>
                          )
                        ) : null}
                      </View>
                    );
                  }}
                </For>
              </View>
            </Show>
            <BoundedLine
              cell={legend()}
              tick={marqueeTick}
              textColor={theme().dim}
              rowH={14}
              width={MENU_TEXT_W}
              debugName="rpgkit-demo-menu-legend"
            />
          </Panel>
        </View>
      </Show>
      <Show when={!props.model().open && props.model().toast !== null}>
        <View
          class="absolute left-0 right-0 flex-row justify-center"
          style={{ posType: 1, insetB: 12, height: 38 + (toast().length - 1) * 15 }}
          debugName="rpgkit-demo-toast"
        >
          <Panel theme={theme()} style={{ posType: 1, width: 360, height: 38 + (toast().length - 1) * 15 }} paperClass="flex-row justify-center items-center">
            <Text class="text-xs" style={{ textColor: theme().accent, lineHeight: 15, height: 15 * toast().length }}>
              {toast().join("\n")}
            </Text>
          </Panel>
        </View>
      </Show>
    </>
  );
}

function makeRuntime(options: DemoOptions, host: GameViewDemoHost): GameViewDemoRuntime {
  const chapters = [...options.chapters];
  const chaptersById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const maps = demoMaps(host.project);
  const mapsById = new Map(maps.map((map) => [map.id, map]));
  const openButton = options.openButton ?? BTN.SELECT;
  const [open, setOpen] = createSignal(false);
  const [page, setPage] = createSignal<DemoPage>("chapters");
  const [selectedByPage, setSelectedByPage] = createSignal<Record<DemoPage, number>>({
    chapters: 0,
    warp: 0,
    autoplay: 0,
  });
  const [speed, setSpeed] = createSignal<AttractSpeed>(1);
  const [message, setMessage] = createSignal<DemoMenuModel["message"]>(null);
  const [busy, setBusy] = createSignal(false);
  const [toast, setToast] = createSignal<DemoMenuModel["toast"]>(null);
  // The game's words, set when GameView renders the menu (before any row
  // is read).
  let menuText: DemoMenuText = DEMO_MENU_UI_TEXT;
  let toastFrames = 0;
  let currentChapter: string | null = chaptersById.has(host.attract.state.mapId) ? host.attract.state.mapId : null;
  let currentChapterMap: string | null = currentChapter ? host.attract.state.mapId : null;
  let externalAction: (() => void) | null = null;
  let pending: { action: () => void; ready: boolean; error?: unknown } | null = null;

  // Listing never resolves a provider: rows are reactive and re-evaluate.
  const autoplayChapters = (): DemoChapter[] => chapters.filter((chapter) => chapterTapeFrames(chapter) !== 0);
  const rows = (): DemoRow[] => {
    switch (page()) {
      case "chapters":
        return chapters.map((chapter) => ({ key: chapter.id, label: chapter.title }));
      case "warp":
        return maps.map((map) => ({ key: map.id, label: map.title, detail: map.id === map.title ? undefined : map.id }));
      case "autoplay":
        const playable = autoplayChapters();
        return playable.length > 0
          ? [
              { key: "speed", label: formatUiText(menuText["demo.speed"], { speed: speed() }), detail: menuText["demo.speedHint"] },
              ...playable.map((chapter) => ({ key: chapter.id, label: chapter.title })),
            ]
          : [];
    }
  };
  const selected = (): number => {
    const count = rows().length;
    return count === 0 ? 0 : Math.min(selectedByPage()[page()], count - 1);
  };
  const setSelected = (value: number): void => {
    const count = rows().length;
    const next = count === 0 ? 0 : (value + count) % count;
    setSelectedByPage((all) => ({ ...all, [page()]: next }));
  };
  const fail = (title: DemoMessageTitle, error: unknown): void => {
    pending = null;
    setBusy(false);
    setOpen(true);
    // An arbitrary exception's message is diagnostic text: kept as thrown,
    // never cut (the menu wraps it and grows).
    setMessage({ title, body: { kind: "text", text: errorText(error) } });
  };
  // A fixed sentence the demo runtime produces: a uiText template, so a
  // translation rewords it. Formatted at render time with the current table.
  const failTemplate = (title: DemoMessageTitle, key: DemoErrorKey, params?: Record<string, string>): void => {
    pending = null;
    setBusy(false);
    setOpen(true);
    setMessage({ title, body: { kind: "uiText", key, params } });
  };
  const attempt = (action: () => void): boolean => {
    try {
      action();
      pending = null;
      setBusy(false);
      return true;
    } catch (error) {
      const repository = host.session.repository;
      const mapId = error instanceof MapNotReadyError ? error.mapId : null;
      if (mapId && repository?.prepare) {
        const wait = { action, ready: false as boolean, error: undefined as unknown };
        pending = wait;
        setBusy(true);
        setOpen(true);
        void repository.prepare(mapId).then(
          () => { wait.ready = true; },
          (reason) => { wait.error = reason; },
        );
        return false;
      }
      fail("demo.error", error);
      return false;
    }
  };
  const chapterAction = (chapter: DemoChapter, autoplay: boolean): (() => void) => () => {
    loadDemoChapter(host, chapter, autoplay, speed());
    currentChapter = chapter.id;
    currentChapterMap = host.attract.state.mapId;
    const chapterIndex = chapters.indexOf(chapter);
    const autoplayIndex = autoplayChapters().indexOf(chapter);
    setSelectedByPage((all) => ({
      ...all,
      chapters: chapterIndex < 0 ? all.chapters : chapterIndex,
      autoplay: autoplayIndex < 0 ? all.autoplay : autoplayIndex + 1,
    }));
    setMessage(null);
    setOpen(false);
  };
  const warpAction = (mapId: string, requested?: DemoSpawn): (() => void) => () => {
    loadDemoWarp(host, options, mapId, requested, speed());
    currentChapter = null;
    currentChapterMap = null;
    setMessage(null);
    setOpen(false);
    setToast("demo.warped");
    toastFrames = TOAST_FRAMES;
  };
  const boot = options.boot === undefined ? globalThis.__rpgkitBoot : options.boot ?? undefined;
  if (boot && typeof boot === "object") {
    const directives = [boot.chapter !== undefined, boot.map !== undefined, boot.autoplay !== undefined].filter(Boolean).length;
    if (directives > 1) {
      failTemplate("demo.badLink", "demo.badLinkChooseOne");
    } else if (boot.chapter !== undefined) {
      const chapter = typeof boot.chapter === "string" ? chaptersById.get(boot.chapter) : undefined;
      if (!chapter) failTemplate("demo.badLink", "demo.errorUnknownChapter", { id: JSON.stringify(boot.chapter) });
      else attempt(chapterAction(chapter, false));
    } else if (boot.autoplay !== undefined) {
      const chapter = typeof boot.autoplay === "string" ? chaptersById.get(boot.autoplay) : undefined;
      try {
        const nextSpeed = parseDemoSpeed(boot.speed);
        setSpeed(nextSpeed);
        if (!chapter) failTemplate("demo.badLink", "demo.errorUnknownAutoplay", { id: JSON.stringify(boot.autoplay) });
        else attempt(chapterAction(chapter, true));
      } catch (error) {
        fail("demo.badLink", error);
      }
    } else if (boot.map !== undefined) {
      if (typeof boot.map !== "string" || !mapsById.has(boot.map)) {
        failTemplate("demo.badLink", "demo.errorUnknownMap", { id: JSON.stringify(boot.map) });
      } else if ((boot.x === undefined) !== (boot.y === undefined)) {
        failTemplate("demo.badLink", "demo.errorXY");
      } else {
        try {
          const requested = boot.x === undefined
            ? undefined
            : { x: parseDemoCoordinate("x", boot.x), y: parseDemoCoordinate("y", boot.y) };
          attempt(warpAction(boot.map, requested));
        } catch (error) {
          fail("demo.badLink", error);
        }
      }
    } else if (boot.speed !== undefined || boot.x !== undefined || boot.y !== undefined) {
      failTemplate("demo.badLink", "demo.badLinkSpeed");
    }
  }

  const activate = (): boolean => {
    const index = selected();
    if (page() === "chapters") {
      const chapter = chapters[index];
      return chapter ? attempt(chapterAction(chapter, false)) : false;
    }
    if (page() === "warp") {
      const map = maps[index];
      return map ? attempt(warpAction(map.id)) : false;
    }
    if (index === 0) {
      const current = SPEEDS.indexOf(speed());
      const next = SPEEDS[(current + 1) % SPEEDS.length]!;
      setSpeed(next);
      host.attract.setPlaybackSpeed(next);
      return false;
    }
    const chapter = autoplayChapters()[index - 1];
    return chapter ? attempt(chapterAction(chapter, true)) : false;
  };

  const runtime: GameViewDemoRuntime = {
    step(buttons: number, pressed: number): GameViewDemoStepResult {
      if (toastFrames > 0) {
        // A warp can immediately open an autorun text/choice modal. That
        // modal owns the bottom of the screen, so retire the transport toast
        // instead of covering its choices until the ordinary timeout.
        if (host.getState().interp.modal !== null) {
          toastFrames = 0;
          setToast(null);
        } else {
          toastFrames--;
          if (toastFrames === 0) setToast(null);
        }
      }
      if (externalAction) {
        const action = externalAction;
        externalAction = null;
        return { consumed: true, stateChanged: attempt(action) };
      }
      if (pending) {
        if (pending.error !== undefined) {
          fail("demo.error", pending.error);
          return { consumed: true };
        }
        if (!pending.ready) return { consumed: true };
        const action = pending.action;
        pending = null;
        return { consumed: true, stateChanged: attempt(action) };
      }
      if (!open()) {
        if (pressed & openButton) {
          setOpen(true);
          setMessage(null);
          return { consumed: true };
        }
        return { consumed: false };
      }
      if (pressed & openButton || pressed & BTN.CROSS) {
        if (message()) setMessage(null);
        else setOpen(false);
        return { consumed: true };
      }
      if (message()) {
        if (pressed & BTN.CIRCLE) setMessage(null);
        return { consumed: true };
      }
      if (pressed & BTN.LEFT || pressed & BTN.RIGHT) {
        const at = PAGES.indexOf(page());
        const delta = pressed & BTN.LEFT ? -1 : 1;
        setPage(PAGES[(at + delta + PAGES.length) % PAGES.length]!);
      } else if (pressed & BTN.UP) {
        setSelected(selected() - 1);
      } else if (pressed & BTN.DOWN) {
        setSelected(selected() + 1);
      } else if (pressed & BTN.CIRCLE) {
        return { consumed: true, stateChanged: activate() };
      }
      void buttons;
      return { consumed: true };
    },
    isOpen: open,
    render(theme?: Partial<UiTheme>, uiText?: UiTextOverrides) {
      menuText = withUiText(DEMO_MENU_UI_TEXT, uiText);
      const model = (): DemoMenuModel => ({
        open: open(),
        page: page(),
        pageNumber: PAGES.indexOf(page()),
        rows: rows(),
        selected: selected(),
        message: message(),
        busy: busy(),
        toast: toast(),
      });
      return <DemoMenu model={model} theme={theme} text={menuText} />;
    },
  };

  const queueExternal = (action: () => void): void => { externalAction = action; };
  const hook: RpgkitDemoHook = {
    jump(id: string): void {
      const chapter = chaptersById.get(id);
      if (!chapter) {
        failTemplate("demo.error", "demo.errorUnknownChapter", { id: JSON.stringify(id) });
        return;
      }
      queueExternal(chapterAction(chapter, false));
    },
    warp(mapId: string, x?: number, y?: number): void {
      if (!mapsById.has(mapId)) {
        failTemplate("demo.error", "demo.errorUnknownMap", { id: JSON.stringify(mapId) });
        return;
      }
      if ((x === undefined) !== (y === undefined)) {
        failTemplate("demo.error", "demo.errorXY");
        return;
      }
      try {
        const requested = x === undefined
          ? undefined
          : { x: parseDemoCoordinate("x", String(x)), y: parseDemoCoordinate("y", String(y)) };
        queueExternal(warpAction(mapId, requested));
      } catch (error) {
        fail("demo.error", error);
      }
    },
    autoplay(id: string, requestedSpeed: AttractSpeed = speed()): void {
      const chapter = chaptersById.get(id);
      try {
        const nextSpeed = parseDemoSpeed(requestedSpeed);
        if (!chapter) {
          failTemplate("demo.error", "demo.errorUnknownAutoplay", { id: JSON.stringify(id) });
          return;
        }
        queueExternal(() => {
          setSpeed(nextSpeed);
          chapterAction(chapter, true)();
        });
      } catch (error) {
        fail("demo.error", error);
      }
    },
    current() {
      const map = host.attract.state.mapId;
      if (currentChapterMap !== null && map !== currentChapterMap) {
        currentChapter = chaptersById.has(map) ? map : null;
        currentChapterMap = currentChapter ? map : null;
      } else if (currentChapter === null && chaptersById.has(map)) {
        currentChapter = map;
        currentChapterMap = map;
      }
      return {
        chapter: currentChapter,
        map,
        autoplay: host.attract.status().phase === "attract",
        speed: host.attract.getPlaybackSpeed(),
      };
    },
  };
  globalThis.__rpgkitDemo = hook;
  onCleanup(() => {
    if (globalThis.__rpgkitDemo === hook) delete globalThis.__rpgkitDemo;
  });
  return runtime;
}

/** Validate static menu metadata now; snapshot and map validity remain an
 * atomic, visible runtime error because authored save codes may target a
 * sharded map that is not resident until selection. */
export function createDemo(options: DemoOptions): GameViewDemoConfig {
  validateDemoOptions(options);
  // Rebuild the rewind record from its four documented fields; an input
  // record's extra own keys never reach GameView's AttractController.
  const rewind = validatedDemoRewind(options.rewind);
  return { create: (host) => makeRuntime(options, host), rewind };
}
