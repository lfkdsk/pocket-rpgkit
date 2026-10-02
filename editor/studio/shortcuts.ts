// editor/studio/shortcuts.ts — every keyboard and pointer shortcut Studio
// has, grouped for the shortcuts panel (?). Keys are written with "Mod" for
// Ctrl (⌘ on macOS); each key of a chord is its own string so the panel can
// draw it as a key cap.

export interface Shortcut {
  /** Alternatives, each a chord of key names, e.g. [["Mod", "Z"]]. */
  keys: string[][];
  action: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "File",
    items: [
      { keys: [["Mod", "S"]], action: "Save (in this browser, or back into the opened folder)" },
      { keys: [["Mod", "O"]], action: "Open a file" },
      { keys: [["Mod", "Shift", "E"]], action: "Download" },
    ],
  },
  {
    title: "Edit",
    items: [
      { keys: [["Mod", "K"]], action: "Open the command palette" },
      { keys: [["Mod", "Z"]], action: "Undo" },
      { keys: [["Mod", "Shift", "Z"], ["Mod", "Y"]], action: "Redo" },
      { keys: [["Delete"]], action: "Delete the selected event" },
      { keys: [["Mod", "D"]], action: "Duplicate the selected event" },
      { keys: [["Esc"]], action: "Cancel a drag, else clear the selection" },
    ],
  },
  {
    title: "Tools and layers",
    items: [
      { keys: [["V"], ["B"], ["R"], ["F"], ["E"], ["I"], ["N"]], action: "Select, brush, rectangle, fill, eraser, eyedropper, events" },
      { keys: [["1"], ["2"], ["3"], ["4"]], action: "Ground, upper, passage, edges layer" },
      { keys: [["Shift", "1"], ["Shift", "2"], ["Shift", "3"], ["Shift", "4"]], action: "Show or hide ground, upper, passage, events" },
      { keys: [["Right-drag"]], action: "Erase while painting" },
      { keys: [["Drag event"]], action: "Move an event (select or event tool)" },
    ],
  },
  {
    title: "View",
    items: [
      { keys: [["G"], ["P"]], action: "Grid, passage overlay" },
      { keys: [["Wheel"]], action: "Zoom around the pointer" },
      { keys: [["="], ["+"], ["-"]], action: "Zoom in or out" },
      { keys: [["0"]], action: "Fit the map" },
      { keys: [["Space", "Drag"], ["Middle-drag"], ["Shift", "Wheel"]], action: "Pan" },
    ],
  },
  {
    title: "Maps and commands",
    items: [
      { keys: [["Drag map"], ["Alt", "↑"], ["Alt", "↓"]], action: "Reorder maps (inline projects)" },
      { keys: [["↑"], ["↓"]], action: "Previous, next map or command" },
      { keys: [["Home"], ["End"]], action: "First or last map" },
      { keys: [["Drag command"]], action: "Move a command, also into or out of branches" },
      { keys: [["Alt", "↑"], ["Alt", "↓"]], action: "Move the selected command up or down" },
    ],
  },
  {
    title: "Play-test and help",
    items: [
      { keys: [["Mod", "Enter"]], action: "Play-test (from the selected cell)" },
      { keys: [["Esc"]], action: "In the play-test: give the keyboard back to the editor" },
      { keys: [["?"]], action: "Show this panel" },
    ],
  },
];

/** Key name as shown on this platform. */
export function keyLabel(key: string, mac: boolean): string {
  if (key === "Mod") return mac ? "⌘" : "Ctrl";
  if (key === "Alt" && mac) return "⌥";
  if (key === "Shift" && mac) return "⇧";
  return key;
}
