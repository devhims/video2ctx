import { normalizeToken, phraseTokens } from './transcript';
import type { CaptionWord, LayoutMode, RenderSegment, ResolvedShort } from './edl';

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
const CAPTION_TOP: Record<LayoutMode, number> = { crop: 1250, stack: 900, fit: 1290 };
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
  const slots: Array<Timed & { kind: 'name' | 'card'; html: string; id: string }> = [];

  if (overlay.nameTag) {
    const speaker = input.speakers[overlay.nameTag.speaker];
    if (!speaker) {
      issues.push(`nameTag speaker "${overlay.nameTag.speaker}" is not in speakers.`);
    } else {
      const startSec = findPhraseSec(input.words, overlay.nameTag.atPhrase) ?? overlay.nameTag.atSec ?? (hook ? hook.endSec + 0.2 : 0.5);
      slots.push({
        kind: 'name', id: 'name-tag', startSec,
        endSec: clampEnd(startSec, overlay.nameTag.durationSec ?? NAME_TAG_SEC),
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
      html: `<div class="card-label">${escapeHtml(card.label)}</div>` +
        `<div class="card-title">${escapeHtml(card.title)}</div>` +
        (card.body ? `<div class="card-body">${escapeHtml(card.body)}</div>` : '') +
        (card.source ? `<div class="card-source">Source: ${escapeHtml(card.source)}</div>` : ''),
    });
  });
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
      `style="top:${CAPTION_TOP[group.mode]}px;font-size:${captionSize(text)}px"><div class="cap-inner">${words}</div></div>`;
  }).join('\n      ');

  const slotHtml = visibleSlots.map((slot) =>
    `<div id="${slot.id}" class="clip slot" data-start="${sec(slot.startSec)}" data-duration="${sec(slot.endSec - slot.startSec)}" data-track-index="3"><div class="card">${slot.html}</div></div>`,
  ).join('\n      ');

  const tweens: string[] = [];
  if (hook) {
    tweens.push(
      `tl.from("#hook .hook-line", { y: 40, opacity: 0, duration: 0.35, ease: "power3.out", stagger: 0.12 }, ${sec(hook.startSec)});`,
      `tl.to("#hook .hook-inner", { opacity: 0, y: -20, duration: 0.25, ease: "power2.in" }, ${sec(hook.endSec - 0.25)});`,
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
    ? `<div id="end-card" class="clip" data-start="${sec(endCard.startSec)}" data-duration="${sec(END_CARD_SEC)}" data-track-index="3"><div class="end-inner">` +
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
      #hook { position: absolute; left: 0; right: 0; top: ${TOP_SLOT_Y + 70}px; }
      .hook-inner, .end-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 60px; }
      .hook-line, .end-line { font-family: "Montserrat", sans-serif; font-weight: 900; font-size: 74px; line-height: 1.04;
        color: #fff; text-transform: uppercase; text-align: center; text-shadow: 0 4px 18px rgba(0,0,0,.55); }
      .hook-hi span { background: var(--accent); padding: 4px 22px 8px; text-shadow: none; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      #end-card { position: absolute; left: 0; right: 0; top: ${TOP_SLOT_Y + 70}px; }
      .end-line { font-size: 58px; }
      .slot { position: absolute; left: 48px; top: ${TOP_SLOT_Y + 64}px; width: 760px; }
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
      ${hook ? `<div id="hook" class="clip" data-start="${sec(hook.startSec)}" data-duration="${sec(hook.endSec - hook.startSec)}" data-track-index="3"><div class="hook-inner">${hookHtml}</div></div>` : ''}
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
