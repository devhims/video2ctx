/**
 * `fit`: centre a scene's drawing in the area it owns and size it to fill that area.
 *
 * A scene marks its drawing with `data-fit` (an absolutely positioned layer covering the frame, or an
 * SVG group in a full-frame SVG); its background stays put. `fit` renders the scene on its own,
 * measures what is drawn, and stores a translate and scale that `overlay` applies to that element.
 */

/** Where a scene's drawing belongs, on the 1080x1920 frame. */
export const FIT_AREAS = {
  /** Below the seam captions, above YouTube's bottom UI. */
  bottom: { centerX: 540, centerY: 1225, maxWidth: 900, maxHeight: 410 },
  /** Below the wordmark, above the low captions. */
  full: { centerX: 540, centerY: 830, maxWidth: 900, maxHeight: 1000 },
} as const;
/** Small drawings scale up to fill, but never past this. */
export const FIT_MAX_SCALE = 1.6;
/** A pixel counts as drawn when it is this much brighter than the scene's background. */
export const FIT_CONTRAST = 28;

export interface SceneFit {
  /** Translate, in px of the 1080x1920 frame. */
  x: number;
  y: number;
  scale: number;
  /** The drawing's measured centre, used as the transform origin. */
  originX: number;
  originY: number;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Box of the pixels brighter than the background in a grayscale frame (one byte per pixel). The
 * background level is taken from the frame's left and right edges, which a centred scene leaves empty.
 */
export function drawnBox(gray: Uint8Array, width: number, height: number, rows: [number, number] = [0, height]): Box | undefined {
  const [top, bottom] = [Math.max(0, rows[0]), Math.min(height, rows[1])];
  const edge: number[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (const x of [0, 1, width - 2, width - 1]) edge.push(gray[y * width + x]!);
  }
  edge.sort((a, b) => a - b);
  const background = edge[Math.floor(edge.length * 0.95)] ?? 0;
  const limit = background + FIT_CONTRAST;
  let box: Box | undefined;
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x]! <= limit) continue;
      if (!box) box = { x1: x, y1: y, x2: x + 1, y2: y + 1 };
      else {
        box.x1 = Math.min(box.x1, x);
        box.x2 = Math.max(box.x2, x + 1);
        box.y1 = Math.min(box.y1, y);
        box.y2 = Math.max(box.y2, y + 1);
      }
    }
  }
  return box;
}

/** Smallest box holding every given box. */
export function unionBox(boxes: Array<Box | undefined>): Box | undefined {
  const found = boxes.filter((box): box is Box => Boolean(box));
  if (!found.length) return undefined;
  return {
    x1: Math.min(...found.map((box) => box.x1)),
    y1: Math.min(...found.map((box) => box.y1)),
    x2: Math.max(...found.map((box) => box.x2)),
    y2: Math.max(...found.map((box) => box.y2)),
  };
}

/** The translate and scale that centre `box` in its area and fill it, scaling about the box's centre. */
export function fitFor(box: Box, mode: keyof typeof FIT_AREAS): SceneFit {
  const area = FIT_AREAS[mode];
  const width = Math.max(1, box.x2 - box.x1);
  const height = Math.max(1, box.y2 - box.y1);
  const originX = (box.x1 + box.x2) / 2;
  const originY = (box.y1 + box.y2) / 2;
  const scale = Math.min(FIT_MAX_SCALE, area.maxWidth / width, area.maxHeight / height);
  return {
    x: Math.round(area.centerX - originX),
    y: Math.round(area.centerY - originY),
    scale: Math.round(scale * 1_000) / 1_000,
    originX: Math.round(originX),
    originY: Math.round(originY),
  };
}

/** CSS that applies a fit to the scene's `[data-fit]` element. */
export function fitCss(fit: SceneFit): string {
  return `[data-fit] { transform-origin: ${fit.originX}px ${fit.originY}px; transform: translate(${fit.x}px, ${fit.y}px) scale(${fit.scale}); }`;
}

const FIT_STYLE = /<style data-fit-style>[\s\S]*?<\/style>\n?/g;

/** A scene file with its fit applied: the rule goes in a marked style block just inside `<template>`. */
export function applyFit(sceneHtml: string, fit: SceneFit): string {
  const clean = sceneHtml.replace(FIT_STYLE, '');
  return clean.replace(/<template>\n?/, (open) => `${open}<style data-fit-style>${fitCss(fit)}</style>\n`);
}

/** Whether a scene file marks the drawing to fit. */
export function hasFitTarget(sceneHtml: string): boolean {
  return /\sdata-fit[\s>=]/.test(sceneHtml);
}

/** A scene file ready to measure on its own: no applied fit and no sounds (their files aren't there). */
export function forMeasuring(sceneHtml: string): string {
  return sceneHtml.replace(FIT_STYLE, '').replace(/<audio\b[^>]*>(?:\s*<\/audio>)?/g, '');
}
