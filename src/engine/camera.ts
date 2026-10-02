// src/engine/camera.ts — pure camera reducer (docs/SIMULATION.md:
// simulation state is a pure fold over the input tape; no wall clock, no
// Math.random). D-pad moves the focus at a fixed px/frame; position clamps
// to the world; facing switches on pressed direction (vertical wins when
// both axes are held — fixed, documented priority so tapes are stable).

import type { CameraState, Facing } from "./types.ts";

export const VIEW_W = 480;
export const VIEW_H = 272;

/** World size in pixels (everything a position clamp needs). */
export interface WorldSize {
  /** Pixel-space component origin. Omitted for the legacy zero-origin map. */
  worldX?: number;
  worldY?: number;
  worldW: number;
  worldH: number;
}

/** Logical viewport in pixels. Omit it to retain the 480x272 console
 *  contract; desktop GameView callers pass the live host dimensions. */
export interface ViewportSize {
  viewportW?: number;
  viewportH?: number;
}

export interface CameraConfig extends WorldSize {
  /** Pixels per held frame at 60 Hz (slice P1① uses 2). */
  speed: number;
}

export function clampCamera(
  x: number,
  y: number,
  cfg: WorldSize & ViewportSize,
): { x: number; y: number } {
  const viewportW = cfg.viewportW ?? VIEW_W;
  const viewportH = cfg.viewportH ?? VIEW_H;
  const worldX = cfg.worldX ?? 0;
  const worldY = cfg.worldY ?? 0;
  const maxX = worldX + cfg.worldW - viewportW;
  const maxY = worldY + cfg.worldH - viewportH;
  return {
    x: maxX <= worldX ? worldX : Math.max(worldX, Math.min(maxX, x)),
    y: maxY <= worldY ? worldY : Math.max(worldY, Math.min(maxY, y)),
  };
}

export function initialCamera(x: number, y: number, facing: Facing, cfg: CameraConfig): CameraState {
  const c = clampCamera(x, y, cfg);
  return { x: c.x, y: c.y, facing };
}

/** P1② follow camera: keep the mover's tile center in the viewport center
 *  until the world edge pins the camera; the mover then keeps walking to
 *  the edge on screen. `px,py` is the mover top-left in world pixels. */
export function followCamera(
  px: number,
  py: number,
  tile: number,
  facing: Facing,
  cfg: WorldSize & ViewportSize,
): CameraState {
  const viewportW = cfg.viewportW ?? VIEW_W;
  const viewportH = cfg.viewportH ?? VIEW_H;
  const c = clampCamera(px + tile / 2 - viewportW / 2, py + tile / 2 - viewportH / 2, cfg);
  return { x: c.x, y: c.y, facing };
}

/** One frame: buttons is the BTN mask (contracts/spec/spec.ts BTN.*).
 *  Returns a NEW state; the input state is never mutated. */
export function stepCamera(
  s: CameraState,
  buttons: number,
  cfg: CameraConfig,
): CameraState {
  // BTN bit values are read through an injected mask so this engine module
  // stays free of contracts/ imports (pure TS, unit-tested in plain bun).
  let dx = 0;
  let dy = 0;
  if (buttons & BTN_BITS.RIGHT) dx += cfg.speed;
  if (buttons & BTN_BITS.LEFT) dx -= cfg.speed;
  if (buttons & BTN_BITS.DOWN) dy += cfg.speed;
  if (buttons & BTN_BITS.UP) dy -= cfg.speed;
  let facing = s.facing;
  // Deterministic tie-break: a vertical hold overrides a horizontal one
  // (R1 repro/render/shared/scroll.ts parity — keeps both renderers'
  // 120-frame tapes comparable).
  if (dx > 0) facing = 3;
  else if (dx < 0) facing = 1;
  if (dy > 0) facing = 0;
  else if (dy < 0) facing = 2;
  const c = clampCamera(s.x + dx, s.y + dy, cfg);
  return { x: c.x, y: c.y, facing };
}

/** BTN mask bits mirrored from contracts/spec/spec.ts (UP 0x0010,
 *  RIGHT 0x0020, DOWN 0x0040, LEFT 0x0080). Kept literal here so the engine
 *  module has no framework/contracts dependency. */
export const BTN_BITS = {
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
} as const;
