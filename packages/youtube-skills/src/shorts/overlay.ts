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
  /** End card lines; the first sits on the accent bar. */
  endCard?: string[];
}

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
const END_CARD_SEC = 2.4;
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
}

export interface OverlayPlan {
  html: string;
  issues: string[];
}

/** Build a HyperFrames root composition: footage plus channel-styled overlays. */
export function buildOverlay(input: OverlayInput): OverlayPlan {
  const { brand, overlay, durationSec } = input;
  const issues: string[] = [];
  const accent = brand.accent ?? '#E3262E';
  const label = brand.label ?? '#F5A623';
  const segments = timelineSegments(input.segments);
  const groups = captionGroups(input.words, segments, overlay.emphasis);
  const clampEnd = (start: number, length: number) => Math.min(start + length, durationSec - END_CARD_SEC - 0.1);

  // Top-slot items run one at a time: hook, then name tag and cards in time order, then the end card.
  const hookText = input.short.spec.hook?.trim();
  const hook: Timed | undefined = hookText ? { startSec: 0.1, endSec: Math.min(HOOK_SEC, durationSec - END_CARD_SEC - 0.2) } : undefined;
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
      if (startSec < 0 || startSec + length > durationSec - END_CARD_SEC - 0.1) continue;
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
      issues.push(`${slot.id} has no room before the end card and was dropped.`);
      slot.endSec = slot.startSec;
      continue;
    }
    freeAt = slot.endSec + 0.15;
  }
  const visibleSlots = slots.filter((slot) => slot.endSec > slot.startSec);
  const endCard = brand.endCard?.length ? { startSec: durationSec - END_CARD_SEC, endSec: durationSec } : undefined;

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
  const endY = endCard ? place('end card', endCard, hookHeight(brand.endCard!, 58, 22), FULL_WIDTH) : 0;
  // One caption position per stretch of unchanging screen: a camera shot, split wherever a title
  // or card appears or leaves, so captions move only when something else on screen does.
  const cutPoints = [...new Set([
    ...segments.flatMap((segment) => [segment.startSec, segment.endSec]),
    ...placed.flatMap((block) => [block.startSec, block.endSec]),
  ])].filter((at) => at >= 0 && at <= durationSec).sort((a, b) => a - b);
  const windows = cutPoints.slice(0, -1).map((startSec, index) => ({ startSec, endSec: cutPoints[index + 1]! }))
    .filter((window) => window.endSec - window.startSec > 0.05);
  // Captions: on the seam of split screens; otherwise low in the frame, as clear of the face as the
  // bottom band allows. Never at the top.
  const captionY = windows.map((window) => {
    const mode = segments.find((segment) => window.startSec + 0.01 >= segment.startSec && window.startSec + 0.01 < segment.endSec)?.mode ?? 'crop';
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
    ? `<div id="wordmark" class="clip" data-start="0" data-duration="${sec(durationSec)}" data-track-index="2">` +
      `<div class="wm-mark">${brand.wordmark.map((line, index) => `<div class="wm-${index === 0 && brand.wordmark!.length > 2 ? 'small' : 'big'}">${escapeHtml(line)}</div>`).join('')}</div>` +
      (brand.wordmarkTag ? `<div class="wm-rule"></div><div class="wm-tag">${escapeHtml(brand.wordmarkTag)}</div>` : '') +
      '</div>'
    : '';

  const captionHtml = groups.map((group, index) => {
    const text = group.words.map((word) => word.text).join(' ');
    const words = group.words.map((word) => `<span class="${word.emphasis ? 'w em' : 'w'}">${escapeHtml(word.text)}</span>`).join(' ');
    return `<div id="cap-${index}" class="clip cap" data-start="${sec(group.startSec)}" data-duration="${sec(group.endSec - group.startSec)}" data-track-index="4" ` +
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
  if (endCard) {
    tweens.push(
      `tl.from("#end-card .end-line", { y: 40, opacity: 0, duration: 0.35, ease: "power3.out", stagger: 0.12 }, ${sec(endCard.startSec)});`,
    );
  }

  const endHtml = endCard
    ? `<div id="end-card" class="clip" data-start="${sec(endCard.startSec)}" data-duration="${sec(END_CARD_SEC)}" data-track-index="3" style="top:${endY}px"><div class="end-inner">` +
      brand.endCard!.map((line, index) => `<div class="end-line${index === 0 ? ' hook-hi' : ''}"><span>${escapeHtml(line)}</span></div>`).join('') +
      '</div></div>'
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
      #a-roll { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #scrim { position: absolute; left: 0; right: 0; top: 0; height: 640px;
        background: linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,0)); }
      #wordmark { position: absolute; top: 184px; right: 56px; display: flex; align-items: center; gap: 14px; color: #fff; }
      .wm-mark { font-family: "Oswald", sans-serif; font-weight: 700; line-height: .92; text-transform: uppercase; }
      .wm-small { font-family: "Poppins", sans-serif; font-size: 18px; font-weight: 600; text-transform: none; line-height: 1; }
      .wm-big { font-size: 30px; letter-spacing: .5px; }
      .wm-rule { width: 4px; height: 52px; background: var(--accent); }
      .wm-tag { font-family: "Oswald", sans-serif; font-weight: 700; font-size: 30px; }
      #hook { position: absolute; left: 0; right: 0; }
      .hook-inner, .end-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 60px; }
      .hook-row { display: flex; align-items: center; gap: 28px; padding: 0 56px; }
      .hook-img { width: ${HOOK_IMAGE_SIZE}px; height: ${HOOK_IMAGE_SIZE}px; flex: none; border-radius: 50%; object-fit: cover; object-position: 50% 20%;
        border: 6px solid var(--accent); box-shadow: 0 8px 28px rgba(0,0,0,.5); }
      .hook-side { align-items: flex-start; padding: 0; }
      .hook-side .hook-line { font-size: 60px; text-align: left; }
      .hook-line, .end-line { font-family: "Montserrat", sans-serif; font-weight: 900; font-size: 74px; line-height: 1.04;
        color: #fff; text-transform: uppercase; text-align: center; text-shadow: 0 4px 18px rgba(0,0,0,.55); }
      .hook-hi span { background: var(--accent); padding: 4px 22px 8px; text-shadow: none; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      #end-card { position: absolute; left: 0; right: 0; }
      .end-line { font-size: 58px; }
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
    <div id="root" data-composition-id="main" data-start="0" data-duration="${sec(durationSec)}" data-width="1080" data-height="1920">
      <video id="a-roll" class="clip" src="assets/${escapeHtml(input.videoFile)}" playsinline data-start="0" data-duration="${sec(durationSec)}" data-track-index="0" data-has-audio="true"></video>
      <div id="scrim" class="clip" data-start="0" data-duration="${sec(durationSec)}" data-track-index="1"></div>
      ${wordmark}
      ${hook ? `<div id="hook" class="clip" data-start="${sec(hook.startSec)}" data-duration="${sec(hook.endSec - hook.startSec)}" data-track-index="3" style="top:${hookY}px">${withImage
        ? `<div class="hook-row"><img class="hook-img" src="assets/${escapeHtml(input.hookImageFile!)}" alt="${escapeHtml(overlay.hookImage?.alt ?? '')}" /><div class="hook-inner hook-side">${hookHtml}</div></div>`
        : `<div class="hook-inner">${hookHtml}</div>`}</div>` : ''}
      ${slotHtml}
      ${endHtml}
      ${captionHtml}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tweens.join('\n      ')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, issues };
}
