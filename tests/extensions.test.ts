import { describe, expect, test } from "bun:test";
import { loadProject, serializeProject } from "../editor/engine/document.ts";
import { AttractController } from "../src/engine/attract.ts";
import { rngNext } from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  encodeEnvelope,
  fnv1aText,
  SaveError,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import type { Command, GameEvent, JsonValue, MapDef, Project } from "../src/engine/types.ts";

const TILE = "plain.0";

function map(id: string, commands: Command[] = [], condition?: GameEvent["pages"][number]["condition"]): MapDef {
  return {
    id,
    name: id,
    width: 6,
    height: 6,
    sheets: ["plain"],
    ground: new Array(36).fill(TILE),
    events: commands.length || condition ? [{
      id: "event",
      x: 1,
      y: 1,
      pages: [{ trigger: "autorun", commands, ...(condition ? { condition } : {}) }],
    }] : [],
  };
}

function project(commands: Command[], extraMaps: MapDef[] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "extensions",
    tileSize: 16,
    start: { map: "a", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map("a", commands), ...extraMaps],
  };
}

function step(session: Session, state: SessionState): SessionState {
  return stepSession(session, state, { buttons: 0 });
}

describe("KB1 extension commands and conditions", () => {
  test("a command reads/writes ext and variables and draws only from the saved session RNG", () => {
    const p = project([
      { op: "ext", call: "demo.increment", args: { amount: 2 } },
      {
        op: "if",
        if: { kind: "ext", call: "demo.at_least", args: { count: 2 } },
        then: [{ op: "switch", id: "condition-passed", value: true }],
      },
    ]);
    const session = createSession(p, 60, {
      extensions: {
        initial: { count: 0 },
        commands: {
          "demo.increment": (context, args) => {
            const ext = context.ext as { count: number };
            const amount = (args as { amount: number }).amount;
            return {
              ext: { count: ext.count + amount },
              writes: { "demo.roll": Math.floor(context.random() * 1_000_000) },
            };
          },
        },
        conditions: {
          "demo.at_least": (context, args) =>
            (context.ext as { count: number }).count >= (args as { count: number }).count,
        },
      },
    });
    const before = startSession(p, session);
    const retainedBefore = JSON.stringify(before);
    const expected = rngNext(before.sw.rng);
    const after = step(session, before);

    expect(JSON.stringify(before)).toBe(retainedBefore);
    expect(before.ext).toEqual({ count: 0 });
    expect(after.ext).toEqual({ count: 2 });
    expect(after.sw.variables["demo.roll"]).toBe(Math.floor(expected.value * 1_000_000));
    expect(after.sw.rng).toBe(expected.next);
    expect(after.sw.switches["condition-passed"]).toBe(true);
  });

  test("createSession lists every unregistered call; preview no-op is explicit", () => {
    const commands: Command[] = [
      { op: "ext", call: "demo.missing_command", args: null },
      {
        op: "if",
        if: { kind: "ext", call: "demo.missing_condition", args: [] },
        then: [{ op: "switch", id: "wrong", value: true }],
        else: [{ op: "switch", id: "preview-false", value: true }],
      },
    ];
    const p = project(commands);
    expect(() => createSession(p)).toThrow(
      "createSession: unregistered extension calls: command demo.missing_command, condition demo.missing_condition",
    );

    const preview = createSession(p, 60, { extensions: { allowUnknown: true } });
    const state = step(preview, startSession(p, preview));
    expect(state.ext).toBeNull();
    expect(state.sw.switches["preview-false"]).toBe(true);
    expect(state.sw.switches["wrong"]).toBeUndefined();
  });

  test("codec, validator, checksum, JSON round-trip and restore all cover ext", () => {
    const p = project([{ op: "ext", call: "demo.increment", args: 3 }]);
    const options = {
      initial: { count: 1 } satisfies JsonValue,
      commands: {
        "demo.increment": (context: { ext: JsonValue }) => ({
          ext: { count: (context.ext as { count: number }).count + 3 },
        }),
      },
      codec: {
        encode: (value: JsonValue): JsonValue => ({ payload: value }),
        decode: (value: JsonValue): JsonValue => (value as { payload: JsonValue }).payload,
      },
      validate: (value: JsonValue) =>
        typeof (value as { count?: unknown } | null)?.count === "number" || "count must be numeric",
    };
    const session = createSession(p, 60, { extensions: options });
    const state = step(session, startSession(p, session));
    const snapshot = createSessionSnapshot(session, state, 0);
    expect(snapshot.ext).toEqual({ payload: { count: 4 } });

    const bytes = encodeEnvelope(snapshot);
    const restored = restoreSessionEnvelope(session, bytes);
    expect(restored.ext).toEqual({ count: 4 });
    expect(restored.scene).toBeNull();
    expect(canonicalJson(createSessionSnapshot(session, restored, 0))).toBe(canonicalJson(snapshot));

    const changed = { ...snapshot, ext: { payload: { count: 5 } } };
    expect(JSON.parse(encodeEnvelope(changed)).checksum).not.toBe(JSON.parse(bytes).checksum);

    const invalid = encodeEnvelope({ ...snapshot, ext: { payload: { count: "bad" } } });
    try {
      restoreSessionEnvelope(session, invalid);
      throw new Error("expected invalid extension save to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError);
      expect((error as SaveError).code).toBe("shape");
      expect((error as Error).message).toContain("count must be numeric");
    }
  });

  test("a checksum-valid older v1 save hydrates the absent extension slot as null", () => {
    const p = project([]);
    const session = createSession(p);
    const current = JSON.parse(
      encodeEnvelope(createSessionSnapshot(session, startSession(p, session), 0)),
    ) as { state: Record<string, unknown>; checksum: string };
    delete current.state.ext;
    current.checksum = fnv1aText(canonicalJson(current.state));

    expect(restoreSessionEnvelope(session, JSON.stringify(current)).ext).toBeNull();
  });

  test("attract rewind refolds extension state and RNG from a clean session", () => {
    const p = project([{ op: "ext", call: "demo.tick", args: null }]);
    const extensions = {
      initial: { count: 0, rolls: [] } satisfies JsonValue,
      commands: {
        "demo.tick": (context: { ext: JsonValue; random(): number }) => {
          const ext = context.ext as { count: number; rolls: number[] };
          return {
            ext: {
              count: ext.count + 1,
              rolls: [...ext.rolls, Math.floor(context.random() * 256)],
            },
          };
        },
      },
    };
    const rewound = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      extensions,
    });
    const fresh = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      extensions,
    });
    rewound.startPlay();
    fresh.startPlay();
    for (let i = 0; i < 5; i++) rewound.step(0);
    for (let i = 0; i < 3; i++) fresh.step(0);
    rewound.step(0x0100);

    expect(rewound.length).toBe(3);
    expect(rewound.state.ext).toEqual({ count: 3, rolls: expect.any(Array) });
    expect(rewound.state).toEqual(fresh.state);
  });

  test("transfer resolves map, coordinates and direction from live variables", () => {
    const p = project([
      { op: "ext", call: "demo.destination", args: null },
      {
        op: "transfer",
        map: { variable: "dest.map" },
        x: { variable: "dest.x" },
        y: { variable: "dest.y" },
        dir: { variable: "dest.dir" },
      },
    ], [map("b")]);
    const session = createSession(p, 60, {
      extensions: {
        commands: {
          "demo.destination": () => ({
            writes: { "dest.map": "b", "dest.x": 4, "dest.y": 3, "dest.dir": "left" },
          }),
        },
      },
    });
    const state = step(session, startSession(p, session));
    expect(state.mapId).toBe("b");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([4, 3, 1]);
  });

  for (const scenario of [
    {
      name: "an unset map variable",
      variables: { "dest.x": 4, "dest.y": 3, "dest.dir": "left" },
      message: "map variable must hold a non-empty string",
    },
    {
      name: "a non-integer coordinate variable",
      variables: { "dest.map": "b", "dest.x": 1.5, "dest.y": 3, "dest.dir": "left" },
      message: "coordinate variables must hold non-negative integers",
    },
    {
      name: "an invalid direction variable",
      variables: { "dest.map": "b", "dest.x": 4, "dest.y": 3, "dest.dir": "diagonal" },
      message: "direction variable must hold down|left|right|up|keep",
    },
    {
      name: "a non-existent map variable",
      variables: { "dest.map": "missing", "dest.x": 4, "dest.y": 3, "dest.dir": "left" },
      message: "unknown map \"missing\"",
    },
  ] satisfies readonly {
    name: string;
    variables: Readonly<Record<string, string | number>>;
    message: string;
  }[]) {
    test(`${scenario.name} becomes a frozen fatal state instead of throwing`, () => {
      const p = project([
        {
          op: "transfer",
          map: { variable: "dest.map" },
          x: { variable: "dest.x" },
          y: { variable: "dest.y" },
          dir: { variable: "dest.dir" },
        },
        { op: "switch", id: "after-transfer", value: true },
      ], [map("b")]);
      const session = createSession(p);
      const initial = startSession(p, session);
      Object.assign(initial.sw.variables, scenario.variables);
      let failed: SessionState | undefined;

      expect(() => { failed = step(session, initial); }).not.toThrow();
      expect(failed).toBeDefined();
      const fatal = failed!;
      expect(fatal.interp.error).toEqual({
        kind: "content",
        message: `transfer in a/event: ${scenario.message}`,
      });
      expect(fatal.mapId).toBe("a");
      expect(fatal.sw.switches["after-transfer"]).toBeUndefined();
      expect(() => createSessionSnapshot(session, fatal, 0)).toThrow(/no modal or scene open/);

      const frozen = step(session, fatal);
      expect(frozen.frame).toBe(fatal.frame + 1);
      expect(frozen.interp).toEqual(fatal.interp);
      expect(frozen.move).toEqual(fatal.move);
      expect(frozen.chars).toEqual(fatal.chars);
    });
  }

  test("schema/editor JSON round-trip preserves ext and battle commands verbatim", () => {
    const p = project([{
      op: "if",
      if: { kind: "ext", call: "demo.ready", args: { flag: true } },
      then: [{ op: "ext", call: "demo.run", args: [1, "two", null] }],
      else: [{ op: "battle", setup: { enemy: "slime" }, onWin: [{ op: "switch", id: "won", value: true }] }],
    }]);
    const text = serializeProject(p);
    const loaded = loadProject(text);
    expect(loaded.errors).toEqual([]);
    expect(serializeProject(loaded.project)).toBe(text);
  });
});
