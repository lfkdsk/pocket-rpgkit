// tests/rpgkit-check-labels.test.ts — rpgkit-check on label/jumpLabel:
// a jump to a name with no label in the same page or common event is a
// warning; labels at any nesting depth resolve; common events are their own
// label scope.

import { describe, expect, test } from "bun:test";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import type { Command, GameEvent, MapDef, Page, Project } from "../src/engine/types.ts";
import type { Finding } from "../tools/rpgkit-check/src/finding.ts";

function grassMap(id: string, events: GameEvent[] = [], size = 6): MapDef {
  return {
    id,
    name: id,
    width: size,
    height: size,
    sheets: ["grass"],
    ground: new Array<string>(size * size).fill("grass.0"),
    events,
  };
}

function project(events: GameEvent[], extra: Partial<Project> = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Labels fixture",
    tileSize: 16,
    start: { map: "m1", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    maps: [grassMap("m1", events)],
    ...extra,
  };
}

function action(commands: Command[]): GameEvent {
  const page: Page = { trigger: "action", commands };
  return { id: "ev", x: 4, y: 4, pages: [page] };
}

function of(findings: readonly Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

describe("rpgkit-check: jumpLabel target", () => {
  test("a jump to a missing label is a warning", () => {
    const report = lintProject(project([action([{ op: "jumpLabel", name: "gone" }])]));
    const found = of(report.findings, "lint/jump-label-missing");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.loc.commandPath).toEqual([0]);
  });

  test("a jump to a label in the same list is fine, at any nesting depth", () => {
    const report = lintProject(project([action([
      { op: "jumpLabel", name: "deep" },
      { op: "if", if: { kind: "switch", id: "s", value: true }, then: [
        { op: "choices", prompt: "?", options: [{ text: "a", commands: [{ op: "label", name: "deep" }] }] },
      ] },
    ])]));
    expect(of(report.findings, "lint/jump-label-missing")).toEqual([]);
  });

  test("the first label with a name resolves; a second jump to a still-existing name is fine", () => {
    const report = lintProject(project([action([
      { op: "label", name: "a" },
      { op: "jumpLabel", name: "a" },
      { op: "label", name: "a" },
      { op: "jumpLabel", name: "a" },
    ])]));
    expect(of(report.findings, "lint/jump-label-missing")).toEqual([]);
  });

  test("a common event is its own label scope", () => {
    // The jump resolves inside the common event; the page's label is invisible.
    const report = lintProject(project(
      [action([{ op: "common", id: "c" }, { op: "label", name: "page-only" }])],
      { commonEvents: [{ id: "c", trigger: "none", commands: [
        { op: "jumpLabel", name: "ce-label" },
        { op: "label", name: "ce-label" },
      ] }] },
    ));
    expect(of(report.findings, "lint/jump-label-missing")).toEqual([]);
  });

  test("a jump in a common event to a label only in the caller is a warning", () => {
    const report = lintProject(project(
      [action([{ op: "common", id: "c" }, { op: "label", name: "page-only" }])],
      { commonEvents: [{ id: "c", trigger: "none", commands: [{ op: "jumpLabel", name: "page-only" }] }] },
    ));
    const found = of(report.findings, "lint/jump-label-missing");
    expect(found).toHaveLength(1);
    expect(found[0]!.loc.common).toBe("c");
  });

  test("a label with no jump is silent", () => {
    const report = lintProject(project([action([{ op: "label", name: "unused" }])]));
    expect(of(report.findings, "lint/jump-label-missing")).toEqual([]);
  });
});
