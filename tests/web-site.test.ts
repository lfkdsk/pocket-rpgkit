// tests/web-site.test.ts — the web site builder (tools/web.ts) without a
// browser and without building bundles: game discovery, the metadata
// table's fallbacks, viewport policy, the key table, screen sizing, and
// the pages' URLs. tools/web-verify.ts plays the built site in Chrome.

import { describe, expect, test } from "bun:test";
import { EXAMPLES } from "../tools/build-example.ts";
import {
  cardOrder,
  DEFAULT_WEB_RASTER_DENSITY,
  defaultGameIds,
  KIT_ROOT,
  loadSiteConfig,
  parseSiteConfig,
  renderLanding,
  renderPlayer,
  resolveGame,
  shortTitle,
  viewportFor,
  type PlayerConfig,
  type WebGame,
} from "../tools/web.ts";
import { fitViewport, type ViewportConfig } from "../tools/web/fit.ts";
import { rpgkitBootFromSearch } from "../tools/web/boot.ts";
import { verifyPlanHash } from "../vendor/pocketjs/framework/src/manifest/plan.ts";
import { BTN, KEYMAP, keyMasks, keysFor, withKeys } from "../tools/web/keys.ts";
import { createMasterAudioHost } from "../tools/web/audio-control.ts";

const config = loadSiteConfig(KIT_ROOT);
const site = { title: config.title!, intro: config.intro!, source: config.source! };

function playerConfig(game: WebGame): PlayerConfig {
  return {
    id: game.id,
    app: game.plan.app.output,
    bundle: `${game.plan.app.output}.js`,
    pak: `${game.plan.app.output}.pak`,
    wasm: "../pocketjs.wasm",
    viewport: game.viewport,
    rasterDensity: game.plan.viewport.rasterDensity,
    companions: [...game.plan.companions],
    simHz: 60,
    keys: keyMasks(game.keymap),
  };
}

/** Every src/href in a page, minus data: URIs. */
function urls(html: string): string[] {
  return [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("data:"));
}

describe("games", () => {
  test("with no names, this repository builds every example in EXAMPLES", () => {
    expect(defaultGameIds(KIT_ROOT)).toEqual([...EXAMPLES]);
  });

  test("cards follow the metadata table, then the rest in build order", () => {
    // "later" stands for an example with no web.json entry yet.
    expect(cardOrder(["meadow", "sunstone", "later", "grow", "wander"], config)).toEqual(["wander", "sunstone", "grow", "meadow", "later"]);
    expect(cardOrder(["later", "meadow"], config)).toEqual(["meadow", "later"]);
  });

  test("every example resolves against web-app", () => {
    for (const id of EXAMPLES) {
      const game = resolveGame(KIT_ROOT, config, id);
      expect(game.plan.target.id).toBe("web-app");
      expect(game.plan.viewport.rasterDensity).toBe(DEFAULT_WEB_RASTER_DENSITY);
      expect(game.title.length).toBeGreaterThan(0);
      expect(game.controls.length).toBeGreaterThan(0);
    }
    const showcase = resolveGame(KIT_ROOT, config, "showcase");
    expect(showcase.featured).toBe(true);
    expect(showcase.features).toHaveLength(12);
  });

  test("viewports: sunstone pinned fixed, grow dynamic from its plan, meadow fixed", () => {
    expect(resolveGame(KIT_ROOT, config, "sunstone").viewport).toEqual({ policy: "fixed", logical: [480, 272] });
    expect(resolveGame(KIT_ROOT, config, "grow").viewport).toEqual({
      policy: "dynamic", default: [960, 544], min: [480, 272], max: [4096, 4096],
    });
    expect(resolveGame(KIT_ROOT, config, "meadow").viewport).toEqual({ policy: "fixed", logical: [480, 272] });
  });

  test("a game without a table entry gets a plain card", () => {
    const game = resolveGame(KIT_ROOT, {}, "meadow");
    expect(game.title).toBe("Pocket RPG Kit — Mini Meadow");
    expect(resolveGame(KIT_ROOT, { title: "Pocket RPG Kit" }, "meadow").title).toBe("Mini Meadow");
    expect(game.description).toBe("");
    expect(game.preview).toBeUndefined();
    expect(game.chapters).toEqual([]);
    expect(game.controls.map((c) => c.button)).toEqual(["DPAD", "CIRCLE", "CROSS"]);
  });

  test("an unknown game names the examples it looked for", () => {
    expect(() => resolveGame(KIT_ROOT, config, "nope")).toThrow(/no pocket\.json for "nope".*sunstone/);
  });

  test("the table is validated", () => {
    const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");
    expect(parse({ games: [{ id: "meadow" }] })).toThrow(/table keyed by game id/);
    expect(parse({ games: { "../x": {} } })).toThrow(/not a usable game id/);
    expect(parse({ games: { meadow: { controls: [{ button: "TURBO", action: "x" }] } } })).toThrow(/known button/);
    expect(parse({ games: { meadow: { keys: { KeyA: "TURBO" } } } })).toThrow(/not a button/);
    expect(parse({ games: { meadow: { viewport: "stretch" } } })).toThrow(/"fixed" or "dynamic"/);
    expect(parse({ games: { meadow: { chapters: {} } } })).toThrow(/chapters is a list/);
    expect(parse({ games: { meadow: { chapters: [null] } } })).toThrow(/chapters\[0\] is an object/);
    expect(parse({ games: { meadow: { chapters: [{ id: "bad/id", title: "Bad" }] } } })).toThrow(/usable chapter id/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "  " }] } } })).toThrow(/non-empty text/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "One" }, { id: "intro", title: "Again" }] } } })).toThrow(/duplicate id/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", autoplay: "yes" }] } } })).toThrow(/autoplay is a boolean/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction" }] } } })).not.toThrow();
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", autoplay: true }] } } })()).toEqual({
      games: { meadow: { chapters: [{ id: "intro", title: "Introduction", autoplay: true }] } },
    });
    expect(parse({ games: { meadow: { features: "one room" } } })).toThrow(/features is a list of text/);
    expect(parse({ games: { meadow: { features: ["one room", 2] } } })).toThrow(/features is a list of text/);
    expect(parse({ games: { meadow: { featured: "yes" } } })).toThrow(/featured is a boolean/);
    expect(parse({ games: { meadow: { features: ["one room"], featured: true } } })()).toEqual({
      games: { meadow: { features: ["one room"], featured: true } },
    });
    expect(parse({ games: { meadow: { rasterDensity: 0 } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: 1.5 } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: 5 } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: "2" } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: Number.NaN } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: Number.POSITIVE_INFINITY } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: {} } })()).toEqual({ games: { meadow: {} } });
  });

  test("a web.json game can override the default raster density", () => {
    const game = resolveGame(KIT_ROOT, { games: { meadow: { rasterDensity: 3 } } }, "meadow");
    expect(game.plan.viewport.rasterDensity).toBe(3);
    expect(game.plan.viewport.physical).toEqual([1440, 816]);
    expect(verifyPlanHash(game.plan)).toBe(true);
  });

  test("viewportFor: dynamic-only manifests, and pins the manifest cannot honor", () => {
    const grow = resolveGame(KIT_ROOT, config, "grow");
    const dynamicOnly = { app: { viewport: { dynamic: { default: [960, 544], min: [480, 272], max: [2048, 2048] } } } };
    expect(viewportFor(dynamicOnly, grow.plan)).toEqual({ policy: "dynamic", default: [960, 544], min: [480, 272], max: [2048, 2048] });
    expect(() => viewportFor(dynamicOnly, grow.plan, "fixed")).toThrow(/pins a fixed viewport/);
    expect(shortTitle("Pocket RPG Kit — Wander", "Pocket RPG Kit")).toBe("Wander");
    expect(shortTitle("Alpine Post", "Pocket RPG Kit")).toBe("Alpine Post");
  });
});

describe("pages", () => {
  const games = cardOrder([...EXAMPLES], config).map((id) => resolveGame(KIT_ROOT, config, id));

  test("the landing page links every game with relative URLs", () => {
    const html = renderLanding(site, games.map((game) => ({ game, preview: [480, 272] as [number, number] })));
    for (const game of games) {
      expect(html).toContain(`href="${game.id}/"`);
      expect(html).toContain(`src="${game.id}/preview.png"`);
    }
    for (const url of urls(html)) expect(url.startsWith("/") || url.startsWith("./..")).toBe(false);
    expect(urls(html)).toContain("site.css");
  });

  test("chapter links stay under their game and escape their labels", () => {
    const sunstone = games.find((game) => game.id === "sunstone")!;
    expect(sunstone.chapters.map(({ id }) => id)).toEqual(["village", "forest", "cave"]);
    expect(sunstone.controls.find(({ button }) => button === "SELECT")?.action).toBe("Demo menu");
    const escaped = {
      ...sunstone,
      chapters: [{ id: "village", title: "Village & <home>" }],
    };
    const html = renderLanding(site, [{ game: escaped }, { game: games.find((game) => game.id === "meadow")! }]);
    expect(html).toContain('href="sunstone/?chapter=village">Village &amp; &lt;home&gt;</a>');
    expect(html).not.toContain('href="?chapter=');
    expect(html.match(/class="chapters"/g)).toHaveLength(1);
  });

  test("showcase entries are cards linked to their own site, after featured local games", () => {
    const entry = {
      title: "Pocket Tuxemon",
      url: "https://example.org/tuxemon/",
      description: "A & B",
      preview: "https://example.org/tuxemon/preview.png",
      controls: [{ button: "CIRCLE" as const, action: "Talk" }],
    };
    const html = renderLanding({ ...site, showcase: [entry] }, games.map((game) => ({ game })));
    expect(html).toContain('<article class="game-card showcase-card">');
    expect(html).toContain('<a href="https://example.org/tuxemon/">Pocket Tuxemon</a>');
    expect(html).toContain('<a class="play" href="https://example.org/tuxemon/">Play in the browser</a>');
    expect(html).toContain('src="https://example.org/tuxemon/preview.png"');
    expect(html).toContain("A &amp; B");
    const featured = games.find((game) => game.featured)!;
    const regular = games.find((game) => !game.featured)!;
    expect(html.indexOf(`id="${featured.id}"`)).toBeLessThan(html.indexOf("showcase-card"));
    expect(html.indexOf("showcase-card")).toBeLessThan(html.indexOf(`id="${regular.id}"`));
    expect(renderLanding(site, [{ game: games[0]! }])).not.toContain("showcase-card");
    const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");
    expect(parse({ showcase: [entry] })).not.toThrow();
    expect(parse({ showcase: {} })).toThrow(/"showcase" is a list/);
    expect(parse({ showcase: [{ title: "", url: entry.url }] })).toThrow(/needs a title/);
    expect(parse({ showcase: [{ title: "x", url: "/relative/" }] })).toThrow(/absolute https/);
    expect(parse({ showcase: [{ title: "x", url: "javascript:alert(1)" }] })).toThrow(/absolute https/);
    expect(parse({ showcase: [{ title: "x", url: entry.url, preview: "preview.png" }] })).toThrow(/preview must be/);
    expect(parse({ showcase: [{ title: "x", url: entry.url, controls: [{ button: "NOPE", action: "x" }] }] })).toThrow(/known button/);
  });

  test("the site lists the featured game first, then the external showcase and regular games", () => {
    const html = renderLanding(
      { ...site, showcase: config.showcase },
      cardOrder([...EXAMPLES], config).map((id) => ({ game: resolveGame(KIT_ROOT, config, id) })),
    );
    const order = [...html.matchAll(/<h2><a href="[^"]*">([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
    expect(order[0]).toBe(games.find((game) => game.featured)!.title);
    expect(order[1]).toBe("Pocket Tuxemon");
    expect(order[2]).toBe("Wander: an Endless Grown World");
    expect(order.length).toBe(1 + EXAMPLES.length);
  });

  test("a card without a preview gets a placeholder, not a broken image", () => {
    const html = renderLanding(site, [{ game: games[0]! }]);
    expect(html).not.toContain("preview.png");
    expect(html).toContain('class="no-preview"');
  });

  test("player pages load everything relative to the page", () => {
    for (const game of games) {
      const html = renderPlayer(site, game, playerConfig(game), true);
      const links = urls(html);
      expect(links).toContain("../site.css");
      expect(links).toContain("../player.js");
      expect(links).toContain("../");
      expect(links).toContain("ATTRIBUTION.txt");
      for (const url of links) {
        if (/^https:\/\//.test(url)) continue;
        expect(url.startsWith("/")).toBe(false);
      }
      const json = /<script type="application\/json" id="pocket-game">(.*?)<\/script>/s.exec(html)![1]!;
      const parsed = JSON.parse(json) as PlayerConfig;
      expect(parsed.wasm).toBe("../pocketjs.wasm");
      expect(parsed.bundle).toBe(`${game.plan.app.output}.js`);
      expect(parsed.viewport).toEqual(game.viewport);
      expect(parsed.rasterDensity).toBe(DEFAULT_WEB_RASTER_DENSITY);
      expect(parsed.keys.KeyA).toBe(BTN.CIRCLE);
      expect(html).toContain(`data-viewport="${game.viewport.policy}"`);
      expect(html).toContain('<button type="button" id="audio-mute" aria-label="Mute audio" aria-pressed="false">Mute</button>');
      expect(html).toContain('<label for="audio-volume">Volume</label>');
      expect(html).toContain('<input type="range" id="audio-volume" min="0" max="100" step="5" value="100">');
    }
  });

  test("player pages expose progressive chapter and autoplay controls", () => {
    const sunstone = games.find((game) => game.id === "sunstone")!;
    expect(sunstone.chapters).toEqual([
      { id: "village", title: "Village", autoplay: true },
      { id: "forest", title: "Forest", autoplay: true },
      { id: "cave", title: "Cave", autoplay: true },
    ]);
    const html = renderPlayer(site, sunstone, playerConfig(sunstone), true);
    expect(html.match(/data-demo-chapter=/g)).toHaveLength(3);
    expect(html.match(/data-demo-speed=/g)).toHaveLength(3);
    expect(html).toContain('data-demo-chapter="cave" data-demo-autoplay="true" href="?chapter=cave"');
    expect(html).toContain('data-demo-speed="4" href="?autoplay=village&amp;speed=4"');
    expect(html).toContain('role="button" aria-pressed="false"');

    const meadow = games.find((game) => game.id === "meadow")!;
    expect(renderPlayer(site, meadow, playerConfig(meadow), true)).not.toContain("data-demo-controls");

    const showcase = games.find((game) => game.id === "showcase")!;
    expect(showcase.chapters.map(({ id }) => id)).toEqual([
      "showcase-screen-effects",
      "showcase-map-animations",
      "showcase-runtime-visuals",
      "showcase-movement-controls",
      "showcase-extensions",
      "showcase-battle",
      "showcase-shop",
      "hall-streaming",
      "hall-theme",
      "showcase-input-and-idle",
      "hall-save",
      "hall-attract",
    ]);
    expect(showcase.controls.find(({ button }) => button === "SELECT")?.action).toBe("Demo menu");
    const showcaseHtml = renderPlayer(site, showcase, playerConfig(showcase), true);
    expect(showcaseHtml.match(/data-demo-chapter=/g)).toHaveLength(12);
    expect(showcaseHtml).toContain('data-demo-chapter="hall-streaming"');
    expect(showcaseHtml).not.toContain("data-demo-speed=");
  });

  test("text is escaped and the settings cannot close their script tag", () => {
    const game = {
      ...games[0]!,
      title: "<b>A&B</b>",
      description: '"</script>"',
      features: ["One & two", "<script>three</script>"],
      chapters: [{ id: "escaped", title: "Chapter <one>", autoplay: false }],
    };
    const html = renderPlayer(site, game, { ...playerConfig(game), app: "</script><x>" }, false);
    expect(html).toContain("&lt;b&gt;A&amp;B&lt;/b&gt;");
    expect(html).toContain("<h2>Exhibition halls</h2>");
    expect(html).toContain("<ol class=\"features\">");
    expect(html).toContain("<li>One &amp; two</li>");
    expect(html).toContain("<li>&lt;script&gt;three&lt;/script&gt;</li>");
    expect(html).toContain(">Chapter &lt;one&gt;</a>");
    expect(html.match(/<\/script>/g)!.length).toBe(2);
    expect(html).not.toContain("ATTRIBUTION.txt");
  });

  test("the controls print the keys that press each button", () => {
    const grow = games.find((g) => g.id === "grow")!;
    const html = renderPlayer(site, grow, playerConfig(grow), true);
    expect(html).toContain("<kbd>←</kbd> <kbd>→</kbd></th><td>Step the timeline");
    expect(html).toContain("<kbd>A</kbd> <kbd>Enter</kbd> <kbd>Z</kbd></th><td>Walk into the finished village");
    expect(html).toContain('data-button="TRIANGLE">X</button>');
  });
});

describe("boot query", () => {
  test("keeps the supported deep-link values as strings", () => {
    expect(rpgkitBootFromSearch("?chapter=forest")).toEqual({ chapter: "forest" });
    expect(rpgkitBootFromSearch("?map=village&x=&y=12")).toEqual({ map: "village", x: "", y: "12" });
    expect(rpgkitBootFromSearch("?autoplay=intro&speed=2")).toEqual({ autoplay: "intro", speed: "2" });
  });

  test("ignores unknown keys and treats decoded text only as data", () => {
    expect(rpgkitBootFromSearch("?unknown=x&__proto__=bad")).toEqual({});
    expect(rpgkitBootFromSearch("?chapter=%3C%2Fscript%3E&chapter=second")).toEqual({ chapter: "</script>" });
  });
});

describe("player master audio", () => {
  test("primes and resumes the lazy browser host inside a user gesture", () => {
    const calls: string[] = [];
    const raw = {
      ns: {
        createStream: (rate: number, channels: number) => {
          calls.push(`create ${rate} ${channels}`);
          return 7;
        },
        destroyStream: (handle: number) => calls.push(`destroy ${handle}`),
        writePcm: () => 0,
        play: (handle: number) => calls.push(`play ${handle}`),
        pause: () => {},
        stop: () => {},
        setVolume: () => {},
        endStream: () => {},
        poll: () => undefined,
      },
      beginFrame: () => {},
      reset: () => {},
    };

    createMasterAudioHost(raw).activate();
    expect(calls).toEqual(["create 11025 1", "play 7", "destroy 7"]);
  });

  test("mutes without pausing and restores each stream's latest guest volume", () => {
    let nextHandle = 1;
    let begins = 0;
    let resets = 0;
    const volumes: Array<[number, number]> = [];
    const destroyed: number[] = [];
    const raw = {
      ns: {
        createStream: () => nextHandle++,
        destroyStream: (handle: number) => destroyed.push(handle),
        writePcm: () => 0,
        play: () => {},
        pause: () => { throw new Error("master mute must not pause streams"); },
        stop: () => {},
        setVolume: (handle: number, volume: number) => volumes.push([handle, volume]),
        endStream: () => {},
        poll: () => undefined,
      },
      beginFrame: () => { begins++; },
      reset: () => { resets++; },
    };
    const host = createMasterAudioHost(raw);
    const bgm = host.ns.createStream(11_025, 1);
    const effect = host.ns.createStream(22_050, 2);
    host.ns.setVolume(bgm, 0.35);
    host.ns.setVolume(effect, 0.8);
    expect(volumes.splice(0)).toEqual([[bgm, 0.35], [effect, 0.8]]);

    host.setMasterVolume(0.5);
    expect(volumes.splice(0)).toEqual([[bgm, 0.175], [effect, 0.4]]);
    host.setMuted(true);
    expect(host.muted).toBe(true);
    expect(volumes.splice(0)).toEqual([[bgm, 0], [effect, 0]]);

    // A guest fade while muted stays silent, but becomes the restored volume.
    host.ns.setVolume(bgm, 0.2);
    host.setMasterVolume(0.25);
    expect(volumes.splice(0)).toEqual([[bgm, 0], [bgm, 0], [effect, 0]]);
    host.setMuted(false);
    expect(volumes.splice(0)).toEqual([[bgm, 0.05], [effect, 0.2]]);

    host.ns.destroyStream(effect);
    host.setMasterVolume(1);
    expect(destroyed).toEqual([effect]);
    expect(volumes.splice(0)).toEqual([[bgm, 0.2]]);
    host.beginFrame();
    host.reset();
    expect({ begins, resets }).toEqual({ begins: 1, resets: 1 });
    host.setMuted(true);
    expect(volumes).toEqual([]);
  });
});

describe("keys", () => {
  test("letter keys match the web-app glyphs; Enter and Z also confirm", () => {
    expect(keysFor("CIRCLE")).toEqual(["A", "Enter", "Z"]);
    expect(keysFor("CROSS")).toEqual(["B", "Esc", "Backspace"]);
    expect(keysFor("TRIANGLE")).toEqual(["X"]);
    expect(keysFor("SQUARE")).toEqual(["Y"]);
    expect(keysFor("DPAD")).toEqual(["Arrow keys"]);
    expect(keyMasks().Space).toBe(BTN.START);
    expect(Object.keys(KEYMAP)).not.toContain("Tab");
  });

  test("a game can rebind and unbind keys", () => {
    const keymap = withKeys({ KeyA: "SQUARE", KeyY: null, Tab: "SELECT" });
    expect(keysFor("SQUARE", keymap)).toEqual(["A"]);
    expect(keysFor("CIRCLE", keymap)).toEqual(["Enter", "Z"]);
    expect(keysFor("SELECT", keymap)).toEqual(["Shift", "Tab"]);
    expect(keyMasks(keymap).KeyY).toBeUndefined();
    expect(() => withKeys({ "Key A": "CIRCLE" })).toThrow(/KeyboardEvent\.code/);
  });
});

describe("screen sizing", () => {
  const fixed: ViewportConfig = { policy: "fixed", logical: [480, 272] };
  const dynamic: ViewportConfig = { policy: "dynamic", default: [960, 544], min: [480, 272], max: [4096, 4096] };

  test("fixed: the largest whole scale that fits, in device pixels", () => {
    expect(fitViewport(fixed, 1408, 894, 1)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 2)).toEqual({ size: [480, 272], k: 5 });
    // 1.25: 3 device pixels per game pixel = 1152 CSS px, not 2.5x smeared.
    expect(fitViewport(fixed, 1408, 894, 1.25)).toEqual({ size: [480, 272], k: 3 });
    expect(fitViewport(fixed, 358, 600, 3)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 300, 600, 1).k).toBe(0);
    expect(fitViewport(fixed, 1408, 894, 1, 2)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 2, 2)).toEqual({ size: [480, 272], k: 4 });
    expect(fitViewport(fixed, 1408, 894, 1.25, 2)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 358, 600, 3, 2)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 1, 3).k).toBe(0);
    expect(() => fitViewport(fixed, 1408, 894, 1, 1.5)).toThrow(/positive integer/);
  });

  test("dynamic: the viewport follows the area at the largest scale above the minimum", () => {
    for (const [w, h, dpr] of [[1408, 894, 1], [1408, 894, 2], [968, 600, 1], [358, 700, 3], [2528, 794, 1], [1000, 700, 1.25]] as const) {
      const { size, k } = fitViewport(dynamic, w, h, dpr);
      const deviceW = Math.floor(w * dpr);
      const deviceH = Math.floor(Math.min(h, (w * 544) / 960) * dpr);
      expect(k).toBeGreaterThanOrEqual(1);
      expect(size[0]).toBeGreaterThanOrEqual(480);
      expect(size[1]).toBeGreaterThanOrEqual(272);
      expect(size[0] * k).toBeLessThanOrEqual(deviceW);
      expect(size[1] * k).toBeLessThanOrEqual(deviceH);
      // One step larger would drop below the minimum.
      expect(Math.floor(deviceW / (k + 1)) < 480 || Math.floor(deviceH / (k + 1)) < 272).toBe(true);
      // Never taller than the default shape.
      expect(size[1] / size[0]).toBeLessThanOrEqual(544 / 960 + 0.01);
    }
    expect(fitViewport(dynamic, 1408, 894, 1)).toEqual({ size: [704, 398], k: 2 });
    expect(fitViewport(dynamic, 300, 200, 1)).toEqual({ size: [480, 272], k: 0 });
    expect(fitViewport({ ...dynamic, max: [600, 300] }, 1408, 894, 1)).toEqual({ size: [600, 300], k: 2 });
  });

  test("dynamic: every raster sample covers a whole number of device pixels", () => {
    for (const density of [2, 3]) {
      for (const [w, h, dpr] of [[1408, 894, 2], [968, 600, 2], [358, 700, 3], [2528, 794, 2]] as const) {
        const { size, k } = fitViewport(dynamic, w, h, dpr, density);
        expect(k === 0 || k % density === 0).toBe(true);
        if (k > 0) {
          const deviceW = Math.floor(w * dpr);
          const deviceH = Math.floor(Math.min(h, (w * 544) / 960) * dpr);
          expect(size[0] * k).toBeLessThanOrEqual(deviceW);
          expect(size[1] * k).toBeLessThanOrEqual(deviceH);
          expect(
            Math.floor(deviceW / (k + density)) < 480 || Math.floor(deviceH / (k + density)) < 272,
          ).toBe(true);
        }
      }
    }
  });
});
