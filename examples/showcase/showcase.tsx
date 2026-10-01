// @title Pocket RPG Kit — Feature Gallery
// One app, one lobby, fourteen rooms. The project itself demonstrates event
// commands; this thin shell registers game extensions, battle UI, attract
// playback, live theme switching, streamed-render diagnostics, and the
// SaveMenu/save-code round-trip shown in room 11.

import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { simulationHz } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createOsk } from "@pocketjs/framework/osk";
import { GameView } from "../../src/ui/GameView.tsx";
import { ChoiceIconBox } from "../../src/ui/ChoiceIconBox.tsx";
import { createAudioEffects } from "../../src/ui/audio/index.ts";
import { createDemo } from "../../src/ui/demo/index.ts";
import { NameInputScene } from "../../src/ui/name-input/NameInputScene.tsx";
import { SaveMenu } from "../../src/ui/SaveMenu.tsx";
import type { MenuState } from "../../src/engine/save-menu.ts";
import type { SessionState } from "../../src/engine/session.ts";
import { createSession } from "../../src/engine/session.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../../src/engine/name-input.ts";
import { canSave, createSessionSnapshot, decodeSaveCode, encodeSaveCode } from "../../src/engine/save.ts";
import type { UiTheme } from "../../src/ui/theme.ts";
import type { AnimatedTilesStats } from "../../src/ui/AnimatedTiles.tsx";
import type { MapAnimStats } from "../../src/ui/MapAnimLayer.tsx";
import type { StreamedChunkLayerStats } from "../../src/ui/StreamedChunkLayer.tsx";
import { loadAttractTape } from "../../src/host/attract-tape.ts";
import { buildShowcaseProject } from "./showcase-data.ts";
import { GAME_ASSETS, SHOWCASE_ART } from "./assets-game.ts";
import { SHOWCASE_EXTENSIONS } from "./extensions.ts";
import { showcaseBattleRules } from "./showcase-battle-rules.ts";
import { ShowcaseBattleScene } from "./showcase-battle.tsx";
import { SHOWCASE_TOUR_RUNS } from "./demo-tape.ts";
import { createShowcaseDemo } from "./demo-chapters.ts";

const PROJECT = buildShowcaseProject();
const AudioEffects = createAudioEffects(PROJECT.audio!);
const SCENES = { [NAME_INPUT_SCENE_ID]: nameInputRules } as const;
const SCENE_VIEWS = { [NAME_INPUT_SCENE_ID]: NameInputScene } as const;

const MIDNIGHT: Partial<UiTheme> = {
  border: "#53c8e8",
  rim: "#1d4261",
  paper: "#091a2d",
  ink: "#e8f7ff",
  dim: "#80abc2",
  accent: "#ffe16a",
  backdrop: "#020611ee",
};

const SUNRISE: Partial<UiTheme> = {
  border: "#ffb05c",
  rim: "#8d3f58",
  paper: "#361c43",
  ink: "#fff2df",
  dim: "#dab0bc",
  accent: "#74f1d4",
  backdrop: "#14091bee",
};

export interface ShowcaseDiagnostics {
  stream: Partial<Record<"ground" | "upper", StreamedChunkLayerStats>>;
  animated: Partial<Record<"below" | "above", AnimatedTilesStats>>;
  mapAnim: Partial<Record<"below" | "above", MapAnimStats>>;
  saveCodeRoundTrip: boolean;
}

declare global {
  // Read-only integration probes used by the example's simulator and web smoke.
  // eslint-disable-next-line no-var
  var __showcaseDiagnostics: ShowcaseDiagnostics | undefined;
}

function ShowcaseApp() {
  const project = PROJECT;
  const saveSession = createSession(project, simulationHz(), {
    extensions: SHOWCASE_EXTENSIONS,
    battle: showcaseBattleRules,
    scenes: SCENES,
  });
  const demo = createDemo(createShowcaseDemo(project, saveSession));
  const [sunrise, setSunrise] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuState>({ kind: "closed" });
  const [saveCode, setSaveCode] = createSignal("");
  const [oskText, setOskText] = createSignal("");
  const osk = createOsk({ value: oskText, setValue: setOskText, onCommit: () => {} });
  const diagnostics: ShowcaseDiagnostics = { stream: {}, animated: {}, mapAnim: {}, saveCodeRoundTrip: false };
  globalThis.__showcaseDiagnostics = diagnostics;
  let handledRequest = 0;
  let pendingRequest = 0;
  let saveDemoFrame = -1;

  onFrame(() => {
    const state = globalThis.__rpgSessionState as SessionState | undefined;
    if (!state) return;
    setSunrise(state.sw.switches["showcase.theme.alt"] === true);
    const raw = state.sw.variables["showcase.save.request"];
    const request = typeof raw === "number" ? raw : 0;
    if (request < handledRequest) {
      handledRequest = request;
      pendingRequest = request;
      saveDemoFrame = -1;
      setMenu({ kind: "closed" });
      setSaveCode("");
    }
    if (request > handledRequest) pendingRequest = request;

    if (pendingRequest > handledRequest && canSave(state.move, state.interp, state.scene)) {
      const code = encodeSaveCode(createSessionSnapshot(saveSession, state, 0));
      const restored = decodeSaveCode(code);
      diagnostics.saveCodeRoundTrip = restored.map === state.mapId && restored.interp.frame === state.interp.frame;
      setSaveCode(code);
      setMenu({ kind: "root", index: 2 });
      handledRequest = pendingRequest;
      saveDemoFrame = 0;
    } else if (saveDemoFrame >= 0) {
      saveDemoFrame++;
      if (saveDemoFrame === 75) setMenu({ kind: "code-export", page: 0 });
      if (saveDemoFrame === 225) {
        setMenu({
          kind: "message",
          title: diagnostics.saveCodeRoundTrip ? "IMPORT VERIFIED" : "IMPORT FAILED",
          body: diagnostics.saveCodeRoundTrip
            ? "The exported code decoded to the same safe point."
            : "The save-code round trip did not match.",
          back: { kind: "root", index: 3 },
        });
      }
      if (saveDemoFrame === 330) {
        setMenu({ kind: "closed" });
        saveDemoFrame = -1;
      }
    }
  });

  const theme = () => sunrise() ? SUNRISE : MIDNIGHT;
  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <GameView
        project={project}
        assets={GAME_ASSETS}
        extensions={SHOWCASE_EXTENSIONS}
        battle={showcaseBattleRules}
        battleScene={ShowcaseBattleScene}
        scenes={SCENES}
        sceneViews={SCENE_VIEWS}
        effects={AudioEffects}
        attractTape={loadAttractTape(SHOWCASE_TOUR_RUNS).masks}
        demo={demo}
        theme={theme()}
        choiceIcons={ChoiceIconBox}
        faces={{
          CURATOR: SHOWCASE_ART.face,
          GUIDE: SHOWCASE_ART.guideFace,
          VISITOR: SHOWCASE_ART.visitorFace,
        }}
        onStreamStats={(layer, stats) => { diagnostics.stream[layer] = stats; }}
        onAnimatedStats={(layer, stats) => { diagnostics.animated[layer] = stats; }}
        onMapAnimStats={(layer, stats) => { diagnostics.mapAnim[layer] = stats; }}
      />
      <SaveMenu
        menu={menu}
        hasFs={true}
        slots={() => [
          { slot: 1, map: globalThis.__rpgSessionState?.mapId ?? "showcase-lobby", frame: globalThis.__rpgSessionState?.interp.frame ?? 0, checksum: "live" },
          null,
          null,
        ]}
        saveCode={saveCode}
        osk={osk}
        legend={() => "A next   B back"}
        theme={theme()}
        title="FEATURE GALLERY — SAVE"
      />
    </View>
  );
}

mount(() => <ShowcaseApp />);
