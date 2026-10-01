/// <reference lib="dom" />
// editor/studio/preview-panel.ts — the play-test panel: the game (shown by
// the host in #playtest-screen), where to start, Stop / Restart / Reload
// with the latest document, and a live readout of the game's state. The
// model is PlayTest (preview.ts); this file only renders it. The game's
// element and its messages belong to the host, never to this file.

import type { StudioApp } from "./app.ts";
import { h, icon, iconButton, MOD, replace } from "./dom.ts";
import { PREVIEW_DIRS, PREVIEW_POLL_HZ, type PlayTest, type PreviewDir } from "./preview.ts";

export const PLAYTEST_SCREEN_ID = "playtest-screen";

const STATUS_TEXT: Record<PlayTest["status"], string> = {
  closed: "Closed",
  connecting: "Starting the game…",
  loading: "Loading the document…",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

const DIR_ARROW: Record<string, string> = { down: "↓", left: "←", up: "↑", right: "→" };

export interface PlayTestPanel {
  /** Open (or bring back) the panel and play from the current choice. */
  open(): void;
  close(): void;
}

export function mountPlayTestPanel(root: HTMLElement, app: StudioApp, play: PlayTest, focusEditor: () => void): PlayTestPanel {
  const header = h("div", { class: "playtest-header" });
  const screen = h("div", { class: "playtest-screen", id: PLAYTEST_SCREEN_ID });
  const notice = h("div", { class: "playtest-notice", role: "status" });
  const controls = h("div", { class: "playtest-controls" });
  const readout = h("dl", { class: "playtest-readout", id: "playtest-readout", "aria-live": "off" });
  const hint = h("p", { class: "playtest-hint" });
  replace(root, header, h("div", { class: "playtest-stage" }, screen), notice, controls, readout, hint);

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastControls = "";
  let checkTimer: ReturnType<typeof setTimeout> | null = null;

  const startLabel = (): string => {
    const selection = app.selection;
    return selection.kind === "cell" ? `Selected cell ${app.mapId} (${selection.x}, ${selection.y})` : "Selected cell (none yet)";
  };

  /** "Reload": the latest document, from the same place; marked while the
   * running game is older than the document. */
  const reloadButton = () => {
    const button = iconButton("reload", "Reload", () => void play.play(play.target ?? play.nextTarget()), {
      id: "playtest-reload", text: true, pressed: play.stale, disabled: !!play.blocked || play.status === "connecting" || play.status === "loading",
    });
    const tip = play.stale ? "Edited since the game loaded: reload with the latest document, from the same place" : "Reload with the latest document, from the same place";
    button.title = tip;
    button.dataset.tip = tip;
    button.setAttribute("aria-label", tip);
    return button;
  };

  const renderHeader = () => {
    const status = play.status;
    replace(header,
      h("span", { class: "panel-title" }, icon("play"), " Play-test"),
      h("span", { class: `playtest-status ${status}`, id: "playtest-status" }, STATUS_TEXT[status]),
      play.expanded ? h("span", { class: "muted", title: "The sharded pack was put together as one document for the play-test." }, "pack") : null,
      h("div", { class: "spacer" }),
      reloadButton(),
      iconButton("restart", "Restart from the same place", () => void play.restart(), {
        id: "playtest-restart", disabled: !!play.blocked || !play.target || play.status === "connecting" || play.status === "loading",
      }),
      iconButton("stop", "Stop the game", () => void play.stop(), { id: "playtest-stop", disabled: play.status !== "running" }),
      iconButton("close", "Close the play-test", () => panel.close(), { id: "playtest-close" }),
    );
  };

  const renderNotice = () => {
    const message = play.blocked ?? play.error;
    notice.hidden = !message;
    notice.className = `playtest-notice ${play.blocked ? "blocked" : "error"}`;
    replace(notice, message ? [icon("warn"), h("span", { id: "playtest-error" }, message)] : null);
  };

  const renderControls = () => {
    const chapters = play.chapters();
    const choice = play.choice;
    const value = choice.kind === "chapter" ? `chapter:${choice.chapter}` : choice.kind;
    const key = JSON.stringify([value, play.dir, startLabel(), chapters.map((c) => c.id), play.status, !!play.blocked, app.session?.kind]);
    if (key === lastControls) return;
    lastControls = key;
    const from = h("select", {
      id: "playtest-from",
      "aria-label": "Start from",
      onchange: (event: Event) => {
        const picked = (event.target as HTMLSelectElement).value;
        play.choice = picked.startsWith("chapter:") ? { kind: "chapter", chapter: picked.slice(8) } : picked === "project" ? { kind: "project" } : { kind: "selection" };
        renderAll();
      },
    },
    h("option", { value: "selection", selected: value === "selection", title: "Click a cell with the select tool; with none selected, the game starts at the project start." }, startLabel()),
    h("option", { value: "project", selected: value === "project" }, "Project start"),
    chapters.length ? h("optgroup", { label: "Chapters" }, chapters.map((chapter) => h("option", { value: `chapter:${chapter.id}`, selected: value === `chapter:${chapter.id}` }, chapter.title))) : null);
    const facing = h("select", {
      id: "playtest-dir",
      "aria-label": "Facing",
      disabled: choice.kind !== "selection",
      title: choice.kind === "selection" ? "Facing at the selected cell" : "The project start and chapters bring their own facing",
      onchange: (event: Event) => {
        play.dir = (event.target as HTMLSelectElement).value as PreviewDir;
        renderAll();
      },
    }, PREVIEW_DIRS.map((dir) => h("option", { value: dir, selected: play.dir === dir }, `${DIR_ARROW[dir]} ${dir}`)));
    replace(controls,
      h("label", null, h("span", { class: "muted" }, "Start"), from),
      h("label", null, h("span", { class: "muted" }, "Facing"), facing),
      h("div", { class: "spacer" }),
      h("button", {
        type: "button",
        class: "primary-button",
        id: "playtest-play",
        title: play.blocked ?? `Load the latest document and start here (${MOD}+Enter)`,
        disabled: !!play.blocked || play.status === "connecting" || play.status === "loading",
        onclick: () => void play.play(),
      }, icon("play"), " Play"),
    );
  };

  const renderReadout = () => {
    const state = play.state;
    const rows: [string, string, string][] = state
      ? [
          ["map", "Map", state.map],
          ["position", "Position", `(${state.x}, ${state.y})${state.moving ? " moving" : ""}`],
          ["facing", "Facing", `${DIR_ARROW[state.dir] ?? ""} ${state.dir}`],
          ["frame", "Frame", String(state.frame ?? "—")],
          ["running", "Pages running", state.running === undefined ? "—" : String(state.running)],
          ["event", "Event", state.event ?? "—"],
          ["gold", "Gold", String(state.gold)],
          ["message", "Message", state.message ? state.message.text.replace(/\n/g, " ⏎ ") || state.message.kind : "—"],
        ]
      : [];
    readout.hidden = !state;
    replace(readout, rows.map(([id, label, text]) => [h("dt", { class: id === "message" ? "wide" : "" }, label), h("dd", { dataset: { field: id }, class: id === "message" ? "" : "mono", title: text }, text)]));
  };

  const renderHint = () => {
    replace(hint, play.status === "running"
      ? ["Click the game, then use the arrow keys and Enter / Z. ", h("kbd", null, "Esc"), " returns the keyboard to the editor."]
      : app.session?.kind === "pack" ? "Sharded packs are put together into one document for the play-test." : "The game runs the open document in the real engine, with the editor's stand-in art.");
  };

  const renderAll = () => {
    root.hidden = !play.open;
    root.dataset.status = play.status;
    if (!play.open) return;
    renderHeader();
    renderNotice();
    renderControls();
    renderReadout();
    renderHint();
  };

  play.on(() => {
    renderAll();
    if (play.status === "running" && !timer) timer = setInterval(() => void play.poll(), 1000 / PREVIEW_POLL_HZ);
    if (play.status !== "running" && timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  // Esc in the game: the host has taken the keyboard back; give it to the map.
  play.onRelease(focusEditor);

  app.on((reason) => {
    if (!play.open) return;
    if (reason === "selection" || reason === "map" || reason === "load") renderControls();
    if (reason === "edit" || reason === "history" || reason === "load") {
      // A size check walks the whole document; once edits settle is enough.
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        checkTimer = null;
        play.checkDocument();
      }, 400);
    }
  });

  const panel: PlayTestPanel = {
    open() {
      if (play.open) {
        void play.play();
        return;
      }
      lastControls = "";
      root.hidden = false;
      void play.openIn(PLAYTEST_SCREEN_ID);
    },
    close() {
      play.close();
      replace(screen);
      focusEditor();
    },
  };
  return panel;
}
