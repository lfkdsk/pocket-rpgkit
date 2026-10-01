// tools/web/fit.ts — the player page's screen sizing, kept free of the DOM
// so bun test can check it (tests/web-site.test.ts). tools/web/player.js
// calls fitViewport() whenever the page or the device pixel ratio changes.
//
// Each logical game pixel covers k x k DEVICE pixels. k is a whole multiple
// of the app's raster density, so every raster sample also covers a whole
// number of device pixels. image-rendering: pixelated therefore keeps both
// high-density text and 1x pixel art sharp at fractional devicePixelRatio.

export type Size = [number, number];

export type ViewportConfig =
  | { policy: "fixed"; logical: Size }
  | { policy: "dynamic"; default: Size; min: Size; max: Size };

export interface Fit {
  /** The logical viewport to run. */
  size: Size;
  /** Device pixels per logical game pixel. This is a whole multiple of the
   *  raster density; 0 when one raster sample per device pixel does not fit,
   *  and the page then shrinks the canvas. */
  k: number;
}

/**
 * Fit a viewport into an area of `areaWidth` x `areaHeight` CSS pixels.
 *
 * fixed    the logical size stays; k is the largest scale that fits.
 * dynamic  the logical size follows the area: k is the largest scale that
 *          keeps the viewport at or above the manifest's minimum, the area
 *          is never taller than the app's default shape, and the size is
 *          capped at the maximum.
 */
export function fitViewport(
  viewport: ViewportConfig,
  areaWidth: number,
  areaHeight: number,
  dpr: number,
  rasterDensity = 1,
): Fit {
  if (!Number.isInteger(rasterDensity) || rasterDensity < 1) {
    throw new RangeError(`rasterDensity must be a positive integer, got ${rasterDensity}`);
  }
  if (viewport.policy === "dynamic") {
    const [defaultW, defaultH] = viewport.default;
    const [minW, minH] = viewport.min;
    const [maxW, maxH] = viewport.max;
    const height = Math.min(areaHeight, (areaWidth * defaultH) / defaultW);
    const deviceW = Math.floor(areaWidth * dpr);
    const deviceH = Math.floor(height * dpr);
    const largest = Math.min(64, Math.floor(deviceW / minW), Math.floor(deviceH / minH));
    const k = largest - (largest % rasterDensity);
    if (k === 0) return { size: [minW, minH], k: 0 };
    return { size: [Math.min(maxW, Math.floor(deviceW / k)), Math.min(maxH, Math.floor(deviceH / k))], k };
  }
  const [w, h] = viewport.logical;
  const largest = Math.min(Math.floor((areaWidth * dpr) / w), Math.floor((areaHeight * dpr) / h));
  const k = largest - (largest % rasterDensity);
  return { size: [w, h], k: Math.max(0, k) };
}
