// tools/lib/walker-slice.ts — cutting a grid walker sheet into the engine's
// twelve static frames (4 facings x idle/step-L/step-R), as raw RGBA.
//
// Pure and host-free (no node: or Bun imports): the asset baker
// (tools/lib/bake.ts) encodes these frames as PNGs at build time, and the
// preview page (tools/preview) uploads them as textures when a frontend
// supplies a project's walker sheet at run time. Both cut the same pixels.

/** Decoded RGBA8 pixels, row-major, `width * height * 4` bytes. */
export interface SheetImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Where each engine facing/pose lives on a source sheet. */
export interface WalkerSheetLayout {
  /** Engine facing index (0 down,1 left,2 up,3 right) -> sheet row. */
  rowForFacing: readonly [number, number, number, number];
  /** Sheet columns for the three poses. */
  idleCol: number;
  walkLCol: number;
  walkRCol: number;
}

export interface WalkerSheetOptions {
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  layout?: WalkerSheetLayout;
}

/**
 * The Tuxemon character sheet: 3 columns x 4 rows of 16x32 cells.
 * Rows run down, left, RIGHT, up; columns run walk-L, idle, walk-R. The
 * engine facing order is down, left, UP, right, so rows 2 and 3 swap.
 * (Scout S1 §8: sprites/<name>.png 48x128; idle is the middle column.)
 */
export const TUXEMON_WALKER_LAYOUT: WalkerSheetLayout = {
  rowForFacing: [0, 1, 3, 2], // engine down,left,up,right <- sheet rows
  idleCol: 1,
  walkLCol: 0,
  walkRCol: 2,
};

/** Twelve raw RGBA frames cut from a sheet, in engine facing order
 *  (0 down, 1 left, 2 up, 3 right) per pose. Each frame is cellW x cellH. */
export interface WalkerRgbaFrames {
  idle: Uint8Array[];
  walkL: Uint8Array[];
  walkR: Uint8Array[];
  /** Frame width in pixels (always 16 for the kit). */
  cellW: number;
  /** Frame height in pixels (16 square or 32 for a Tuxemon walker). */
  cellH: number;
}

/** Slice decoded walker pixels (default a Tuxemon 3x4 of 16x32 cells) into
 *  twelve raw RGBA frames in engine order. Throws (naming `source`) when
 *  the sheet size or the layout does not match the declared grid. */
export function sliceWalkerFrames(
  png: SheetImage,
  opts: WalkerSheetOptions = {},
  source = "walker sheet",
): WalkerRgbaFrames {
  const cellW = opts.cellW ?? 16;
  const cellH = opts.cellH ?? 32;
  const cols = opts.cols ?? 3;
  const rows = opts.rows ?? 4;
  const layout = opts.layout ?? TUXEMON_WALKER_LAYOUT;
  if (
    !Number.isInteger(cellW) || cellW < 1 ||
    !Number.isInteger(cellH) || cellH < 1 ||
    !Number.isInteger(cols) || cols < 1 ||
    !Number.isInteger(rows) || rows < 1
  ) {
    throw new Error(`${source}: walker grid and cell sizes must be positive integers`);
  }
  if (png.width !== cols * cellW || png.height !== rows * cellH) {
    throw new Error(`${source}: expected a ${cols}x${rows} sheet of ${cellW}x${cellH} cells, got ${png.width}x${png.height}`);
  }
  const poseColumns = [layout.idleCol, layout.walkLCol, layout.walkRCol];
  if (
    layout.rowForFacing.some((row) => !Number.isInteger(row) || row < 0 || row >= rows) ||
    poseColumns.some((col) => !Number.isInteger(col) || col < 0 || col >= cols)
  ) {
    throw new Error(`${source}: walker layout addresses a cell outside the ${cols}x${rows} sheet`);
  }
  const copy = (col: number, row: number): Uint8Array => {
    const out = new Uint8Array(cellW * cellH * 4);
    for (let y = 0; y < cellH; y++) {
      const src = ((row * cellH + y) * png.width + col * cellW) * 4;
      out.set(png.rgba.subarray(src, src + cellW * 4), y * cellW * 4);
    }
    return out;
  };
  const cut = (col: number): Uint8Array[] =>
    [0, 1, 2, 3].map((facing) => copy(col, layout.rowForFacing[facing]!));
  return {
    idle: cut(layout.idleCol),
    walkL: cut(layout.walkLCol),
    walkR: cut(layout.walkRCol),
    cellW,
    cellH,
  };
}
