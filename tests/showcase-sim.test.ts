// Rendered acceptance coverage for examples/showcase on the real PocketJS
// wasm host. Reducer semantics for every room live in showcase.test.ts;
// these tests pin the presentation-critical frames and prove their pixels.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import type { SessionState } from "../src/engine/session.ts";
import type { RpgkitDemoHook } from "../src/ui/demo/index.ts";
import { SHOWCASE_HALLS } from "../examples/showcase/showcase-data.ts";
import { hallDoorPosition } from "../examples/showcase/hall-kit.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("showcase");
if (!preflight.ok) console.warn(`showcase sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface Diagnostics {
  stream: Partial<Record<"ground" | "upper", { mapId: string; resident: number; pending: number }>>;
  animated: Partial<Record<"below" | "above", { mapId: string; mounted: number }>>;
  mapAnim: Partial<Record<"below" | "above", { mapId: string; mounted: number }>>;
  saveCodeRoundTrip: boolean;
}

const diagnostics = (): Diagnostics =>
  structuredClone((globalThis as { __showcaseDiagnostics?: Diagnostics }).__showcaseDiagnostics!);

function findNode(tree: unknown, name: string): any {
  const node = tree as { n?: string; k?: unknown[] };
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

function pixel(frame: Uint8Array, x: number, y: number): number[] {
  const i = (y * 480 + x) * 4;
  return [...frame.subarray(i, i + 4)];
}

function countPixels(
  frame: Uint8Array,
  predicate: (r: number, g: number, b: number, a: number) => boolean,
): number {
  let count = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (predicate(frame[i]!, frame[i + 1]!, frame[i + 2]!, frame[i + 3]!)) count++;
  }
  return count;
}

async function golden(name: string, frame: Uint8Array): Promise<string> {
  const url = new URL(`./goldens/showcase-${name}.png`, import.meta.url);
  if (process.env.SHOWCASE_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, 480, 272));
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer())).rgba;
  expect(frame).toEqual(expected);
  const hash = fnv1a(frame);
  console.log(`showcase golden ${name}: ${hash}`);
  return hash;
}

class SimDriver {
  private constructor(readonly world: BoundGameWorld) {}

  static async boot(extraGlobals?: Record<string, unknown>): Promise<SimDriver> {
    const driver = new SimDriver(await bootGameWorld(appBundle("showcase"), 60, extraGlobals));
    for (let frame = 0; frame < 8; frame++) driver.step();
    return driver;
  }

  get state(): SessionState {
    return this.world.probes().state;
  }

  step(buttons = 0): void {
    this.world.frame(buttons, 0x8080);
    this.world.tick();
    if (this.state.interp.error) throw new Error(this.state.interp.error.message);
  }

  pulse(button: number): void {
    this.step(button);
    this.step(0);
  }

  private moveAxis(axis: "x" | "y", target: number, expectedMap: string): void {
    for (let frame = 0; frame < 1_200; frame++) {
      if (this.state.mapId !== expectedMap) return;
      const value = axis === "x" ? this.state.move.tx : this.state.move.ty;
      if (value === target && !this.state.move.moving) return;
      this.step(axis === "x"
        ? target > value ? BTN.RIGHT : BTN.LEFT
        : target > value ? BTN.DOWN : BTN.UP);
    }
    throw new Error(`showcase sim: never reached ${axis}=${target} on ${expectedMap}`);
  }

  until(predicate: (state: SessionState) => boolean, autoText = true, limit = 4_000): SessionState {
    for (let frame = 0; frame < limit; frame++) {
      if (predicate(this.state)) return this.state;
      if (autoText && this.state.interp.modal?.kind === "text") this.pulse(BTN.CIRCLE);
      else this.step();
    }
    throw new Error(`showcase sim: condition timed out on ${this.state.mapId}`);
  }

  enter(number: number, approach = true): void {
    const hall = SHOWCASE_HALLS.find((candidate) => candidate.number === number)!;
    const index = SHOWCASE_HALLS.indexOf(hall);
    const { x, y } = hallDoorPosition(index, SHOWCASE_HALLS.length);
    this.moveAxis("x", x, "showcase-lobby");
    this.moveAxis("y", y, "showcase-lobby");
    this.until((state) => state.mapId === hall.id && state.fade === null && state.interp.main === null, false, 600);
    if (!approach) return;
    this.moveAxis("x", 10, hall.id);
    this.moveAxis("y", 8, hall.id);
    this.pulse(BTN.CIRCLE);
  }

  frame(): Uint8Array {
    return this.world.render().slice();
  }
}

const pins: Record<string, string> = {
  lobby: "0f38a1db",
  tint: "10c58fb2",
  "map-animation": "a4536f26",
  battle: "be26dddf",
  streaming: "a35bd7f4",
  theme: "18580819",
  "save-code": "5f66ddee",
  "save-verified": "237bd0fe",
  attract: "4f481c50",
  rewind: "11859aa1",
};

async function pinned(name: keyof typeof pins, frame: Uint8Array): Promise<void> {
  const hash = await golden(name, frame);
  if (!process.env.SHOWCASE_UPDATE_GOLDENS) expect(hash).toBe(pins[name]);
}

simDescribe("showcase rendered feature gallery", () => {
  test("a chapter boot restores the selected showroom entrance", async () => {
    const d = await SimDriver.boot({ __rpgkitBoot: { chapter: "hall-streaming" } });
    expect(d.state).toMatchObject({
      mapId: "hall-streaming",
      move: { tx: 2, ty: 12, px: 32, py: 192, facing: 2 },
      sw: { gold: 80 },
    });
    const hook = (globalThis as { __rpgkitDemo?: RpgkitDemoHook }).__rpgkitDemo!;
    expect(hook.current()).toMatchObject({ chapter: "hall-streaming", map: "hall-streaming", autoplay: false });
  });

  test("lobby has two portal rows, a guide, a directory sign, and a 16x32 player", async () => {
    const d = await SimDriver.boot();
    const frame = d.frame();
    await pinned("lobby", frame);
    expect(pixel(frame, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(countPixels(frame, (r, g, b) => r === 255 && g === 220 && b === 82)).toBeGreaterThan(40);
    expect(countPixels(frame, (r, g, b) => r === 244 && g === 199 && b === 82)).toBeGreaterThan(20);
    expect(countPixels(frame, (r, g, b) => r === 85 && g === 47 && b === 34)).toBeGreaterThan(40);
  });

  test("named night tint visibly composites over the room", async () => {
    const d = await SimDriver.boot();
    d.enter(1);
    d.until((state) => {
      const tint = state.interp.screen?.tints?.["time-of-day"];
      return tint?.to.b === 140 && tint.left === 6;
    });
    const frame = d.frame();
    await pinned("tint", frame);
    expect(countPixels(frame, (r, g, b) => b > r + 12 && b > g + 12)).toBeGreaterThan(15_000);
  });

  test("map-animation bands mount simultaneous floor, player, follow, and pinned effects", async () => {
    const d = await SimDriver.boot();
    d.enter(2);
    d.until((state) => (state.interp.anims?.length ?? 0) >= 4);
    for (let frame = 0; frame < 12; frame++) d.step();
    expect(diagnostics().mapAnim.below).toMatchObject({ mapId: "showcase-map-animations", mounted: 1 });
    expect(diagnostics().mapAnim.above).toMatchObject({ mapId: "showcase-map-animations", mounted: 3 });
    const frame = d.frame();
    await pinned("map-animation", frame);
    expect(countPixels(frame, (r, g, b) => r === 0 && g === 168 && b === 232)).toBeGreaterThan(20);
  });

  test("battle scene uses SpriteSlot art while the animated map subtree stays resident", async () => {
    const d = await SimDriver.boot();
    d.enter(6);
    d.until((state) => state.scene?.kind === "battle");
    d.step();
    const tree = d.world.getTree();
    expect(findNode(tree, "rpgkit-world")).toBeDefined();
    expect(findNode(tree, "showcase-battle-scene")).toBeDefined();
    expect(diagnostics().mapAnim.below).toMatchObject({ mapId: "showcase-battle", mounted: 1 });
    const frame = d.frame();
    await pinned("battle", frame);
    expect(pixel(frame, 0, 0)).toEqual([76, 43, 30, 255]);
    expect(countPixels(frame, (r, g, b) => r === 72 && g === 112 && b === 168)).toBeGreaterThan(400);
    expect(countPixels(frame, (r, g, b) => r === 216 && g === 184 && b === 72)).toBeGreaterThan(50);
  });

  test("streamed room mounts six chunks, both animated-tile bands, and the tall walker", async () => {
    const d = await SimDriver.boot();
    d.enter(8, false);
    for (let frame = 0; frame < 10; frame++) d.step();
    expect(diagnostics().stream.ground).toMatchObject({ mapId: "hall-streaming", resident: 6, pending: 0 });
    expect(diagnostics().animated.below).toMatchObject({ mapId: "hall-streaming", mounted: 8 });
    expect(diagnostics().animated.above).toMatchObject({ mapId: "hall-streaming", mounted: 4 });
    const frame = d.frame();
    await pinned("streaming", frame);
    expect(countPixels(frame, (r, g, b) => r === 30 && g === 124 && b === 184)).toBeGreaterThan(4_000);
    expect(countPixels(frame, (r, g, b) => r === 41 && g === 150 && b === 219)).toBeGreaterThan(200);
  });

  test("speaker portrait and sunrise theme are visible in the second themed dialog", async () => {
    const d = await SimDriver.boot();
    d.enter(9);
    d.until((state) => state.sw.switches["showcase.theme.alt"] === true && state.interp.modal?.kind === "text");
    // First confirm reveals the complete typewriter without closing it;
    // the release frame leaves the themed portrait dialog on screen.
    d.pulse(BTN.CIRCLE);
    const frame = d.frame();
    await pinned("theme", frame);
    expect(countPixels(frame, (r, g, b) => r === 31 && g === 44 && b === 61)).toBeGreaterThan(1_500);
    expect(countPixels(frame, (r, g, b) => r === 226 && g === 157 && b === 116)).toBeGreaterThan(80);
    expect(countPixels(frame, (r, g, b) => r === 255 && g === 176 && b === 92)).toBeGreaterThan(100);
  });

  test("real SaveMenu renders the exported code and reports a verified import round trip", async () => {
    const d = await SimDriver.boot();
    d.enter(11);
    d.until((state) => state.sw.switches["showcase.save.complete"] === true && state.interp.main === null);
    d.until(() => diagnostics().saveCodeRoundTrip, false);
    for (let frame = 0; frame < 90; frame++) d.step();
    expect(findNode(d.world.getTree(), "rpgkit-code-title")).toBeDefined();
    const code = d.frame();
    expect(countPixels(code, (r, g, b) => r > 210 && g > 210 && b > 210)).toBeGreaterThan(300);
    await pinned("save-code", code);

    for (let frame = 0; frame < 150; frame++) d.step();
    expect(findNode(d.world.getTree(), "rpgkit-message-title")).toBeDefined();
    expect(diagnostics().saveCodeRoundTrip).toBe(true);
    await pinned("save-verified", d.frame());
  });

  test("idle tour, takeover, and rewind overlays render from the shipped tape", async () => {
    const d = await SimDriver.boot();
    for (let frame = 8; frame < 600; frame++) d.step();
    expect(findNode(d.world.getTree(), "rpgkit-demo-badge")).toBeDefined();
    await pinned("attract", d.frame());

    d.pulse(BTN.RIGHT);
    expect(findNode(d.world.getTree(), "rpgkit-control-notice")).toBeDefined();
    d.pulse(BTN.LTRIGGER);
    expect(findNode(d.world.getTree(), "rpgkit-rewind-notice")).toBeDefined();
    await pinned("rewind", d.frame());
  });
});
