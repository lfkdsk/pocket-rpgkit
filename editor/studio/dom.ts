/// <reference lib="dom" />
// editor/studio/dom.ts — tiny DOM helpers for Studio. No framework: panels
// render with h() and re-render on app change notifications.

export type Child = Node | string | number | false | null | undefined | Child[];
export type Props = Record<string, unknown> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = String(value);
      else if (key === "style") element.setAttribute("style", String(value));
      else if (key === "dataset") Object.assign(element.dataset, value as Record<string, string>);
      else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in element && typeof value !== "string") {
        (element as unknown as Record<string, unknown>)[key] = value;
      } else if (value === true) element.setAttribute(key, "");
      else element.setAttribute(key, String(value));
    }
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

/** Replace all children of `parent`. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.textContent = "";
  append(parent, children);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 20×20 stroke icons (hand drawn for Studio). */
const ICONS: Record<string, string> = {
  open: "M3 6h5l2 2h7v8H3z",
  save: "M4 3h10l3 3v11H4zM7 3v5h6V3M7 17v-5h7v5",
  download: "M10 3v10M6 9l4 4 4-4M4 16h12",
  undo: "M8 5 4 9l4 4M4 9h8a4 4 0 0 1 0 8H9",
  redo: "M12 5l4 4-4 4M16 9H8a4 4 0 0 0 0 8h3",
  pencil: "M4 16l1-4 8-8 3 3-8 8zM12 5l3 3",
  rect: "M4 5h12v10H4z",
  fill: "M5 10l5-6 6 6-6 6zM16 13c1 2 1 3 0 4",
  picker: "M13 3l4 4-2 2-4-4zM11 5l-7 7v3h3l7-7",
  eraser: "M3 13l7-7 6 6-5 5H7zM8 17h9",
  select: "M5 3l10 7-5 1-2 5z",
  event: "M4 4h12v12H4zM7 8h6M7 11h4",
  grid: "M3 7h14M3 13h14M7 3v14M13 3v14",
  pass: "M4 10l4 4 8-8",
  edge: "M10 3v14M6 7l4-4 4 4",
  zoomIn: "M9 4a5 5 0 1 0 0.01 0M13 13l4 4M7 9h4M9 7v4",
  zoomOut: "M9 4a5 5 0 1 0 0.01 0M13 13l4 4M7 9h4",
  fit: "M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4",
  sun: "M10 6a4 4 0 1 0 .01 0M10 1v2M10 17v2M1 10h2M17 10h2M3.5 3.5l1.5 1.5M15 15l1.5 1.5M3.5 16.5 5 15M15 5l1.5-1.5",
  moon: "M15 13A7 7 0 0 1 7 4a7 7 0 1 0 8 9z",
  history: "M4 10a6 6 0 1 0 2-4.5M4 3v3h3M10 7v3l2 2",
  plus: "M10 4v12M4 10h12",
  copy: "M7 7h9v9H7zM4 13V4h9",
  trash: "M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11",
  up: "M10 15V5M6 9l4-4 4 4",
  down: "M10 5v10M6 11l4 4 4-4",
  chevron: "M8 6l4 4-4 4",
  layers: "M10 3l7 4-7 4-7-4zM3 11l7 4 7-4",
  eye: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5zM10 8a2 2 0 1 0 .01 0",
  eyeOff: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5zM4 16 16 4",
  map: "M3 5l4-2 6 2 4-2v12l-4 2-6-2-4 2z",
  check: "M4 10l4 4 8-8",
  warn: "M10 3l8 14H2zM10 8v4M10 14v1",
  image: "M3 4h14v12H3zM3 13l4-4 4 4 2-2 4 4",
  play: "M6 4l10 6-10 6z",
  stop: "M5 5h10v10H5z",
  restart: "M4 10a6 6 0 1 0 2-4.5M4 3v3h3",
  reload: "M16 10a6 6 0 1 1-2-4.5M16 3v3h-3",
  close: "M5 5l10 10M15 5 5 15",
  agent: "M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15 14l.6 1.4L17 16l-1.4.6L15 18l-.6-1.4L13 16l1.4-.6z",
  help: "M10 2a8 8 0 1 0 .01 0M7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7M10 14.5v.5",
  search: "M9 3a6 6 0 1 0 0.01 0M13.5 13.5 18 18",
  settings: "M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.5 1.5M13.5 13.5 15 15M15 5l-1.5 1.5M6.5 13.5 5 15M10 7a3 3 0 1 0 .01 0",
  star: "M10 2.5l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.7l5-.7z",
};

export function icon(name: string, title?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.select!);
  svg.appendChild(path);
  if (title) {
    const t = document.createElementNS(SVG_NS, "title");
    t.textContent = title;
    svg.appendChild(t);
  }
  return svg;
}

/** Platform modifier label for shortcut hints. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** An icon button with a tooltip naming its shortcut. */
export function iconButton(
  name: string,
  label: string,
  onClick: () => void,
  options: { shortcut?: string; pressed?: boolean; disabled?: boolean; id?: string; text?: boolean } = {},
): HTMLButtonElement {
  const tip = options.shortcut ? `${label} (${options.shortcut})` : label;
  const button = h("button", {
    type: "button",
    class: `icon-button${options.pressed ? " pressed" : ""}${options.text ? " with-text" : ""}`,
    title: tip,
    "aria-label": label,
    ...(options.pressed === undefined ? {} : { "aria-pressed": String(options.pressed) }),
    ...(options.id ? { id: options.id } : {}),
    disabled: options.disabled === true,
    onclick: onClick,
  }, icon(name), options.text ? h("span", null, label) : null);
  button.dataset.tip = tip;
  return button;
}

/** A friendly empty panel: an icon, one line on what is missing, a hint on
 * how to get it, and optionally the button that does it. */
export function emptyState(iconName: string, title: string, hint: string, action?: { label: string; onClick: () => void; id?: string }): HTMLElement {
  return h("div", { class: "empty-state", "data-role": "empty-state" },
    h("div", { class: "empty-icon" }, icon(iconName)),
    h("div", { class: "empty-title" }, title),
    h("div", { class: "empty-hint" }, hint),
    action ? h("button", { type: "button", class: "text-button empty-action", ...(action.id ? { dataset: { action: action.id } } : {}), onclick: action.onClick }, action.label) : null);
}
