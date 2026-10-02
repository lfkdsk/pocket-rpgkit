// Opt-in connected-world renderer for GameView. This module owns every
// dependency that is unique to component-wide terrain; GameView sees only the
// type-only factory contract in ../world-contract.ts.

import { View } from "@pocketjs/framework/components";
import type { Component, JSX } from "solid-js";
import { clampCamera, followCamera } from "../../engine/camera.ts";
import { cameraFocusAt, screenShakeOffset } from "../../engine/screen.ts";
import { TILE } from "../../engine/tiles.ts";
import type { CameraState, WorldComponent, WorldPlacement } from "../../engine/types.ts";
import {
  createVisibleWorldMapsReader,
  type VisibleWorldMapsReader,
} from "../../engine/world-layout.ts";
import { WorldAnimatedTiles } from "../WorldAnimatedTiles.tsx";
import { WorldStreamedTerrain } from "../WorldStreamedTerrain.tsx";
import type {
  GameViewWorldConfig,
  GameViewWorldFactoryHost,
  GameViewWorldRenderProps,
  GameViewWorldRuntime,
} from "../world-contract.ts";

interface WorldRenderComponent {
  component: WorldComponent;
  visibleMaps: VisibleWorldMapsReader;
}

interface WorldRenderBinding {
  render: WorldRenderComponent;
  placement: WorldPlacement;
}

function createWorldRenderIndex(
  components: readonly WorldComponent[],
  tileSize: number,
): ReadonlyMap<string, WorldRenderBinding> {
  const byMap = new Map<string, WorldRenderBinding>();
  for (const component of components) {
    const render = { component, visibleMaps: createVisibleWorldMapsReader(component, tileSize) };
    for (const placement of component.placements) byMap.set(placement.mapId, { render, placement });
  }
  return byMap;
}

function createRuntime(host: GameViewWorldFactoryHost): GameViewWorldRuntime {
  const index = createWorldRenderIndex(host.layout.components, host.tileSize);
  const localCamera: CameraState = { x: 0, y: 0, facing: 0 };

  const bindingFor = (mapId: string): WorldRenderBinding | undefined => index.get(mapId);

  const WorldView: Component<GameViewWorldRenderProps> = (props) => {
    const binding = (): WorldRenderBinding => bindingFor(props.activeMapId())!;
    const component = (): WorldComponent => binding().render.component;
    const visibleMaps = (): readonly WorldPlacement[] => {
      const groundMargin = props.ground.margin() ?? props.stream.margin ?? TILE;
      const upperMargin = props.upper.margin() ?? props.stream.margin ?? TILE;
      return binding().render.visibleMaps(
        props.camera(),
        props.viewport(),
        Math.max(groundMargin, upperMargin, TILE),
      );
    };
    const ActiveMapPlane = (planeProps: { children?: JSX.Element; debugName: string }) => {
      return (
        <View
          class="absolute"
          style={{
            posType: 1,
            translateX: binding().placement.originTileX * host.tileSize,
            translateY: binding().placement.originTileY * host.tileSize,
          }}
          debugName={planeProps.debugName}
        >
          {planeProps.children}
        </View>
      );
    };

    return (
      <WorldStreamedTerrain
        activeMapId={props.activeMapId}
        component={component}
        visiblePlacements={visibleMaps}
        camera={props.camera}
        viewport={props.viewport}
        chunkPx={props.stream.chunkPx}
        loadTile={props.stream.loadTile}
        active={props.active}
        debugName="rpgkit-world-terrain"
        ground={props.ground}
        upper={props.upper}
        below={(
          <>
            {props.animated ? (
              <WorldAnimatedTiles
                activeMapId={props.activeMapId}
                component={component}
                visibleMaps={visibleMaps}
                tiles={props.animated}
                above={false}
                camera={props.camera}
                viewport={props.viewport}
                active={props.active}
                visible={props.ground.visible}
                debugName="rpgkit-world-anim-below"
                onStats={(stats) => props.onAnimatedStats?.("below", stats)}
              />
            ) : null}
            <ActiveMapPlane debugName="rpgkit-world-active-below">{props.below}</ActiveMapPlane>
          </>
        )}
        actors={(
          <ActiveMapPlane debugName="rpgkit-world-active-actors">
            <View
              class="absolute"
              nodeRef={props.actorHost}
              debugName="rpgkit-world-actors"
            >
              {props.actors}
            </View>
          </ActiveMapPlane>
        )}
        above={(
          <>
            {props.animated ? (
              <WorldAnimatedTiles
                activeMapId={props.activeMapId}
                component={component}
                visibleMaps={visibleMaps}
                tiles={props.animated}
                above
                camera={props.camera}
                viewport={props.viewport}
                active={props.active}
                visible={props.upper.visible}
                debugName="rpgkit-world-anim-above"
                onStats={(stats) => props.onAnimatedStats?.("above", stats)}
              />
            ) : null}
            <ActiveMapPlane debugName="rpgkit-world-active-above">{props.above}</ActiveMapPlane>
          </>
        )}
        onStats={(layer, stats) => props.onStreamStats?.(layer, stats)}
      />
    );
  };

  return {
    View: WorldView,
    hasMap: (mapId) => index.has(mapId),
    frameFor(mapId, viewport) {
      const binding = bindingFor(mapId);
      if (!binding) return undefined;
      const bounds = binding.render.component.bounds;
      const w = (bounds.maxTileX - bounds.minTileX) * host.tileSize;
      const h = (bounds.maxTileY - bounds.minTileY) * host.tileSize;
      return {
        x: w < viewport.w ? (viewport.w - w) / 2 : 0,
        y: h < viewport.h ? (viewport.h - h) / 2 : 0,
        w: Math.min(w, viewport.w),
        h: Math.min(h, viewport.h),
      };
    },
    cameraFor(state, viewport) {
      const binding = bindingFor(state.mapId);
      if (!binding) return undefined;
      const bounds = binding.render.component.bounds;
      const originX = binding.placement.originTileX * host.tileSize;
      const originY = binding.placement.originTileY * host.tileSize;
      const cfg = {
        worldX: bounds.minTileX * host.tileSize,
        worldY: bounds.minTileY * host.tileSize,
        worldW: (bounds.maxTileX - bounds.minTileX) * host.tileSize,
        worldH: (bounds.maxTileY - bounds.minTileY) * host.tileSize,
        viewportW: viewport.w,
        viewportH: viewport.h,
      };
      const debug = host.debugCamera?.();
      if (debug) {
        const clamped = clampCamera(debug.x, debug.y, cfg);
        return { ...clamped, facing: state.move.facing };
      }
      const effect = state.interp.screen;
      if (!effect?.camera && !effect?.shake) {
        return followCamera(
          originX + state.move.px,
          originY + state.move.py,
          host.tileSize,
          state.move.facing,
          cfg,
        );
      }
      const focus = cameraFocusAt(effect.camera, {
        x: state.move.px + host.tileSize / 2,
        y: state.move.py + host.tileSize / 2,
      });
      focus.x += originX;
      focus.y += originY;
      const clamped = clampCamera(focus.x - viewport.w / 2, focus.y - viewport.h / 2, cfg);
      const shake = screenShakeOffset(effect.shake);
      return { x: clamped.x - shake.x, y: clamped.y - shake.y, facing: state.move.facing };
    },
    localCameraFor(mapId, camera) {
      const binding = bindingFor(mapId);
      if (!binding) return undefined;
      localCamera.x = camera.x - binding.placement.originTileX * host.tileSize;
      localCamera.y = camera.y - binding.placement.originTileY * host.tileSize;
      localCamera.facing = camera.facing;
      return localCamera;
    },
  };
}

/** Create the explicit GameView connected-world integration. Import this
 * from `pocket-rpgkit/ui/world` and pass it as `world={createWorldRenderer()}`. */
export function createWorldRenderer(): GameViewWorldConfig {
  return { create: createRuntime };
}
