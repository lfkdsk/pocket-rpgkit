import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EDIT_COMMANDS } from "../editor/api/types.ts";
import { mapDropIndex } from "../editor/studio/map-tree.ts";
import { SHORTCUT_GROUPS } from "../editor/studio/shortcuts.ts";

describe("Studio polish contracts", () => {
  test("filtered no-op drops do not cross hidden maps", () => {
    const order = ["village", "hidden-forest", "cave", "hidden-end"];
    const shown = ["village", "cave"];

    // Either side of the current visible position remains a true no-op,
    // even though the full order has a hidden map in that gap.
    expect(mapDropIndex(order, shown, "village", 0)).toBeNull();
    expect(mapDropIndex(order, shown, "village", 1)).toBeNull();
    expect(mapDropIndex(order, shown, "cave", 1)).toBeNull();
    expect(mapDropIndex(order, shown, "cave", 2)).toBeNull();

    // A visible-order change still anchors to the visible neighbour.
    expect(mapDropIndex(order, shown, "village", 2)).toBe(2);
    expect(mapDropIndex(order, shown, "cave", 0)).toBe(0);
  });

  test("the shortcuts panel lists keyboard zoom and map-list endpoints", () => {
    const view = SHORTCUT_GROUPS.find((group) => group.title === "View")!;
    const maps = SHORTCUT_GROUPS.find((group) => group.title === "Maps and commands")!;
    expect(view.items).toContainEqual({ keys: [["="], ["+"], ["-"]], action: "Zoom in or out" });
    expect(maps.items).toContainEqual({ keys: [["Home"], ["End"]], action: "First or last map" });
  });

  test("the protocol operation total and names stay in sync", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "docs", "protocols.md"), "utf8");
    const match = docs.match(/- \*\*Operations\*\* \((\d+)\):([\s\S]*?)\n- \*\*Addresses/);
    expect(match).not.toBeNull();
    const documented = [...match![2]!.matchAll(/`([^`]+)`/g)]
      .map((item) => item[1])
      .filter((name): name is (typeof EDIT_COMMANDS)[number] => EDIT_COMMANDS.includes(name as (typeof EDIT_COMMANDS)[number]));
    expect(Number(match![1])).toBe(EDIT_COMMANDS.length);
    expect([...documented].sort()).toEqual([...EDIT_COMMANDS].sort());
  });
});
