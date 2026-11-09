import type { LayoutEntry } from './edl';

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

/** Round a size down to an even number of pixels (at least 2). */
function evenSize(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** Round an offset down to an even number of pixels (0 allowed). */
function evenOffset(value: number): number {
  return Math.max(0, Math.floor(value / 2) * 2);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * A filter_complex graph that turns input `[0:v]` into a 1080x1920 `[v]`.
 * - crop: a full-height 9:16 window centered at `x` (fraction of width)
 * - stack: left half over right half (or swapped), each cropped to 9:8 around `y`
 * - fit: the whole frame scaled to width over a blurred fill of itself
 */
export function videoGraph(layout: LayoutEntry, sourceWidth: number, sourceHeight: number): string {
  const W = sourceWidth;
  const H = sourceHeight;
  const tail = 'setsar=1,format=yuv420p';
  switch (layout.mode) {
    case 'crop': {
      const width = evenSize(Math.min(W, (H * 9) / 16));
      const x = evenOffset(clamp((layout.x ?? 0.5) * W - width / 2, 0, W - width));
      return `[0:v]crop=${width}:${evenSize(H)}:${x}:0,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos,${tail}[v]`;
    }
    case 'stack': {
      const half = Math.floor(W / 2);
      let width = evenSize(half);
      let height = evenSize((width * 8) / 9);
      if (height > H) {
        height = evenSize(H);
        width = evenSize((height * 9) / 8);
      }
      const y = evenOffset(clamp((layout.y ?? 0.45) * H - height / 2, 0, H - height));
      const inset = evenOffset((half - width) / 2);
      const left = `crop=${width}:${height}:${inset}:${y}`;
      const right = `crop=${width}:${height}:${half + inset}:${y}`;
      const [top, bottom] = layout.swap ? [right, left] : [left, right];
      const size = `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT / 2}:flags=lanczos,setsar=1`;
      return `[0:v]split=2[a][b];[a]${top},${size}[t];[b]${bottom},${size}[u];[t][u]vstack=inputs=2,${tail}[v]`;
    }
    case 'fit':
      return `[0:v]split=2[a][b];` +
        `[a]scale=-2:${OUTPUT_HEIGHT},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},gblur=sigma=40[bg];` +
        `[b]scale=${OUTPUT_WIDTH}:-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail}[v]`;
  }
}
