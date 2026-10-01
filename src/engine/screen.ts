// src/engine/screen.ts — deterministic, saveable map-presentation effects.
//
// Every duration is compiled to the fixed 60 Hz reference clock before it
// reaches this module. The reducer stores only JSON values and advances them
// one reference tick at a time: no host clock, CSS animation or random source
// participates. The UI merely projects these descriptors into pixels.

import { keyedRecord } from "./clone.ts";
import type { ScreenColor } from "./types.ts";

export const TRANSPARENT_BLACK: Readonly<ScreenColor> = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
export const OPAQUE_BLACK: Readonly<ScreenColor> = Object.freeze({ r: 0, g: 0, b: 0, a: 255 });

export interface ColorTweenState {
  from: ScreenColor;
  to: ScreenColor;
  total: number;
  left: number;
}

export interface FadeEffectState extends ColorTweenState {
  /** Fade-in removes the retained mask at the end; fade-out keeps it. */
  clear: boolean;
}

export interface ShakeEffectState {
  strength: number;
  /** Complete horizontal cycles per virtual second. */
  speed: number;
  total: number;
  left: number;
}

export interface CameraEffectState {
  /** `follow` removes this descriptor at completion and resumes live player
   * follow. `fixed` retains the destination focus after the tween. */
  mode: "fixed" | "follow";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  total: number;
  left: number;
}

export interface BalloonEffectState {
  target: "player" | { event: string };
  icon: string;
  /** Last resolved tile, used only if a followed event disappears. */
  x: number;
  y: number;
  /** Reference ticks already displayed. */
  age: number;
  /** null means persistent until an explicit clear. */
  left: number | null;
}

export interface ScreenBackdropState {
  /** GameAssets.layers key; it must have placement:"screen". */
  layer: string;
  /** Prepackaged variant in that screen layer. */
  variant: string;
}

/** Sparse presentation state. It is omitted entirely for projects which do
 * not use these commands, keeping their save shape and hot path unchanged. */
export interface ScreenEffectsState {
  fade?: FadeEffectState;
  tints?: Record<string, ColorTweenState>;
  flash?: ColorTweenState;
  shake?: ShakeEffectState;
  camera?: CameraEffectState;
  balloons?: Record<string, BalloonEffectState>;
  backdrop?: ScreenBackdropState;
}

function cloneColor(color: Readonly<ScreenColor>): ScreenColor {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

function cloneTween<T extends ColorTweenState>(tween: T): T {
  return { ...tween, from: cloneColor(tween.from), to: cloneColor(tween.to) };
}

export function cloneScreenEffects(source: ScreenEffectsState | undefined): ScreenEffectsState | undefined {
  if (!source) return undefined;
  const out: ScreenEffectsState = {};
  if (source.fade) out.fade = cloneTween(source.fade);
  if (source.tints) {
    const tints = keyedRecord<ColorTweenState>();
    for (const id of Object.keys(source.tints)) tints[id] = cloneTween(source.tints[id]!);
    out.tints = tints;
  }
  if (source.flash) out.flash = cloneTween(source.flash);
  if (source.shake) out.shake = { ...source.shake };
  if (source.camera) out.camera = { ...source.camera };
  if (source.balloons) {
    const balloons = keyedRecord<BalloonEffectState>();
    for (const id of Object.keys(source.balloons)) {
      const balloon = source.balloons[id]!;
      balloons[id] = {
        ...balloon,
        target: typeof balloon.target === "string" ? balloon.target : { ...balloon.target },
      };
    }
    out.balloons = balloons;
  }
  if (source.backdrop) out.backdrop = { ...source.backdrop };
  return out;
}

export function screenEffectsEmpty(screen: ScreenEffectsState): boolean {
  return screen.fade === undefined && screen.tints === undefined &&
    screen.flash === undefined && screen.shake === undefined &&
    screen.camera === undefined && screen.balloons === undefined &&
    screen.backdrop === undefined;
}

export function colorAt(tween: Readonly<ColorTweenState>): ScreenColor {
  if (tween.total <= 0 || tween.left <= 0) return cloneColor(tween.to);
  const elapsed = tween.total - tween.left;
  const channel = (from: number, to: number): number =>
    Math.round((from * (tween.total - elapsed) + to * elapsed) / tween.total);
  return {
    r: channel(tween.from.r, tween.to.r),
    g: channel(tween.from.g, tween.to.g),
    b: channel(tween.from.b, tween.to.b),
    a: channel(tween.from.a, tween.to.a),
  };
}

/** Flatten named tint layers in stable id order. Because every layer is a
 * uniform source-over colour, one equivalent RGBA overlay is sufficient for
 * the renderer and avoids a variable number of native nodes. */
export function compositeScreenTints(
  tints: Readonly<Record<string, ColorTweenState>> | undefined,
): ScreenColor {
  if (!tints) return { ...TRANSPARENT_BLACK };
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const id of Object.keys(tints).sort()) {
    const color = colorAt(tints[id]!);
    const sourceAlpha = color.a / 255;
    const keep = 1 - sourceAlpha;
    red = color.r * sourceAlpha + red * keep;
    green = color.g * sourceAlpha + green * keep;
    blue = color.b * sourceAlpha + blue * keep;
    alpha = sourceAlpha + alpha * keep;
  }
  if (alpha <= 0) return { ...TRANSPARENT_BLACK };
  return {
    r: Math.round(red / alpha),
    g: Math.round(green / alpha),
    b: Math.round(blue / alpha),
    a: Math.round(alpha * 255),
  };
}

function tween(from: Readonly<ScreenColor>, to: Readonly<ScreenColor>, frames: number): ColorTweenState {
  return { from: cloneColor(from), to: cloneColor(to), total: frames, left: frames };
}

/** Advance one visible map-presentation reference tick. */
export function advanceScreenEffects(
  screen: ScreenEffectsState | undefined,
): ScreenEffectsState | undefined {
  if (!screen) return undefined;

  const advanceTween = (value: ColorTweenState): void => {
    if (value.left > 0) value.left--;
  };

  if (screen.fade) {
    advanceTween(screen.fade);
    if (screen.fade.left === 0) {
      if (screen.fade.clear) delete screen.fade;
      else screen.fade = { ...tween(screen.fade.to, screen.fade.to, 0), clear: false };
    }
  }

  if (screen.tints) {
    for (const id of Object.keys(screen.tints)) {
      const tint = screen.tints[id]!;
      advanceTween(tint);
      if (tint.left === 0) {
        if (tint.to.a === 0) delete screen.tints[id];
        else screen.tints[id] = tween(tint.to, tint.to, 0);
      }
    }
    if (Object.keys(screen.tints).length === 0) delete screen.tints;
  }

  if (screen.flash) {
    advanceTween(screen.flash);
    if (screen.flash.left === 0) delete screen.flash;
  }
  if (screen.shake) {
    if (screen.shake.left > 0) screen.shake.left--;
    if (screen.shake.left === 0) delete screen.shake;
  }
  if (screen.camera) {
    if (screen.camera.left > 0) screen.camera.left--;
    if (screen.camera.left === 0) {
      if (screen.camera.mode === "follow") delete screen.camera;
      else {
        const { toX, toY } = screen.camera;
        screen.camera = {
          mode: "fixed",
          fromX: toX,
          fromY: toY,
          toX,
          toY,
          total: 0,
          left: 0,
        };
      }
    }
  }
  if (screen.balloons) {
    for (const id of Object.keys(screen.balloons)) {
      const balloon = screen.balloons[id]!;
      balloon.age++;
      if (balloon.left !== null) {
        balloon.left--;
        if (balloon.left <= 0) delete screen.balloons[id];
      }
    }
    if (Object.keys(screen.balloons).length === 0) delete screen.balloons;
  }
  return screenEffectsEmpty(screen) ? undefined : screen;
}

/** Preserve long-lived presentation layers across a transfer. Camera,
 * character balloons and transient flash/shake are map-local and clear. */
export function screenEffectsAfterTransfer(
  source: ScreenEffectsState | undefined,
): ScreenEffectsState | undefined {
  const screen = cloneScreenEffects(source);
  if (!screen) return undefined;
  delete screen.flash;
  delete screen.shake;
  delete screen.camera;
  delete screen.balloons;
  return screenEffectsEmpty(screen) ? undefined : screen;
}

export function startScreenFade(
  screen: ScreenEffectsState,
  direction: "out" | "in",
  color: Readonly<ScreenColor>,
  frames: number,
): void {
  const current = screen.fade ? colorAt(screen.fade) : null;
  if (direction === "out") {
    const from = current ?? { ...color, a: 0 };
    screen.fade = { ...tween(from, color, frames), clear: false };
    if (frames === 0) screen.fade = { ...tween(color, color, 0), clear: false };
    return;
  }
  const from = current ?? color;
  if (frames === 0) {
    delete screen.fade;
    return;
  }
  screen.fade = { ...tween(from, { ...color, a: 0 }, frames), clear: true };
}

export function startScreenTint(
  screen: ScreenEffectsState,
  layer: string,
  color: Readonly<ScreenColor>,
  frames: number,
): void {
  if (!screen.tints) screen.tints = keyedRecord();
  const prior = screen.tints[layer];
  const from = prior ? colorAt(prior) : { ...color, a: 0 };
  if (frames === 0 && color.a === 0) {
    delete screen.tints[layer];
    if (Object.keys(screen.tints).length === 0) delete screen.tints;
    return;
  }
  screen.tints[layer] = tween(frames === 0 ? color : from, color, frames);
}

export function startScreenFlash(
  screen: ScreenEffectsState,
  color: Readonly<ScreenColor>,
  intensity: number,
  frames: number,
): void {
  if (frames === 0 || intensity === 0 || color.a === 0) {
    delete screen.flash;
    return;
  }
  const peak = { ...color, a: Math.round(color.a * intensity / 255) };
  screen.flash = tween(peak, { ...peak, a: 0 }, frames);
}

export function startScreenShake(
  screen: ScreenEffectsState,
  strength: number,
  speed: number,
  frames: number,
): void {
  if (frames === 0 || strength === 0 || speed === 0) {
    delete screen.shake;
    return;
  }
  screen.shake = { strength, speed, total: frames, left: frames };
}

export interface Point {
  x: number;
  y: number;
}

export function cameraFocusAt(
  camera: Readonly<CameraEffectState> | undefined,
  player: Readonly<Point>,
): Point {
  if (!camera) return { x: player.x, y: player.y };
  if (camera.total <= 0 || camera.left <= 0) {
    return camera.mode === "follow" ? { x: player.x, y: player.y } : { x: camera.toX, y: camera.toY };
  }
  const elapsed = camera.total - camera.left;
  const toX = camera.mode === "follow" ? player.x : camera.toX;
  const toY = camera.mode === "follow" ? player.y : camera.toY;
  return {
    x: Math.round((camera.fromX * (camera.total - elapsed) + toX * elapsed) / camera.total),
    y: Math.round((camera.fromY * (camera.total - elapsed) + toY * elapsed) / camera.total),
  };
}

export function startCameraEffect(
  screen: ScreenEffectsState,
  mode: "fixed" | "follow",
  from: Readonly<Point>,
  to: Readonly<Point>,
  frames: number,
): void {
  if (mode === "follow" && frames === 0) {
    delete screen.camera;
    return;
  }
  screen.camera = {
    mode,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    total: frames,
    left: frames,
  };
}

/** Horizontal deterministic triangle wave. Screen overlays and HUD are not
 * displaced; GameView adds this after camera clamping to the map scene. */
export function screenShakeOffset(shake: Readonly<ShakeEffectState> | undefined): Point {
  if (!shake || shake.left <= 0 || shake.total <= 0) return { x: 0, y: 0 };
  const elapsed = shake.total - shake.left;
  const quarter = Math.floor(elapsed * shake.speed * 4 / 60) & 3;
  const phase = quarter === 1 ? 1 : quarter === 3 ? -1 : 0;
  return { x: Math.round(shake.strength * phase), y: 0 };
}

/** One stable key per target, matching Tuxemon's one-bubble-per-entity map. */
export function balloonTargetKey(target: BalloonEffectState["target"]): string {
  return target === "player" ? "player" : `event:${target.event}`;
}
