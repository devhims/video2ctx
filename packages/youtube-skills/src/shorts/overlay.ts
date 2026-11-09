import { normalizeToken, phraseTokens } from './transcript';
import type { CaptionWord, LayoutMode, RenderSegment, ResolvedShort } from './edl';
import type { Box, FaceSample } from './faces';

/** Channel look shared by every short. Colours are CSS colours. */
export interface Brand {
  /** Wordmark lines, top to bottom, e.g. ["the", "INNER", "SCORECARD"]. */
  wordmark?: string[];
  /** Tag after the wordmark's divider, e.g. "CLIPS". */
  wordmarkTag?: string;
  /** Highlight bars and caption keywords. */
  accent?: string;
  /** Card labels and rules. */
  label?: string;
  /** "Watch the full episode" card with the source video's thumbnail, after the last word. */
  endCard?: EndCard;
}

export interface EndCard {
  /** Lines above the thumbnail; the last sits on the accent bar. Defaults to ["Watch the", "Full episode"]. */
  heading?: string[];
  /** Line under the thumbnail, e.g. "on The Inner Scorecard". */
  channel?: string;
  /** Points at the Short's related-video link, the only tappable path in Shorts. Defaults to "Tap the link below"; "" hides it. */
  cta?: string;
}

/** snap: quick 1.16x; push: slow 1.15x over a second; punch: hard 1.22x with a bass hit. */
export type ZoomKind = 'snap' | 'push' | 'punch';

export interface OverlayZoom {
  atPhrase?: string;
  atSec?: number;
  kind?: ZoomKind;
  scale?: number;
  /** Seconds held at full zoom before easing back. */
  holdSec?: number;
  /** Plays the zoom's sound (a whoosh on snap, a bass hit on punch). Defaults to punch only. */
  sound?: boolean;
}

/**
 * A hand-made HyperFrames scene (a `<template>` sub-composition file) mounted over the footage.
 * `bottom` covers the lower half and keeps the speaker in view above it; `full` covers the frame.
 */
export interface OverlayScene {
  src: string;
  mode: 'bottom' | 'full';
  atPhrase?: string;
  atSec?: number;
  /** Ends as this phrase starts... */
  endPhrase?: string;
  /** ...or after this many seconds. */
  durationSec?: number;
  /** A bottom scene grows to cover the frame from this phrase or second. */
  expandAtPhrase?: string;
  expandAtSec?: number;
  /** false drops the whoosh as the scene opens. */
  enterSound?: boolean;
  /** true adds a whoosh as the scene closes. */
  exitSound?: boolean;
}

/** Bundled HyperFrames sound effects the overlay uses, keyed by library name. */
export type SfxKey = 'riser' | 'impact-bass-1' | 'click-soft' | 'pop' | 'whoosh-short' | 'whoosh';
/** Seconds from the start of each bundled sample to its peak, measured with `hyperframes audio`. */
export const SFX_PEAK: Record<SfxKey, number> = {
  riser: 3.472, 'impact-bass-1': 0.073, 'click-soft': 0.073, pop: 0.12, 'whoosh-short': 0.162, whoosh: 0.162,
};
export const OVERLAY_SFX = Object.keys(SFX_PEAK) as SfxKey[];

export interface Speaker {
  name: string;
  role?: string;
  label?: string;
}

export interface OverlayCard {
  label: string;
  title: string;
  body?: string;
  source?: string;
  /** Show from the first caption word matching this phrase... */
  atPhrase?: string;
  /** ...or from this second of the short. */
  atSec?: number;
  durationSec?: number;
}

export interface ShortOverlay {
  /** Speaker id from `speakers` to introduce with a name tag. */
  nameTag?: { speaker: string; atSec?: number; atPhrase?: string; durationSec?: number };
  /** A photo shown beside the hook, e.g. of a person the hook names. `src` is a local image file. */
  hookImage?: { src: string; alt?: string };
  /** Caption words to colour with the accent (matched ignoring case and punctuation). */
  emphasis?: string[];
  cards?: OverlayCard[];
  /** Camera moves on the speaker for key lines. One every 10 to 15 s at most. */
  zooms?: OverlayZoom[];
  scenes?: OverlayScene[];
}

export interface TimelineSegment {
  startSec: number;
  endSec: number;
  mode: LayoutMode;
}

export interface CaptionGroup {
  startSec: number;
  endSec: number;
  words: Array<{ text: string; emphasis: boolean }>;
  mode: LayoutMode;
}

interface Timed {
  startSec: number;
  endSec: number;
}

const HOOK_SEC = 3;
/** Gaps between caption groups shorter than this keep the earlier group on screen. */
const HOLD_GAP_SEC = 1;
/** The end card plays after the last word, on a blurred freeze of the final frame. */
export const END_CARD_SEC = 2.8;
const FRAME_SEC = 1 / 30;
/** Zooms closer together than this are reported as busy. */
const ZOOM_MIN_GAP_SEC = 6;
const ZOOMS: Record<ZoomKind, { scale: number; inSec: number; ease: string; holdSec: number; sfx?: SfxKey }> = {
  snap: { scale: 1.16, inSec: 0.14, ease: 'power3.out', holdSec: 1.2, sfx: 'whoosh-short' },
  push: { scale: 1.15, inSec: 1, ease: 'power2.out', holdSec: 0.6 },
  punch: { scale: 1.22, inSec: 0.12, ease: 'power3.out', holdSec: 0.9, sfx: 'impact-bass-1' },
};
const ZOOM_RELEASE_SEC = 0.4;
const CARD_SEC = 4.5;
const NAME_TAG_SEC = 3.6;
/** Caption block top edge per layout, on the 1080x1920 frame. */
/** Captions sit low on single-person shots, inside this band, and on the seam of split screens. */
const CAPTION_BAND: [number, number] = [1150, 1560];
const CAPTION_LOW = 1422;
const CAPTION_HEIGHT = 102;
const SEAM_CAPTION_TOP = 960 - CAPTION_HEIGHT / 2;
/** Share of a padded face box above the brows (forehead), which headings may cover. */
const BROW_LINE = 0.3;
/** Headings (hook, name tag, cards, end card) start this far below the wordmark. */
const HEADING_GAP = 48;
/** Diameter of the round photo beside a hook. */
const HOOK_IMAGE_SIZE = 220;
/** Vertical slot for the hook, name tag, cards, and end card. */
const TOP_SLOT_Y = 236;

/** Map each render segment onto the short's own timeline. */
export function timelineSegments(segments: RenderSegment[]): TimelineSegment[] {
  let offset = 0;
  return segments.map((segment) => {
    const startSec = offset;
    offset += (segment.outMs - segment.inMs) / 1_000;
    return { startSec, endSec: offset, mode: segment.layout.mode };
  });
}

function modeAt(segments: TimelineSegment[], atSec: number): LayoutMode {
  return segments.find((segment) => atSec >= segment.startSec && atSec < segment.endSec)?.mode
    ?? segments.at(-1)?.mode ?? 'crop';
}

/**
 * Group words into 1 to 3 word captions that break at punctuation, pauses of 150 ms or more,
 * and layout changes, so a group never straddles a jump from crop to stack.
 */
export function captionGroups(words: CaptionWord[], segments: TimelineSegment[], emphasis: string[] = [], maxWords = 3): CaptionGroup[] {
  // Single words, plus whole phrases for glossary corrections that became one caption word ("Hugging Face").
  const emphasized = new Set([...emphasis.flatMap(phraseTokens), ...emphasis.map(normalizeToken)]);
  const groups: CaptionGroup[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (!current.length) return;
    const startSec = current[0]!.startMs / 1_000;
    groups.push({
      startSec,
      endSec: current.at(-1)!.endMs / 1_000,
      mode: modeAt(segments, startSec + 0.05),
      words: current.map((word) => ({ text: word.text, emphasis: emphasized.has(normalizeToken(word.text)) })),
    });
    current = [];
  };
  for (const word of words) {
    const previous = current.at(-1);
    if (previous) {
      const pause = word.startMs - previous.endMs >= 150;
      const modeChange = modeAt(segments, word.startMs / 1_000 + 0.05) !== modeAt(segments, current[0]!.startMs / 1_000 + 0.05);
      if (pause || modeChange) flush();
    }
    current.push(word);
    if (current.length >= maxWords || /[.?!,;:]["')\]]*$/.test(word.text)) flush();
  }
  flush();
  // Hold each group until the next one starts, so captions never blink off mid-sentence.
  for (let index = 0; index < groups.length; index += 1) {
    const next = groups[index + 1];
    const group = groups[index]!;
    if (!next) {
      group.endSec = Math.max(group.endSec, group.startSec + 0.6);
    } else if (next.startSec - group.endSec < HOLD_GAP_SEC) {
      group.endSec = next.startSec;
    } else {
      group.endSec = Math.min(Math.max(group.endSec, group.startSec + 0.3), next.startSec);
    }
  }
  return groups;
}

function findPhraseSec(words: CaptionWord[], phrase: string | undefined): number | undefined {
  if (!phrase) return undefined;
  const tokens = phraseTokens(phrase);
  // Split each caption word into tokens so a glossary correction ("Hugging Face") still matches word by word.
  const flat = words.flatMap((word) => phraseTokens(word.text).map((token) => ({ token, startMs: word.startMs })));
  for (let index = 0; index + tokens.length <= flat.length; index += 1) {
    if (tokens.every((token, offset) => flat[index + offset]!.token === token)) return flat[index]!.startMs / 1_000;
  }
  return undefined;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sec = (value: number) => Number(value.toFixed(3));

/** Caption font size that keeps a group on one line inside ~900 px. */
function captionSize(text: string): number {
  return Math.max(48, Math.min(78, Math.floor(900 / (Math.max(text.length, 1) * 0.6))));
}

/** Text stays between the top status bar and YouTube's caption, handle, and button area. */
const TEXT_TOP = 180;
const TEXT_BOTTOM = 1560;
const FULL_WIDTH: [number, number] = [60, 1020];
const CARD_X: [number, number] = [48, 808];
/** The wordmark's corner (top right), kept clear like a face. */
const WORDMARK_BOX: Box = { x: 730, y: 170, w: 320, h: 92 };

/** Typical face areas for each framing, used when face detection is unavailable. */
export function typicalFaces(segments: TimelineSegment[]): FaceSample[] {
  const zones: Record<LayoutMode, Box[]> = {
    crop: [{ x: 120, y: 380, w: 840, h: 980 }],
    stack: [{ x: 200, y: 120, w: 680, h: 700 }, { x: 200, y: 1080, w: 680, h: 700 }],
    fit: [{ x: 200, y: 700, w: 680, h: 520 }],
  };
  const samples: FaceSample[] = [];
  for (const segment of segments) {
    for (let atSec = segment.startSec; atSec < segment.endSec; atSec += 0.5) samples.push({ atSec, boxes: zones[segment.mode] });
  }
  return samples;
}

function samplesDuring(samples: FaceSample[], startSec: number, endSec: number): Box[][] {
  const during = samples.filter((sample) => sample.atSec >= startSec - 0.25 && sample.atSec <= endSec + 0.25).map((sample) => sample.boxes);
  return during.length ? during : [[]];
}

function overlapArea(y: number, height: number, [x0, x1]: [number, number], boxes: Box[]): number {
  return boxes.reduce((total, box) => {
    const w = Math.max(0, Math.min(x1, box.x + box.w) - Math.max(x0, box.x));
    const h = Math.max(0, Math.min(y + height, box.y + box.h) - Math.max(y, box.y));
    return total + w * h;
  }, 0);
}

/**
 * The top edge nearest `preferred` where a block of `height` covers no face. Faces are given per
 * sample over the block's time on screen and scored by average overlap, so a brief head movement
 * does not rule out a spot. When every position covers a face, the one covering the least.
 */
export function placeY(
  height: number,
  preferred: number,
  xRange: [number, number],
  samples: Box[][],
  fixed: Box[] = [],
  bands: Array<[number, number]> = [[TEXT_TOP, TEXT_BOTTOM]],
): { y: number; overlap: number } {
  const frames = samples.length ? samples : [[]];
  let best = { y: preferred, overlap: Number.POSITIVE_INFINITY, distance: Number.POSITIVE_INFINITY };
  const tops = bands.flatMap(([top, bottom]) => {
    const list: number[] = [];
    for (let y = Math.max(TEXT_TOP, top); y + height <= Math.min(TEXT_BOTTOM, bottom); y += 8) list.push(y);
    return list;
  });
  for (const y of tops.length ? tops : [Math.max(TEXT_TOP, Math.min(preferred, TEXT_BOTTOM - height))]) {
    // Fixed boxes (the wordmark, other titles and cards) are hard limits; faces are scored.
    const blocked = overlapArea(y, height, xRange, fixed) > 0 ? HARD_PENALTY : 0;
    const overlap = blocked + frames.reduce((total, boxes) => total + overlapArea(y, height, xRange, boxes), 0) / frames.length;
    const distance = Math.abs(y - preferred);
    if (overlap < best.overlap || (overlap === best.overlap && distance < best.distance)) best = { y, overlap, distance };
  }
  return { y: best.y, overlap: best.overlap };
}

/** Added for any position touching a fixed box, so those are used only when nothing else exists. */
const HARD_PENALTY = 1e12;

/** Space kept between captions and any title or card on screen with them. */
const CAPTION_GAP = 60;
/** Average share of a block allowed over a face before it is reported. */
const FACE_TOLERANCE = 0.12;
/** How far a card may move from its requested time to fit within one camera shot. */
const CARD_NUDGE_SEC = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2];

const lineCount = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));

function hookHeight(lines: string[], fontSize: number, perLine: number): number {
  return lines.reduce((total, line) => total + lineCount(line, perLine) * fontSize * 1.06, 0) + 10 * Math.max(0, lines.length - 1) + 16;
}

function cardHeight(title: string, body?: string, source?: string): number {
  return 54 + 32 + 6 + lineCount(title, 26) * 55 + (body ? 10 + lineCount(body, 42) * 40 : 0) + (source ? 12 + 27 : 0);
}

export interface OverlayInput {
  id: string;
  short: ResolvedShort;
  words: CaptionWord[];
  segments: RenderSegment[];
  durationSec: number;
  videoFile: string;
  brand: Brand;
  speakers: Record<string, Speaker>;
  overlay: ShortOverlay;
  /** Faces in the rendered short; typical zones per framing are used when absent. */
  faces?: FaceSample[];
  /** File name of the hook image inside the project's assets, when the overlay has one. */
  hookImageFile?: string;
  /** End-card images inside the project's assets: the final frame sharp and blurred, and the source thumbnail. */
  endCardFiles?: { freeze?: string; blur?: string; thumbnail?: string };
  /** Sound-effect files inside the project's assets; cues without a file play silent. */
  sfx?: Partial<Record<SfxKey, string>>;
  /** Per `overlay.scenes` entry: the composition id declared in the scene file and its file name under compositions/. */
  sceneFiles?: Array<{ compositionId: string; file: string } | undefined>;
}

export interface OverlayPlan {
  html: string;
  issues: string[];
  /** Length of the composition: the short plus the end card. */
  durationSec: number;
}

interface PlacedScene extends Timed {
  id: string;
  file: string;
  mode: 'bottom' | 'full';
  expandSec?: number;
  /** Starts on a cut to a split screen, appearing with it instead of sliding in. */
  onCut: boolean;
  enterSound: boolean;
  exitSound: boolean;
}

/** A bottom scene starting this soon after a cut to a split screen lets the other person flash up; it is reported. */
const SCENE_CUT_FLASH_SEC = 0.6;
/** A bottom scene starting this close to such a cut appears with the cut instead of sliding in. */
const SCENE_ON_CUT_SEC = 0.05;

/** Resolve scenes to times on the short, dropping (and reporting) any that do not fit. */
function placeScenes(input: OverlayInput, segments: TimelineSegment[], issues: string[]): PlacedScene[] {
  const placed: PlacedScene[] = [];
  (input.overlay.scenes ?? []).forEach((scene, index) => {
    const name = `scene ${index + 1}`;
    const file = input.sceneFiles?.[index];
    if (!file) return issues.push(`${name}: ${scene.src} has no data-composition-id on its root; skipped.`);
    if (scene.mode !== 'bottom' && scene.mode !== 'full') return issues.push(`${name}: mode must be "bottom" or "full"; skipped.`);
    const at = (phrase: string | undefined, fallback: number | undefined, what: string) => {
      const found = findPhraseSec(input.words, phrase);
      if (phrase && found === undefined) issues.push(`${name}: ${what} phrase "${phrase}" is not in this short's captions.`);
      return found ?? fallback;
    };
    const startSec = at(scene.atPhrase, scene.atSec, 'start');
    if (startSec === undefined) return issues.push(`${name} needs atPhrase or atSec; skipped.`);
    const splitCuts = scene.mode === 'bottom' ? segments.filter((segment) => segment.mode === 'stack' && segment.startSec > 0).map((segment) => segment.startSec) : [];
    const onCut = splitCuts.some((cutSec) => Math.abs(cutSec - startSec) <= SCENE_ON_CUT_SEC);
    const flash = splitCuts.find((cutSec) => startSec - cutSec > SCENE_ON_CUT_SEC && startSec - cutSec <= SCENE_CUT_FLASH_SEC);
    if (flash !== undefined) {
      issues.push(`${name} starts ${(startSec - flash).toFixed(2)} s after the cut to a split screen, so the other person flashes up for a moment. Let the split play about 2 s first (from atSec ${sec(flash + 2)}), or start at atSec ${sec(flash)} to appear with the cut. Scene times count from its start.`);
    }
    const endSec = at(scene.endPhrase, scene.durationSec === undefined ? undefined : startSec + scene.durationSec, 'end');
    if (endSec === undefined) return issues.push(`${name} needs endPhrase or durationSec; skipped.`);
    if (endSec - startSec < 0.8 || endSec > input.durationSec + 0.01) return issues.push(`${name} runs ${startSec.toFixed(2)}–${endSec.toFixed(2)}s, outside the short or under 0.8 s; skipped.`);
    let expandSec = scene.mode === 'bottom' ? at(scene.expandAtPhrase, scene.expandAtSec, 'expand') : undefined;
    if (expandSec !== undefined && (expandSec <= startSec + 0.3 || expandSec >= endSec - 0.3)) {
      issues.push(`${name}: expand at ${expandSec.toFixed(2)}s is not inside the scene; it stays in the bottom half.`);
      expandSec = undefined;
    }
    const clash = placed.find((other) => startSec < other.endSec && endSec > other.startSec);
    if (clash) return issues.push(`${name} overlaps ${clash.id}; skipped.`);
    placed.push({ id: file.compositionId, file: file.file, mode: scene.mode, startSec, endSec, expandSec, onCut, enterSound: scene.enterSound !== false, exitSound: scene.exitSound === true });
  });
  return placed.sort((left, right) => left.startSec - right.startSec);
}

/** What a scene covers at a moment: the bottom half, the whole frame, or nothing. */
function sceneCover(scenes: PlacedScene[], atSec: number): 'bottom' | 'full' | undefined {
  const scene = scenes.find((candidate) => atSec >= candidate.startSec && atSec < candidate.endSec);
  if (!scene) return undefined;
  return scene.mode === 'full' || (scene.expandSec !== undefined && atSec >= scene.expandSec) ? 'full' : 'bottom';
}

/** Build a HyperFrames root composition: footage plus channel-styled overlays. */
export function buildOverlay(input: OverlayInput): OverlayPlan {
  const { brand, overlay, durationSec } = input;
  const issues: string[] = [];
  const accent = brand.accent ?? '#E3262E';
  const label = brand.label ?? '#F5A623';
  const segments = timelineSegments(input.segments);
  const groups = captionGroups(input.words, segments, overlay.emphasis);
  const clampEnd = (start: number, length: number) => Math.min(start + length, durationSec - 0.1);
  const scenes = placeScenes(input, segments, issues);

  // Top-slot items run one at a time: hook, then name tag and cards in time order, then the end card.
  const hookText = input.short.spec.hook?.trim();
  const hook: Timed | undefined = hookText ? { startSec: 0.1, endSec: Math.min(HOOK_SEC, durationSec - 0.2) } : undefined;
  const slots: Array<Timed & { kind: 'name' | 'card'; html: string; id: string; height: number }> = [];

  if (overlay.nameTag) {
    const speaker = input.speakers[overlay.nameTag.speaker];
    if (!speaker) {
      issues.push(`nameTag speaker "${overlay.nameTag.speaker}" is not in speakers.`);
    } else {
      const startSec = findPhraseSec(input.words, overlay.nameTag.atPhrase) ?? overlay.nameTag.atSec ?? (hook ? hook.endSec + 0.2 : 0.5);
      slots.push({
        kind: 'name', id: 'name-tag', startSec,
        endSec: clampEnd(startSec, overlay.nameTag.durationSec ?? NAME_TAG_SEC),
        height: cardHeight(speaker.name, speaker.role),
        html: `<div class="card-label">${escapeHtml(speaker.label ?? 'Guest')}</div>` +
          `<div class="card-title">${escapeHtml(speaker.name)}</div>` +
          (speaker.role ? `<div class="card-body">${escapeHtml(speaker.role)}</div>` : ''),
      });
    }
  }
  (overlay.cards ?? []).forEach((card, index) => {
    const found = findPhraseSec(input.words, card.atPhrase);
    if (card.atPhrase && found === undefined) issues.push(`card ${index + 1}: phrase "${card.atPhrase}" is not in this short's captions.`);
    const startSec = found ?? card.atSec;
    if (startSec === undefined) {
      issues.push(`card ${index + 1} needs atPhrase or atSec.`);
      return;
    }
    slots.push({
      kind: 'card', id: `card-${index + 1}`, startSec,
      endSec: clampEnd(startSec, card.durationSec ?? CARD_SEC),
      height: cardHeight(card.title, card.body, card.source),
      html: `<div class="card-label">${escapeHtml(card.label)}</div>` +
        `<div class="card-title">${escapeHtml(card.title)}</div>` +
        (card.body ? `<div class="card-body">${escapeHtml(card.body)}</div>` : '') +
        (card.source ? `<div class="card-source">Source: ${escapeHtml(card.source)}</div>` : ''),
    });
  });
  // Nudge each card or name tag (up to 2 s) toward a moment where it fits clear of faces,
  // usually by keeping it inside one camera shot.
  const faceSamples = input.faces ?? typicalFaces(segments);
  const fixedBoxes: Box[] = brand.wordmark?.length ? [WORDMARK_BOX] : [];
  // Headings always sit at the top, a clear gap below the wordmark.
  const headingTop = brand.wordmark?.length ? WORDMARK_BOX.y + WORDMARK_BOX.h + HEADING_GAP : TOP_SLOT_Y;
  const atTop = (height: number): Array<[number, number]> => [[headingTop, headingTop + height]];
  for (const slot of slots) {
    const length = slot.endSec - slot.startSec;
    let best = { shift: 0, overlap: Number.POSITIVE_INFINITY };
    for (const shift of CARD_NUDGE_SEC) {
      const startSec = slot.startSec + shift;
      if (startSec < 0 || startSec + length > durationSec - 0.1) continue;
      const { overlap } = placeY(slot.height, headingTop, CARD_X, samplesDuring(faceSamples, startSec, startSec + length), [], atTop(slot.height));
      if (overlap < best.overlap - 1) best = { shift, overlap };
    }
    slot.startSec += best.shift;
    slot.endSec += best.shift;
  }
  slots.sort((left, right) => left.startSec - right.startSec);
  let freeAt = hook ? hook.endSec + 0.15 : 0;
  for (const slot of slots) {
    if (slot.startSec < freeAt) {
      const length = slot.endSec - slot.startSec;
      slot.startSec = freeAt;
      slot.endSec = clampEnd(freeAt, length);
    }
    if (slot.endSec - slot.startSec < 1.5) {
      issues.push(`${slot.id} has no room before the short ends and was dropped.`);
      slot.endSec = slot.startSec;
      continue;
    }
    freeAt = slot.endSec + 0.15;
  }
  const visibleSlots = slots.filter((slot) => slot.endSec > slot.startSec);
  const endCard = brand.endCard ? { startSec: durationSec, endSec: durationSec + END_CARD_SEC } : undefined;
  const totalSec = endCard ? endCard.endSec : durationSec;

  const hookLines = (hookText ?? '').split('|').map((line) => line.trim()).filter(Boolean);

  // Headings are fixed at the top; report any that cover a face there.
  const faces = faceSamples;
  const placed: Array<Timed & { y: number; height: number; xRange: [number, number] }> = [];
  const area = (height: number, [x0, x1]: [number, number]) => height * (x1 - x0);
  const place = (id: string, timed: Timed, height: number, xRange: [number, number]) => {
    // At the top a heading may cover the forehead; count only the face from the brows down.
    const eyesDown = samplesDuring(faces, timed.startSec, timed.endSec)
      .map((boxes) => boxes.map((box) => ({ ...box, y: box.y + box.h * BROW_LINE, h: box.h * (1 - BROW_LINE) })));
    const spot = placeY(height, headingTop, xRange, eyesDown, [], atTop(height));
    if (spot.overlap > area(height, xRange) * FACE_TOLERANCE) {
      const share = Math.round((spot.overlap / area(height, xRange)) * 100);
      const split = segments.reduce((total, segment) => total + (segment.mode === 'stack'
        ? Math.max(0, Math.min(timed.endSec, segment.endSec) - Math.max(timed.startSec, segment.startSec)) : 0), 0);
      const advice = split > (timed.endSec - timed.startSec) / 2
        ? 'It shows over a split screen, where the top person\'s face fills the top: frame that shot as a crop on the speaker instead.'
        : 'Shorten its text, or time it to a moment when the head sits lower.';
      issues.push(`${id} covers a face at the top: ${share}% of it on average over its time on screen. ${advice}`);
    }
    placed.push({ ...timed, y: headingTop, height, xRange });
    return headingTop;
  };
  // With a photo, the hook text shrinks to sit beside a round headshot.
  const withImage = Boolean(hook && input.hookImageFile);
  const hookFont = withImage ? 60 : 74;
  const hookBlockHeight = withImage ? Math.max(HOOK_IMAGE_SIZE, hookHeight(hookLines, hookFont, 16)) : hookHeight(hookLines, hookFont, 18);
  const hookY = hook ? place('hook', hook, hookBlockHeight, FULL_WIDTH) : 0;
  const slotY = new Map(visibleSlots.map((slot) => [slot.id, place(slot.id, slot, slot.height, CARD_X)]));
  for (const block of placed) {
    const under = scenes.find((scene) => block.startSec < scene.endSec && block.endSec > scene.startSec && scene.mode === 'full');
    if (under) issues.push(`A heading at ${block.startSec.toFixed(1)}s shows over full-screen ${under.id}; move one of them.`);
  }
  // One caption position per stretch of unchanging screen: a camera shot, split wherever a title
  // or card appears or leaves, so captions move only when something else on screen does.
  const cutPoints = [...new Set([
    ...segments.flatMap((segment) => [segment.startSec, segment.endSec]),
    ...placed.flatMap((block) => [block.startSec, block.endSec]),
    ...scenes.flatMap((scene) => [scene.startSec, scene.endSec, ...(scene.expandSec === undefined ? [] : [scene.expandSec])]),
  ])].filter((at) => at >= 0 && at <= durationSec).sort((a, b) => a - b);
  const windows = cutPoints.slice(0, -1).map((startSec, index) => ({ startSec, endSec: cutPoints[index + 1]! }))
    .filter((window) => window.endSec - window.startSec > 0.05);
  // Captions: on the seam of split screens; otherwise low in the frame, as clear of the face as the
  // bottom band allows. Never at the top.
  const captionY = windows.map((window) => {
    const mode = segments.find((segment) => window.startSec + 0.01 >= segment.startSec && window.startSec + 0.01 < segment.endSec)?.mode ?? 'crop';
    // Under a bottom-half scene the speaker fills the top half, as on a split screen.
    const cover = sceneCover(scenes, window.startSec + 0.01);
    if (cover === 'bottom') return SEAM_CAPTION_TOP;
    if (cover === 'full') return CAPTION_LOW;
    if (mode === 'stack') return SEAM_CAPTION_TOP;
    const blocks: Box[] = placed
      .filter((block) => block.startSec < window.endSec && block.endSec > window.startSec)
      // Keep a clear gap so captions never read as part of a heading or card.
      .map((block) => ({ x: 0, y: block.y - CAPTION_GAP, w: 1080, h: block.height + CAPTION_GAP * 2 }));
    const spot = placeY(CAPTION_HEIGHT, CAPTION_LOW, FULL_WIDTH, samplesDuring(faces, window.startSec, window.endSec), [...blocks, ...fixedBoxes], [CAPTION_BAND]);
    if (spot.overlap >= HARD_PENALTY) issues.push(`captions from ${window.startSec.toFixed(1)}s have no room clear of a card; shorten it.`);
    else if (spot.overlap > area(CAPTION_HEIGHT, FULL_WIDTH) * FACE_TOLERANCE) {
      const share = Math.round((spot.overlap / area(CAPTION_HEIGHT, FULL_WIDTH)) * 100);
      issues.push(`captions from ${window.startSec.toFixed(1)}s cover a face (chin or mouth): ${share}% of the caption band on average over that stretch.`);
    }
    return spot.y;
  });
  const captionTopAt = (atSec: number) => {
    const index = windows.findIndex((window) => atSec >= window.startSec && atSec < window.endSec);
    return captionY[index === -1 ? captionY.length - 1 : index] ?? CAPTION_LOW;
  };
  const hookHtml = hookLines.map((line, index) => {
    const highlighted = hookLines.length > 1 ? index === hookLines.length - 1 : false;
    return `<div class="hook-line${highlighted ? ' hook-hi' : ''}"><span>${escapeHtml(line)}</span></div>`;
  }).join('');

  const wordmark = brand.wordmark?.length
    ? `<div id="wordmark" class="clip" data-start="0" data-duration="${sec(totalSec)}" data-track-index="2">` +
      `<div class="wm-mark">${brand.wordmark.map((line, index) => `<div class="wm-${index === 0 && brand.wordmark!.length > 2 ? 'small' : 'big'}">${escapeHtml(line)}</div>`).join('')}</div>` +
      (brand.wordmarkTag ? `<div class="wm-rule"></div><div class="wm-tag">${escapeHtml(brand.wordmarkTag)}</div>` : '') +
      '</div>'
    : '';

  const captionHtml = groups.map((group, index) => {
    const text = group.words.map((word) => word.text).join(' ');
    const words = group.words.map((word) => `<span class="${word.emphasis ? 'w em' : 'w'}">${escapeHtml(word.text)}</span>`).join(' ');
    // Captions end with the speech, never over the end card.
    return `<div id="cap-${index}" class="clip cap" data-start="${sec(group.startSec)}" data-duration="${sec(Math.min(group.endSec, durationSec) - group.startSec)}" data-track-index="4" ` +
      `style="top:${captionTopAt(group.startSec + 0.05)}px;font-size:${captionSize(text)}px"><div class="cap-inner">${words}</div></div>`;
  }).join('\n      ');

  const slotHtml = visibleSlots.map((slot) =>
    `<div id="${slot.id}" class="clip slot" data-start="${sec(slot.startSec)}" data-duration="${sec(slot.endSec - slot.startSec)}" data-track-index="3" style="top:${slotY.get(slot.id)}px"><div class="card">${slot.html}</div></div>`,
  ).join('\n      ');

  const tweens: string[] = [];
  if (hook) {
    tweens.push(
      `tl.from("#hook .hook-line", { y: 40, opacity: 0, duration: 0.35, ease: "power3.out", stagger: 0.12 }, ${sec(hook.startSec)});`,
      ...(withImage ? [`tl.from("#hook .hook-img", { scale: 0.6, opacity: 0, duration: 0.35, ease: "back.out(1.7)" }, ${sec(hook.startSec)});`] : []),
      `tl.to(${withImage ? '"#hook .hook-row"' : '"#hook .hook-inner"'}, { opacity: 0, y: -20, duration: 0.25, ease: "power2.in" }, ${sec(hook.endSec - 0.25)});`,
    );
  }
  for (const slot of visibleSlots) {
    tweens.push(
      `tl.from("#${slot.id} .card", { x: -60, opacity: 0, duration: 0.4, ease: "power2.out" }, ${sec(slot.startSec)});`,
      `tl.to("#${slot.id} .card", { x: -30, opacity: 0, duration: 0.35, ease: "power2.in" }, ${sec(slot.endSec - 0.35)});`,
    );
  }
  groups.forEach((group, index) => {
    tweens.push(`tl.from("#cap-${index} .cap-inner", { y: 16, scale: 0.94, opacity: 0, duration: 0.12, ease: "power2.out" }, ${sec(group.startSec)});`);
  });
  // Sound effects: each placed so its measured peak lands one frame after its picture.
  const audio: string[] = [];
  const hit = (key: SfxKey, pictureSec: number, volume: number, options: { mediaStart?: number; duration?: number; fadeIn?: number; fadeOut?: number } = {}) => {
    const file = input.sfx?.[key];
    if (!file) return;
    const startSec = Math.max(0, pictureSec + FRAME_SEC - (SFX_PEAK[key] - (options.mediaStart ?? 0)));
    audio.push(`<audio id="sfx-${audio.length}" class="clip" src="assets/${escapeHtml(file)}" data-start="${sec(startSec)}" data-duration="${sec(options.duration ?? 0.6)}" data-volume="${volume}"` +
      (options.mediaStart ? ` data-media-start="${sec(options.mediaStart)}"` : '') +
      (options.fadeIn ? ` data-fade-in="${options.fadeIn}"` : '') + (options.fadeOut ? ` data-fade-out="${options.fadeOut}"` : '') +
      ` data-track-index="${6 + audio.length}"></audio>`);
  };

  // Zooms move a camera wrapper around the footage, centred on the speaker's face.
  const zoomOrigin = (atSec: number) => {
    const sample = faceSamples.reduce<FaceSample | undefined>((best, candidate) =>
      !best || Math.abs(candidate.atSec - atSec) < Math.abs(best.atSec - atSec) ? candidate : best, undefined);
    const box = sample?.boxes.slice().sort((a, b) => a.y - b.y)[0];
    if (!box) return '50% 45%';
    const x = Math.min(Math.max(((box.x + box.w / 2) / 1080) * 100, 25), 75);
    const y = Math.min(Math.max(((box.y + box.h * 0.42) / 1920) * 100, 20), 60);
    return `${x.toFixed(1)}% ${y.toFixed(1)}%`;
  };
  let zoomFreeAt = 0;
  let lastZoomSec: number | undefined;
  (overlay.zooms ?? []).map((zoom, index) => ({ zoom, index, startSec: findPhraseSec(input.words, zoom.atPhrase) ?? zoom.atSec }))
    .sort((left, right) => (left.startSec ?? 0) - (right.startSec ?? 0))
    .forEach(({ zoom, index, startSec }) => {
      const name = `zoom ${index + 1}`;
      if (zoom.atPhrase && findPhraseSec(input.words, zoom.atPhrase) === undefined) issues.push(`${name}: phrase "${zoom.atPhrase}" is not in this short's captions.`);
      if (startSec === undefined) return issues.push(`${name} needs atPhrase or atSec; skipped.`);
      if (modeAt(segments, startSec + 0.05) === 'stack') return issues.push(`${name} at ${startSec.toFixed(2)}s lands on a split screen, where a zoom crops both people; skipped.`);
      if (sceneCover(scenes, startSec + 0.05)) return issues.push(`${name} at ${startSec.toFixed(2)}s is hidden by a scene; skipped.`);
      if (startSec < zoomFreeAt) return issues.push(`${name} at ${startSec.toFixed(2)}s starts before the previous zoom has eased back; skipped.`);
      if (startSec > durationSec - 1) return issues.push(`${name} at ${startSec.toFixed(2)}s has no room to ease back before the short ends; skipped.`);
      if (lastZoomSec !== undefined && startSec - lastZoomSec < ZOOM_MIN_GAP_SEC) {
        issues.push(`${name} comes ${(startSec - lastZoomSec).toFixed(1)} s after the previous one; zooms this close read as busy; keep to about one every 10 s.`);
      }
      const kind = ZOOMS[zoom.kind ?? 'snap'];
      const peakSec = startSec + kind.inSec;
      let releaseSec = Math.min(peakSec + (zoom.holdSec ?? kind.holdSec), durationSec - ZOOM_RELEASE_SEC);
      tweens.push(`tl.set("#cam", { transformOrigin: "${zoomOrigin(startSec + 0.3)}" }, ${sec(startSec)});`);
      tweens.push(`tl.to("#cam", { scale: ${zoom.scale ?? kind.scale}, duration: ${kind.inSec}, ease: "${kind.ease}" }, ${sec(startSec)});`);
      // When a full-frame scene covers the end of the hold, reset under it instead of easing back on screen.
      const covering = scenes.find((scene) => scene.startSec >= peakSec - 0.05 && scene.startSec < releaseSec + ZOOM_RELEASE_SEC && scene.mode === 'full');
      if (covering) {
        releaseSec = covering.startSec + 0.4;
        tweens.push(`tl.set("#cam", { scale: 1 }, ${sec(releaseSec)});`);
      } else {
        tweens.push(`tl.to("#cam", { scale: 1, duration: ${ZOOM_RELEASE_SEC}, ease: "power2.inOut" }, ${sec(releaseSec)});`);
      }
      if (kind.sfx && (zoom.sound ?? zoom.kind === 'punch')) hit(kind.sfx, startSec + 0.04, 0.3, { duration: kind.sfx === 'impact-bass-1' ? 1.2 : 0.6 });
      zoomFreeAt = releaseSec + ZOOM_RELEASE_SEC;
      lastZoomSec = startSec;
    });

  // Scenes slide up into the bottom half or open over the whole frame, then hand back to the speaker.
  const sceneHtml = scenes.map((scene) => {
    const initial = scene.mode === 'bottom' ? 'inset(100% 0% 0% 0%)' : 'circle(0% at 50% 40%)';
    return `<div id="${escapeHtml(scene.id)}" class="scene" data-composition-id="${escapeHtml(scene.id)}" data-composition-src="compositions/${escapeHtml(scene.file)}" ` +
      `data-start="${sec(scene.startSec)}" data-duration="${sec(scene.endSec - scene.startSec)}" data-track-index="5" data-track-kind="graphics" data-width="1080" data-height="1920" style="clip-path:${initial}"></div>`;
  }).join('\n      ');
  for (const scene of scenes) {
    const host = JSON.stringify(`#${scene.id}`);
    if (scene.mode === 'bottom') {
      tweens.push(scene.onCut
        ? `tl.set(${host}, { clipPath: "inset(50% 0% 0% 0%)" }, ${sec(scene.startSec)});`
        : `tl.to(${host}, { clipPath: "inset(50% 0% 0% 0%)", duration: 0.3, ease: "power3.out" }, ${sec(scene.startSec)});`);
      if (scene.expandSec !== undefined) {
        tweens.push(`tl.to(${host}, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.32, ease: "power2.inOut" }, ${sec(scene.expandSec)});`);
        tweens.push(`tl.to(${host}, { clipPath: "inset(0% 0% 100% 0%)", duration: 0.28, ease: "power2.in" }, ${sec(scene.endSec - 0.3)});`);
      } else {
        tweens.push(`tl.to(${host}, { clipPath: "inset(100% 0% 0% 0%)", duration: 0.28, ease: "power2.in" }, ${sec(scene.endSec - 0.3)});`);
      }
    } else {
      tweens.push(`tl.to(${host}, { clipPath: "circle(125% at 50% 40%)", duration: 0.35, ease: "power2.out" }, ${sec(scene.startSec)});`);
      tweens.push(`tl.to(${host}, { clipPath: "circle(0% at 50% 55%)", duration: 0.22, ease: "power2.in" }, ${sec(scene.endSec - 0.24)});`);
    }
    if (scene.enterSound) hit('whoosh', scene.startSec + (scene.onCut ? 0 : 0.1), 0.3);
    if (scene.exitSound) hit(scene.mode === 'full' ? 'whoosh-short' : 'whoosh', scene.endSec - 0.12, 0.28);
  }

  // End card: the final frame freezes and blurs, the source thumbnail lands, a tap on its play
  // button, then a pointer to the related-video link.
  let endHtml = '';
  if (endCard) {
    const card = brand.endCard!;
    const heading = card.heading?.length ? card.heading : ['Watch the', 'Full episode'];
    const cta = card.cta ?? 'Tap the link below';
    const files = input.endCardFiles ?? {};
    const thumb = files.thumbnail;
    const at = (offset: number) => sec(endCard.startSec + offset);
    const brandTop = thumb ? 1062 : 640;
    const ctaTop = card.channel ? brandTop + 98 : brandTop;
    endHtml = [
      `<div id="ec" class="clip" data-start="${sec(endCard.startSec)}" data-duration="${sec(END_CARD_SEC)}" data-track-index="3" data-track-kind="graphics">`,
      `<div class="ec-head">${heading.map((line, index) => `<div id="ec-l${index}" class="${index === heading.length - 1 ? 'ec-hi' : 'ec-line'}"><span>${escapeHtml(line)}</span></div>`).join('')}</div>`,
      thumb ? `<div id="ec-thumb"><img src="assets/${escapeHtml(thumb)}" alt="Full episode thumbnail" /></div><div id="ec-ripple"></div>` +
        `<div id="ec-play"><svg width="44" height="48" viewBox="0 0 50 54"><path d="M0 0 L50 27 L0 54 Z" fill="#fff"/></svg></div><div id="ec-touch"></div>` : '',
      card.channel ? `<div id="ec-brand" style="top:${brandTop}px">${escapeHtml(card.channel)}</div>` : '',
      cta ? `<div id="ec-chip" style="top:${ctaTop}px"><span>${escapeHtml(cta)}</span><svg id="ec-arrow" width="34" height="40" viewBox="0 0 34 40"><path d="M17 0 V32 M3 20 L17 36 L31 20" stroke="${escapeHtml(accent)}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` : '',
      '</div>',
    ].join('');
    if (files.blur) tweens.push(`tl.from("#end-blur .eb-inner", { opacity: 0, duration: 0.3, ease: "power1.out" }, ${at(0)});`);
    heading.forEach((_, index) => tweens.push(`tl.from("#ec-l${index}", { y: 40, opacity: 0, duration: 0.35, ease: "power3.out" }, ${at(0.08 + index * 0.1)});`));
    if (thumb) {
      tweens.push(
        `tl.from("#ec-thumb", { y: 170, scale: 0.8, duration: 0.36, ease: "back.out(1.5)" }, ${at(0)});`,
        `tl.from("#ec-thumb", { opacity: 0, duration: 0.14, ease: "none" }, ${at(0)});`,
        `tl.from("#ec-play", { scale: 0, duration: 0.3, ease: "back.out(2)" }, ${at(0.42)});`,
        `tl.set("#ec-ripple", { opacity: 0 }, ${at(0)});`,
        `tl.fromTo("#ec-touch", { opacity: 0, scale: 1.4, x: 200, y: 180 }, { opacity: 1, scale: 1, x: 0, y: 0, duration: 0.3, ease: "power2.out", immediateRender: false }, ${at(0.5)});`,
        `tl.to("#ec-touch", { scale: 0.72, duration: 0.08, ease: "power2.in" }, ${at(0.8)});`,
        `tl.to("#ec-play", { scale: 0.86, duration: 0.08, ease: "power2.in" }, ${at(0.8)});`,
        `tl.to("#ec-play", { scale: 1, duration: 0.35, ease: "back.out(3)" }, ${at(0.88)});`,
        `tl.to("#ec-touch", { scale: 1.1, opacity: 0, duration: 0.3, ease: "power2.out" }, ${at(0.88)});`,
        `tl.fromTo("#ec-ripple", { scale: 0.7, opacity: 0.85 }, { scale: 2.1, opacity: 0, duration: 0.6, ease: "power2.out", immediateRender: false }, ${at(0.86)});`,
      );
      hit('riser', endCard.startSec + 0.36, 0.28, { mediaStart: 2.272, duration: 1.6, fadeIn: 0.5, fadeOut: 0.35 });
      hit('impact-bass-1', endCard.startSec + 0.36, 0.32, { duration: 1.6, fadeOut: 0.6 });
      hit('click-soft', endCard.startSec + 0.88, 0.9, { duration: 0.36 });
    }
    if (card.channel) tweens.push(`tl.from("#ec-brand", { y: 24, opacity: 0, duration: 0.3, ease: "power2.out" }, ${at(0.45)});`);
    if (cta) {
      tweens.push(
        `tl.from("#ec-chip", { scale: 0.6, opacity: 0, duration: 0.28, ease: "back.out(2)" }, ${at(1)});`,
        `tl.to("#ec-arrow", { y: 9, duration: 0.16, ease: "sine.inOut", yoyo: true, repeat: 5 }, ${at(1.4)});`,
      );
      hit('pop', endCard.startSec + 1.28, 0.8);
    }
  }
  const freezeHtml = endCard && input.endCardFiles?.freeze
    ? `<img id="end-freeze" class="clip" src="assets/${escapeHtml(input.endCardFiles.freeze)}" alt="" data-start="${sec(durationSec)}" data-duration="${sec(END_CARD_SEC)}" data-track-index="0">` +
      (input.endCardFiles.blur ? `<div id="end-blur" class="clip" data-start="${sec(durationSec)}" data-duration="${sec(END_CARD_SEC)}" data-track-index="1"><div class="eb-inner"><img src="assets/${escapeHtml(input.endCardFiles.blur)}" alt=""><div class="eb-dim"></div></div></div>` : '')
    : '';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; }
      #root { --accent: ${accent}; --label: ${label}; font-family: "Poppins", sans-serif; }
      #cam { position: absolute; inset: 0; overflow: hidden; }
      #a-roll, #end-freeze, #end-blur img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #end-blur .eb-inner { position: absolute; inset: 0; }
      #end-blur .eb-dim { position: absolute; inset: 0; background: rgba(8,8,12,.38); }
      .scene { position: absolute; inset: 0; }
      #scrim { position: absolute; left: 0; right: 0; top: 0; height: 640px;
        background: linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,0)); }
      #wordmark { position: absolute; top: 184px; right: 56px; display: flex; align-items: center; gap: 14px; color: #fff; }
      .wm-mark { font-family: "Oswald", sans-serif; font-weight: 700; line-height: .92; text-transform: uppercase; }
      .wm-small { font-family: "Poppins", sans-serif; font-size: 18px; font-weight: 600; text-transform: none; line-height: 1; }
      .wm-big { font-size: 30px; letter-spacing: .5px; }
      .wm-rule { width: 4px; height: 52px; background: var(--accent); }
      .wm-tag { font-family: "Oswald", sans-serif; font-weight: 700; font-size: 30px; }
      #hook { position: absolute; left: 0; right: 0; }
      .hook-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 60px; }
      .hook-row { display: flex; align-items: center; gap: 28px; padding: 0 56px; }
      .hook-img { width: ${HOOK_IMAGE_SIZE}px; height: ${HOOK_IMAGE_SIZE}px; flex: none; border-radius: 50%; object-fit: cover; object-position: 50% 20%;
        border: 6px solid var(--accent); box-shadow: 0 8px 28px rgba(0,0,0,.5); }
      .hook-side { align-items: flex-start; padding: 0; }
      .hook-side .hook-line { font-size: 60px; text-align: left; }
      .hook-line { font-family: "Montserrat", sans-serif; font-weight: 900; font-size: 74px; line-height: 1.04;
        color: #fff; text-transform: uppercase; text-align: center; text-shadow: 0 4px 18px rgba(0,0,0,.55); }
      .hook-hi span { background: var(--accent); padding: 4px 22px 8px; text-shadow: none; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      #ec { position: absolute; inset: 0; }
      .ec-head { position: absolute; top: 318px; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
      .ec-line, .ec-hi, #ec-brand { font-family: "Montserrat", sans-serif; font-weight: 900; text-transform: uppercase; color: #fff;
        text-align: center; line-height: 1.04; text-shadow: 0 4px 18px rgba(0,0,0,.55); }
      .ec-line { font-size: 58px; letter-spacing: 1px; }
      .ec-hi { font-size: 84px; }
      .ec-hi span { background: var(--accent); padding: 4px 26px 10px; text-shadow: none; }
      #ec-thumb { position: absolute; left: 120px; top: 548px; width: 840px; height: 472px; border-radius: 30px; overflow: hidden;
        box-shadow: 0 0 0 5px rgba(255,255,255,.92), 0 34px 90px rgba(0,0,0,.65); background: #000; }
      #ec-thumb img { width: 100%; height: 100%; display: block; object-fit: cover; }
      #ec-play, #ec-ripple { position: absolute; left: 275px; top: 890px; width: 150px; height: 106px; }
      #ec-play { border-radius: 30px; background: #FF0033; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
      #ec-play svg { position: absolute; left: 57px; top: 29px; }
      #ec-ripple { border-radius: 36px; border: 6px solid #fff; }
      #ec-touch { position: absolute; left: 332px; top: 927px; width: 96px; height: 96px; border-radius: 50%;
        background: rgba(255,255,255,.55); border: 4px solid rgba(255,255,255,.9); box-shadow: 0 6px 22px rgba(0,0,0,.35); }
      #ec-brand { position: absolute; left: 0; right: 0; font-size: 46px; }
      #ec-chip { position: absolute; left: 240px; width: 600px; height: 96px; border-radius: 48px;
        background: rgba(15,16,22,.88); border: 4px solid var(--accent); display: flex; align-items: center; justify-content: center; gap: 18px;
        font-family: "Poppins", sans-serif; font-weight: 700; font-size: 40px; color: #fff; }
      #ec-arrow { display: block; }
      .slot { position: absolute; left: 48px; width: 760px; }
      .card { background: rgba(15,16,22,.80); border-radius: 18px; padding: 26px 32px 28px; border-left: 8px solid var(--label); }
      .card-label { font-family: "Oswald", sans-serif; font-weight: 600; font-size: 26px; letter-spacing: 1.5px; color: var(--label); text-transform: uppercase; }
      .card-title { font-family: "Oswald", sans-serif; font-weight: 700; font-size: 50px; line-height: 1.1; color: #fff; margin-top: 6px; }
      .card-body { font-family: "Inter", sans-serif; font-weight: 500; font-size: 30px; line-height: 1.32; color: #e6e6e6; margin-top: 10px; }
      .card-source { font-family: "Inter", sans-serif; font-size: 22px; color: #9a9a9a; margin-top: 12px; }
      .cap { position: absolute; left: 0; right: 0; text-align: center; overflow: visible; }
      .cap-inner { display: inline-block; padding: 0 70px; font-weight: 800; line-height: 1.12; color: #fff;
        -webkit-text-stroke: 12px #000; paint-order: stroke fill; text-shadow: 0 6px 22px rgba(0,0,0,.45); }
      .cap .em { color: var(--accent); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${sec(totalSec)}" data-width="1080" data-height="1920">
      <div id="cam"><video id="a-roll" class="clip" src="assets/${escapeHtml(input.videoFile)}" playsinline data-start="0" data-duration="${sec(durationSec)}" data-track-index="0" data-has-audio="true"></video>${freezeHtml}</div>
      ${sceneHtml}
      <div id="scrim" class="clip" data-start="0" data-duration="${sec(totalSec)}" data-track-index="1"></div>
      ${wordmark}
      ${hook ? `<div id="hook" class="clip" data-start="${sec(hook.startSec)}" data-duration="${sec(hook.endSec - hook.startSec)}" data-track-index="3" style="top:${hookY}px">${withImage
        ? `<div class="hook-row"><img class="hook-img" src="assets/${escapeHtml(input.hookImageFile!)}" alt="${escapeHtml(overlay.hookImage?.alt ?? '')}" /><div class="hook-inner hook-side">${hookHtml}</div></div>`
        : `<div class="hook-inner">${hookHtml}</div>`}</div>` : ''}
      ${slotHtml}
      ${endHtml}
      ${captionHtml}
      ${audio.join('\n      ')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tweens.join('\n      ')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, issues, durationSec: sec(totalSec) };
}
