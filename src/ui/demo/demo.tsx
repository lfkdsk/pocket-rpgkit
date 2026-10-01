// src/ui/demo/demo.tsx — opt-in chapter, warp and autoplay controls for
// GameView. This module is reachable only through pocket-rpgkit/ui/demo;
// GameView depends on the tiny demo-contract seam in the opposite direction.

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
import {
  chapterTapeFrames,
  demoMaps,
  loadDemoChapter,
  loadDemoWarp,
  parseDemoCoordinate,
  parseDemoSpeed,
  validateDemoOptions,
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

interface DemoMenuModel {
  open: boolean;
  page: DemoPage;
  pageNumber: number;
  rows: readonly DemoRow[];
  selected: number;
  message: { title: string; body: string } | null;
  busy: boolean;
  toast: string | null;
}

const PAGES: readonly DemoPage[] = ["chapters", "warp", "autoplay"];
const PAGE_TITLES: Readonly<Record<DemoPage, string>> = {
  chapters: "CHAPTERS",
  warp: "MAP WARP",
  autoplay: "AUTOPLAY",
};
const SPEEDS: readonly AttractSpeed[] = [1, 2, 4];
const TOAST_FRAMES = 180;
const VISIBLE_ROWS = 8;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DemoMenu(props: { model: Accessor<DemoMenuModel>; theme?: Partial<UiTheme> }) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const firstVisible = createMemo(() => {
    const model = props.model();
    return Math.max(0, Math.min(model.selected - 3, model.rows.length - VISIBLE_ROWS));
  });
  const visible = createMemo(() => props.model().rows.slice(firstVisible(), firstVisible() + VISIBLE_ROWS));
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
            style={{ posType: 1, width: 430, height: 242 }}
            paperClass="flex-col grow p-[8]"
            debugName="rpgkit-demo-menu-panel"
          >
            <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-demo-menu-title">
              DEMO CONTROLS
            </Text>
            <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 15, height: 15 }} debugName="rpgkit-demo-menu-tabs">
              {PAGES.map((page) => page === props.model().page ? `[${PAGE_TITLES[page]}]` : PAGE_TITLES[page]).join("  ")}
            </Text>
            <View style={{ height: 4 }} />
            <Show
              when={!props.model().message}
              fallback={
                <View class="flex-col grow justify-center">
                  <Text class="text-sm" style={{ textColor: "#ff8a8a", lineHeight: 19, height: 19 }} debugName="rpgkit-demo-menu-error-title">
                    {props.model().message?.title ?? "ERROR"}
                  </Text>
                  <View style={{ height: 6 }} />
                  <Text class="text-xs" style={{ textColor: theme().ink, lineHeight: 15, height: 45 }} debugName="rpgkit-demo-menu-error-body">
                    {props.model().message?.body ?? ""}
                  </Text>
                </View>
              }
            >
              <View class="flex-col grow">
                <Show when={props.model().rows.length === 0}>
                  <Text class="text-sm" style={{ textColor: theme().dim, lineHeight: 20, height: 20 }}>
                    No entries configured.
                  </Text>
                </Show>
                <For each={visible()}>
                  {(row, localIndex) => {
                    const absolute = () => firstVisible() + localIndex();
                    const selected = () => absolute() === props.model().selected;
                    return (
                      <Text
                        class="text-sm"
                        style={{ textColor: selected() ? theme().accent : theme().ink, lineHeight: 19, height: 19 }}
                        debugName={`rpgkit-demo-menu-row-${row.key}`}
                      >
                        {`${selected() ? "> " : "  "}${row.label}${row.detail ? `  ${row.detail}` : ""}`}
                      </Text>
                    );
                  }}
                </For>
              </View>
            </Show>
            <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-demo-menu-legend">
              {props.model().busy ? "Loading map..." : props.model().message ? "A/B: back" : "left/right: page   up/down: choose   A: select   B: close"}
            </Text>
          </Panel>
        </View>
      </Show>
      <Show when={!props.model().open && props.model().toast !== null}>
        <View class="absolute left-0 right-0 flex-row justify-center" style={{ posType: 1, insetB: 12 }} debugName="rpgkit-demo-toast">
          <Panel theme={theme()} style={{ posType: 1, width: 360, height: 38 }} paperClass="flex-row justify-center items-center">
            <Text class="text-xs" style={{ textColor: theme().accent, lineHeight: 15, height: 15 }}>
              {props.model().toast ?? ""}
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
  const [toast, setToast] = createSignal<string | null>(null);
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
              { key: "speed", label: `Speed ${speed()}x`, detail: "A: change" },
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
  const fail = (title: string, error: unknown): void => {
    pending = null;
    setBusy(false);
    setOpen(true);
    setMessage({ title, body: errorText(error).slice(0, 180) });
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
      fail("DEMO ERROR", error);
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
    setToast("Warped — story state may not match this map");
    toastFrames = TOAST_FRAMES;
  };
  const boot = options.boot === undefined ? globalThis.__rpgkitBoot : options.boot ?? undefined;
  if (boot && typeof boot === "object") {
    const directives = [boot.chapter !== undefined, boot.map !== undefined, boot.autoplay !== undefined].filter(Boolean).length;
    if (directives > 1) {
      fail("BAD DEMO LINK", "choose exactly one of chapter, map, or autoplay");
    } else if (boot.chapter !== undefined) {
      const chapter = typeof boot.chapter === "string" ? chaptersById.get(boot.chapter) : undefined;
      if (!chapter) fail("BAD DEMO LINK", `unknown chapter ${JSON.stringify(boot.chapter)}`);
      else attempt(chapterAction(chapter, false));
    } else if (boot.autoplay !== undefined) {
      const chapter = typeof boot.autoplay === "string" ? chaptersById.get(boot.autoplay) : undefined;
      try {
        const nextSpeed = parseDemoSpeed(boot.speed);
        setSpeed(nextSpeed);
        if (!chapter) fail("BAD DEMO LINK", `unknown autoplay chapter ${JSON.stringify(boot.autoplay)}`);
        else attempt(chapterAction(chapter, true));
      } catch (error) {
        fail("BAD DEMO LINK", error);
      }
    } else if (boot.map !== undefined) {
      try {
        if (typeof boot.map !== "string" || !mapsById.has(boot.map)) throw new Error(`unknown map ${JSON.stringify(boot.map)}`);
        const oneCoordinate = (boot.x === undefined) !== (boot.y === undefined);
        if (oneCoordinate) throw new Error("x and y must be supplied together");
        const requested = boot.x === undefined
          ? undefined
          : { x: parseDemoCoordinate("x", boot.x), y: parseDemoCoordinate("y", boot.y) };
        attempt(warpAction(boot.map, requested));
      } catch (error) {
        fail("BAD DEMO LINK", error);
      }
    } else if (boot.speed !== undefined || boot.x !== undefined || boot.y !== undefined) {
      fail("BAD DEMO LINK", "speed requires autoplay; x and y require map");
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
        toastFrames--;
        if (toastFrames === 0) setToast(null);
      }
      if (externalAction) {
        const action = externalAction;
        externalAction = null;
        return { consumed: true, stateChanged: attempt(action) };
      }
      if (pending) {
        if (pending.error !== undefined) {
          fail("DEMO ERROR", pending.error);
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
    render(theme?: Partial<UiTheme>) {
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
      return <DemoMenu model={model} theme={theme} />;
    },
  };

  const queueExternal = (action: () => void): void => { externalAction = action; };
  const hook: RpgkitDemoHook = {
    jump(id: string): void {
      const chapter = chaptersById.get(id);
      if (!chapter) {
        fail("DEMO ERROR", `unknown chapter ${JSON.stringify(id)}`);
        return;
      }
      queueExternal(chapterAction(chapter, false));
    },
    warp(mapId: string, x?: number, y?: number): void {
      if (!mapsById.has(mapId)) {
        fail("DEMO ERROR", `unknown map ${JSON.stringify(mapId)}`);
        return;
      }
      if ((x === undefined) !== (y === undefined)) {
        fail("DEMO ERROR", "x and y must be supplied together");
        return;
      }
      try {
        const requested = x === undefined
          ? undefined
          : { x: parseDemoCoordinate("x", String(x)), y: parseDemoCoordinate("y", String(y)) };
        queueExternal(warpAction(mapId, requested));
      } catch (error) {
        fail("DEMO ERROR", error);
      }
    },
    autoplay(id: string, requestedSpeed: AttractSpeed = speed()): void {
      const chapter = chaptersById.get(id);
      try {
        const nextSpeed = parseDemoSpeed(requestedSpeed);
        if (!chapter) {
          fail("DEMO ERROR", `unknown autoplay chapter ${JSON.stringify(id)}`);
          return;
        }
        queueExternal(() => {
          setSpeed(nextSpeed);
          chapterAction(chapter, true)();
        });
      } catch (error) {
        fail("DEMO ERROR", error);
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
  return { create: (host) => makeRuntime(options, host) };
}
