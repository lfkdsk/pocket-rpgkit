// tests/rpgkit-check-mutation.test.ts — mutation testing: take a real example
// document, apply one defect, and assert the corresponding check catches it.
// This is the discrimination guarantee: a check that passes the mutant is a
// broken check.

import { describe, expect, test } from "bun:test";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { checkLocks } from "../tools/rpgkit-check/src/dynamic/locks.ts";
import { checkFreeze } from "../tools/rpgkit-check/src/dynamic/freeze.ts";
import type { Project } from "../src/engine/types.ts";

async function loadSunstone(): Promise<Project> {
  return (await Bun.file("examples/sunstone/data/sunstone.json").json()) as Project;
}

/** Deep clone via structured JSON round-trip. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("rpgkit-check mutation: lint", () => {
  test("renaming a transfer target is caught", async () => {
    const project = await loadSunstone();
    const clean = lintProject(project);
    expect(clean.findings.filter((f) => f.severity === "error")).toEqual([]);

    const mutant = clone(project);
    // Break the north-gate's transfer target.
    const gate = mutant.maps[0]!.events!.find((e) => e.id === "north-gate")!;
    const transfer = gate.pages[0]!.commands.find((c) => c.op === "transfer") as { map: string };
    transfer.map = "atlantis";

    const report = lintProject(mutant);
    const hit = report.findings.find((f) => f.check === "lint/transfer-target-missing");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  test("removing a switch set is caught as read-never-set", async () => {
    const project = await loadSunstone();
    // `rune-lit` is set by exactly one switch op (forest/rune-stone) and read
    // by a cave/rune-gate `if` guard, so removing the setter leaves it read
    // but never set.
    const targetId = "rune-lit";
    const clean = lintProject(project);
    const cleanHit = clean.findings.find(
      (f) => f.check === "lint/switch-read-never-set" && f.message.includes(JSON.stringify(targetId)),
    );
    expect(cleanHit).toBeUndefined();

    const mutant = clone(project);
    let removed = false;
    outer: for (const map of mutant.maps) {
      for (const ev of map.events ?? []) {
        for (const page of ev.pages) {
          const idx = page.commands.findIndex((c) => c.op === "switch" && c.id === targetId);
          if (idx >= 0) {
            page.commands.splice(idx, 1);
            removed = true;
            break outer;
          }
        }
      }
    }
    expect(removed).toBe(true);

    const report = lintProject(mutant);
    const hit = report.findings.find(
      (f) => f.check === "lint/switch-read-never-set" && f.message.includes(JSON.stringify(targetId)),
    );
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });
});

describe("rpgkit-check mutation: locks", () => {
  test("adding a lockInput without unlock is caught", async () => {
    const project = await loadSunstone();
    const clean = checkLocks(project);
    expect(clean.findings).toEqual([]);

    const mutant = clone(project);
    // Add an autorun page that locks input and never unlocks.
    mutant.maps[0]!.events!.push({
      id: "mutant-perma-lock",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "autorun",
          commands: [
            { op: "lockInput" },
            { op: "text", lines: ["locked forever"] },
          ],
        },
      ],
    });
    const report = checkLocks(mutant, { frames: 600 });
    const hit = report.rows.find((r) => r.event === "mutant-perma-lock");
    expect(hit).toBeDefined();
    expect(hit!.outcome).toBe("unresolved");
    expect(report.findings.some((f) => f.check === "locks/permanent-lock")).toBe(true);
  });
});

describe("rpgkit-check mutation: freeze", () => {
  test("an autorun page with a permanent lock flags the map", async () => {
    const project = await loadSunstone();
    const clean = checkFreeze(project, { windowFrames: 300 });
    expect(clean.findings).toEqual([]);

    const mutant = clone(project);
    mutant.maps[0]!.events!.push({
      id: "mutant-freeze",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "autorun",
          commands: [
            { op: "lockInput" },
            { op: "text", lines: ["locked forever"] },
          ],
        },
      ],
    });
    const report = checkFreeze(mutant, { windowFrames: 300 });
    const hit = report.rows.find((r) => r.map === "village");
    expect(hit).toBeDefined();
    expect(hit!.inputLocked || hit!.blocking).toBe(true);
  });
});
