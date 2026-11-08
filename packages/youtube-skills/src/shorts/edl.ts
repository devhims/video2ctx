import type { Brand, ShortOverlay, Speaker } from './overlay';
import {
  ShortsInputError,
  countPhrase,
  findPhrase,
  formatTime,
  parseTime,
  phraseTokens,
  type Word,
} from './transcript';

export type LayoutMode = 'crop' | 'stack' | 'fit';

/** How the source frame becomes 9:16 from `atMs` (source time) until the next entry. */
export interface LayoutEntry {
  atMs: number;
  mode: LayoutMode;
  /** crop: horizontal center of the 9:16 window as a fraction of source width. */
  x?: number;
  /** stack: vertical center of each half's crop as a fraction of source height. */
  y?: number;
  /** stack: put the right half on top. */
  swap?: boolean;
}

export interface CutSpec {
  from?: string;
  to?: string;
  after?: string;
  startMs?: number;
  endMs?: number;
  /** Caption text after glossary corrections; written by plan. */
  text?: string;
}

export interface ShortSpec {
  id: string;
  title?: string;
  hook?: string;
  cuts: CutSpec[];
  layout?: LayoutEntry[];
  notes?: string;
  durationSec?: number;
  overlay?: ShortOverlay;
}

export interface Edl {
  videoId: string;
  /** Caption corrections: misheard phrase -> correct text. */
  glossary?: Record<string, string>;
  /** Milliseconds of audio kept before each cut's first word. */
  leadInMs?: number;
  brand?: Brand;
  speakers?: Record<string, Speaker>;
  shorts: ShortSpec[];
  [key: string]: unknown;
}

export interface ResolvedCut {
  startMs: number;
  endMs: number;
  /** Start of the cut's last word; the speech ends somewhere between this and endMs. */
  lastWordStartMs: number;
  /** Media in-point: startMs minus lead-in, never before the previous word ends. */
  inMs: number;
  outMs: number;
  /** Set by render when no pause was found at that edge. */
  softIn?: boolean;
  softOut?: boolean;
}

export interface Issue {
  short?: string;
  level: 'error' | 'warning';
  message: string;
}

export const DEFAULT_LEAD_IN_MS = 120;
export const SHORTS_MAX_SEC = 180;
export const SHORTS_TARGET_SEC = 60;
const SNAP_MS = 200;
const FILLERS = new Set(['uh', 'um', 'umm', 'uhm', 'er', 'erm']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEdl(value: unknown): Edl {
  if (!isRecord(value)) throw new ShortsInputError('edl.json must be a JSON object.');
  if (typeof value.videoId !== 'string') throw new ShortsInputError('edl.json needs a videoId string.');
  if (!Array.isArray(value.shorts) || !value.shorts.length) {
    throw new ShortsInputError('edl.json needs a non-empty shorts array.');
  }
  const ids = new Set<string>();
  value.shorts.forEach((short, index) => {
    if (!isRecord(short) || typeof short.id !== 'string' || !short.id.trim()) {
      throw new ShortsInputError(`shorts[${index}] needs an id string.`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(short.id)) {
      throw new ShortsInputError(`Short id "${short.id}" may use only letters, digits, - and _.`);
    }
    if (ids.has(short.id)) throw new ShortsInputError(`Short id "${short.id}" is used twice.`);
    ids.add(short.id);
    if (!Array.isArray(short.cuts) || !short.cuts.length) {
      throw new ShortsInputError(`Short ${short.id} needs a non-empty cuts array.`);
    }
    if (short.layout !== undefined && !Array.isArray(short.layout)) {
      throw new ShortsInputError(`Short ${short.id} layout must be an array.`);
    }
  });
  if (value.glossary !== undefined) {
    if (!isRecord(value.glossary) || Object.values(value.glossary).some((entry) => typeof entry !== 'string')) {
      throw new ShortsInputError('glossary must map strings to strings.');
    }
  }
  if (value.leadInMs !== undefined && (!Number.isSafeInteger(value.leadInMs) || (value.leadInMs as number) < 0)) {
    throw new ShortsInputError('leadInMs must be a non-negative integer.');
  }
  return value as Edl;
}

/** Resolve one cut to word-accurate times. Phrases win over stored times. */
export function resolveCut(words: Word[], cut: CutSpec, label: string, issues: Issue[], short: string): ResolvedCut | undefined {
  let startMs: number;
  let endMs: number;
  let lastWordStartMs: number;
  if (cut.from !== undefined || cut.to !== undefined) {
    if (!cut.from || !cut.to) {
      issues.push({ short, level: 'error', message: `${label}: give both "from" and "to" phrases.` });
      return undefined;
    }
    const afterMs = cut.after ? parseTime(cut.after) : 0;
    const from = findPhrase(words, cut.from, afterMs);
    if (!from) {
      issues.push({ short, level: 'error', message: `${label}: "from" phrase "${cut.from}" not found${cut.after ? ` after ${cut.after}` : ''}.` });
      return undefined;
    }
    if (!cut.after && countPhrase(words, cut.from) > 1) {
      issues.push({ short, level: 'warning', message: `${label}: "from" phrase occurs more than once; add "after" to pin it.` });
    }
    const to = findPhrase(words, cut.to, words[from.first]!.startMs);
    if (!to) {
      issues.push({ short, level: 'error', message: `${label}: "to" phrase "${cut.to}" not found after "${cut.from}".` });
      return undefined;
    }
    startMs = words[from.first]!.startMs;
    endMs = words[to.last]!.endMs;
    lastWordStartMs = words[to.last]!.startMs;
  } else if (Number.isSafeInteger(cut.startMs) && Number.isSafeInteger(cut.endMs)) {
    startMs = cut.startMs!;
    endMs = cut.endMs!;
    lastWordStartMs = [...words].reverse().find((word) => !word.tag && word.startMs < endMs)?.startMs ?? startMs;
  } else {
    issues.push({ short, level: 'error', message: `${label}: give "from"/"to" phrases or integer startMs/endMs.` });
    return undefined;
  }
  if (endMs <= startMs) {
    issues.push({ short, level: 'error', message: `${label}: ends before it starts.` });
    return undefined;
  }
  return { startMs, endMs, lastWordStartMs: Math.max(startMs, Math.min(lastWordStartMs, endMs - 1)), inMs: startMs, outMs: endMs };
}

/** Minimum audio of the previous word kept out of a lead-in. */
const PREVIOUS_WORD_GUARD_MS = 200;

/**
 * Start the media slightly before the first word (ASR starts run late), but stay at least
 * PREVIOUS_WORD_GUARD_MS past the previous word's start so its sound mostly stays out.
 */
export function applyLeadIn(words: Word[], cut: ResolvedCut, leadInMs: number): ResolvedCut {
  let previousStart = -Infinity;
  for (const word of words) {
    if (word.startMs >= cut.startMs) break;
    if (!word.tag) previousStart = word.startMs;
  }
  const inMs = Math.max(0, previousStart + PREVIOUS_WORD_GUARD_MS, cut.startMs - leadInMs);
  return { ...cut, inMs: Math.min(inMs, cut.startMs) };
}

function validateLayout(short: ShortSpec, cuts: ResolvedCut[], issues: Issue[]): void {
  const layout = short.layout ?? [];
  let previous = -1;
  layout.forEach((entry, index) => {
    const label = `layout[${index}]`;
    if (!isRecord(entry) || !Number.isSafeInteger(entry.atMs)) {
      issues.push({ short: short.id, level: 'error', message: `${label} needs an integer atMs.` });
      return;
    }
    if (!['crop', 'stack', 'fit'].includes(entry.mode)) {
      issues.push({ short: short.id, level: 'error', message: `${label} mode must be crop, stack, or fit.` });
    }
    for (const key of ['x', 'y'] as const) {
      const value = entry[key];
      if (value !== undefined && (typeof value !== 'number' || value < 0 || value > 1)) {
        issues.push({ short: short.id, level: 'error', message: `${label} ${key} must be a fraction from 0 to 1.` });
      }
    }
    if (entry.atMs < previous) {
      issues.push({ short: short.id, level: 'error', message: `${label} is out of order; sort layout by atMs.` });
    }
    previous = entry.atMs;
  });
  const first = cuts[0];
  if (!layout.length) {
    issues.push({ short: short.id, level: 'warning', message: 'No layout yet; render will center-crop. Run shots and set layout per shot.' });
  } else if (first && layout[0]!.atMs > first.inMs) {
    issues.push({ short: short.id, level: 'warning', message: `First layout entry starts after the first cut (${formatTime(first.inMs)}); center crop fills the gap.` });
  }
}

export interface Silence {
  startMs: number;
  endMs: number;
}

export interface SnapResult {
  cut: ResolvedCut;
  notes: string[];
}

/** Speech resumes this long after a pause ends; start the cut this far before it. */
const SNAP_PRE_ROLL_MS = 80;
/** Keep this much of a pause after the last word before cutting. */
const SNAP_TAIL_MS = 120;

const inside = (ms: number, silence: Silence) => ms >= silence.startMs && ms <= silence.endMs;

/**
 * Move a cut's media edges into pauses so it neither clips a word nor catches the next one.
 * Caption timings are approximate; the audio decides. Edges with no pause nearby are left
 * alone and reported, since that usually means a word is clipped or two words run together.
 */
export function snapCutToSilence(cut: ResolvedCut, silences: Silence[], label: string): SnapResult {
  const notes: string[] = [];
  let { inMs, outMs } = cut;
  let softIn = false;
  let softOut = false;

  if (!silences.some((silence) => inside(inMs, silence))) {
    const candidates = silences.filter((silence) => silence.endMs >= cut.startMs - 300 && silence.endMs <= cut.startMs + 250);
    const best = candidates.sort((a, b) => Math.abs(a.endMs - cut.startMs) - Math.abs(b.endMs - cut.startMs))[0];
    if (best) inMs = Math.max(best.startMs, best.endMs - SNAP_PRE_ROLL_MS);
    else softIn = true;
    if (!best) notes.push(`${label}: no pause at the start; the first word may be clipped or the previous word may bleed in.`);
  }
  if (!silences.some((silence) => inside(outMs, silence))) {
    const candidates = silences.filter((silence) => silence.startMs >= cut.lastWordStartMs + 150 && silence.startMs <= cut.outMs + 300);
    const best = candidates.sort((a, b) => Math.abs(a.startMs - cut.outMs) - Math.abs(b.startMs - cut.outMs))[0];
    if (best) outMs = Math.min(best.endMs, best.startMs + SNAP_TAIL_MS);
    else softOut = true;
    if (!best) notes.push(`${label}: no pause after the last word; it may be clipped or the next word may start.`);
  }
  if (outMs - inMs < 200) return { cut, notes: [...notes, `${label}: snapping would leave under 0.2 s; kept the caption times.`] };
  return { cut: { ...cut, inMs, outMs, ...(softIn ? { softIn } : {}), ...(softOut ? { softOut } : {}) }, notes };
}

/** Round a cut's media edges to the source's frame grid so video and audio lengths agree exactly. */
export function alignCutToFrames(cut: ResolvedCut, fps: number): ResolvedCut {
  const frameMs = 1_000 / fps;
  const align = (ms: number) => Math.round(ms / frameMs) * frameMs;
  const inMs = align(cut.inMs);
  return { ...cut, inMs, outMs: Math.max(inMs + frameMs, align(cut.outMs)) };
}

export interface ResolvedShort {
  spec: ShortSpec;
  cuts: ResolvedCut[];
  durationMs: number;
}

export function resolveShorts(words: Word[], edl: Edl, only?: Set<string>): { shorts: ResolvedShort[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const leadInMs = edl.leadInMs ?? DEFAULT_LEAD_IN_MS;
  const shorts: ResolvedShort[] = [];
  if (only) {
    for (const id of only) {
      if (!edl.shorts.some((short) => short.id === id)) issues.push({ level: 'error', message: `No short with id ${id}.` });
    }
  }
  for (const spec of edl.shorts) {
    if (only && !only.has(spec.id)) continue;
    const cuts: ResolvedCut[] = [];
    spec.cuts.forEach((cut, index) => {
      const resolved = resolveCut(words, cut, `cuts[${index}]`, issues, spec.id);
      if (resolved) cuts.push(applyLeadIn(words, resolved, leadInMs));
    });
    for (let index = 1; index < cuts.length; index += 1) {
      for (let earlier = 0; earlier < index; earlier += 1) {
        const [a, b] = [cuts[earlier]!, cuts[index]!];
        if (a.inMs < b.outMs && b.inMs < a.outMs) {
          issues.push({ short: spec.id, level: 'warning', message: `cuts[${index}] repeats audio from cuts[${earlier}]; fine only for a deliberate teaser.` });
        }
      }
    }
    const durationMs = cuts.reduce((total, cut) => total + cut.outMs - cut.inMs, 0);
    if (durationMs > SHORTS_MAX_SEC * 1_000) {
      issues.push({ short: spec.id, level: 'error', message: `Runs ${(durationMs / 1_000).toFixed(1)}s; Shorts allow at most ${SHORTS_MAX_SEC}s.` });
    } else if (durationMs > SHORTS_TARGET_SEC * 1_000) {
      issues.push({ short: spec.id, level: 'warning', message: `Runs ${(durationMs / 1_000).toFixed(1)}s, over the ${SHORTS_TARGET_SEC}s target.` });
    }
    if (!spec.hook) issues.push({ short: spec.id, level: 'warning', message: 'No hook text.' });
    validateLayout(spec, cuts, issues);
    shorts.push({ spec, cuts, durationMs });
  }
  return { shorts, issues };
}

export interface CaptionWord {
  text: string;
  /** Times on the short's own timeline. */
  startMs: number;
  endMs: number;
}

function glossaryEntries(glossary: Record<string, string> | undefined) {
  return Object.entries(glossary ?? {})
    .map(([wrong, right]) => ({ tokens: phraseTokens(wrong), right }))
    .filter((entry) => entry.tokens.length)
    .sort((left, right) => right.tokens.length - left.tokens.length);
}

/** Words for one short's captions, corrected and mapped onto the short's timeline. */
export function captionWords(words: Word[], short: ResolvedShort, glossary?: Record<string, string>): CaptionWord[] {
  const entries = glossaryEntries(glossary);
  const output: CaptionWord[] = [];
  let offset = 0;
  for (const cut of short.cuts) {
    const inCut = words.filter((word) => !word.tag && word.norm && word.startMs >= cut.startMs && word.startMs < cut.outMs);
    for (let index = 0; index < inCut.length;) {
      const word = inCut[index]!;
      const entry = entries.find((candidate) => candidate.tokens.every(
        (token, position) => inCut[index + position]?.norm === token,
      ));
      const toTimeline = (ms: number) => Math.max(0, Math.min(ms, cut.outMs) - cut.inMs + offset);
      if (entry) {
        const last = inCut[index + entry.tokens.length - 1]!;
        const trailing = /[^\p{L}\p{N}']+$/u.exec(last.text)?.[0] ?? '';
        output.push({ text: `${entry.right}${trailing}`, startMs: toTimeline(word.startMs), endMs: toTimeline(last.endMs) });
        index += entry.tokens.length;
        continue;
      }
      if (!FILLERS.has(word.norm)) {
        output.push({ text: word.text, startMs: toTimeline(word.startMs), endMs: toTimeline(word.endMs) });
      }
      index += 1;
    }
    offset += cut.outMs - cut.inMs;
  }
  return output;
}

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Group words into short punchy cues: at most `maxWords`, broken at sentence ends. */
export function buildCues(words: CaptionWord[], maxWords = 3, maxCueMs = 1_600): Cue[] {
  const cues: Cue[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({ startMs: current[0]!.startMs, endMs: current.at(-1)!.endMs, text: current.map((word) => word.text).join(' ') });
    current = [];
  };
  for (const word of words) {
    if (current.length && word.startMs - current[0]!.startMs > maxCueMs) flush();
    current.push(word);
    if (current.length >= maxWords || /[.?!,;:]["')\]]*$/.test(word.text)) flush();
  }
  flush();
  for (let index = 0; index < cues.length - 1; index += 1) {
    cues[index]!.endMs = Math.min(Math.max(cues[index]!.endMs, cues[index]!.startMs + 200), cues[index + 1]!.startMs);
  }
  return cues;
}

export function captionText(words: CaptionWord[]): string {
  return words.map((word) => word.text).join(' ');
}

function srtTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function assTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms / 10));
  const hours = Math.floor(safe / 360_000);
  const minutes = Math.floor((safe % 360_000) / 6_000);
  const seconds = Math.floor((safe % 6_000) / 100);
  const centis = safe % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`).join('\n');
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');
}

/** ASS captions for a 1080x1920 frame: cues in the lower third, optional hook at the top. */
export function toAss(cues: Cue[], hook?: string, hookMs = 3_000): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Caption,Arial,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,520,1',
    'Style: Hook,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,3,18,0,8,90,90,220,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map((cue) => `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Caption,,0,0,0,,${assEscape(cue.text.toUpperCase())}`);
  if (hook) events.unshift(`Dialogue: 1,${assTime(0)},${assTime(hookMs)},Hook,,0,0,0,,${assEscape(hook)}`);
  return `${[...header, ...events].join('\n')}\n`;
}

/** Layout entry active at a source time; entries are sorted by atMs. */
export function layoutAt(layout: LayoutEntry[] | undefined, atMs: number): LayoutEntry | undefined {
  let active: LayoutEntry | undefined;
  for (const entry of layout ?? []) {
    if (entry.atMs <= atMs) active = entry;
    else break;
  }
  return active;
}

export interface RenderSegment {
  inMs: number;
  outMs: number;
  layout: LayoutEntry;
}

/** Split a short's cuts wherever the layout changes. */
export function renderSegments(short: ResolvedShort, fps?: number): RenderSegment[] {
  const frameMs = fps ? 1_000 / fps : undefined;
  const align = (ms: number) => (frameMs ? Math.round(ms / frameMs) * frameMs : ms);
  const layout = short.spec.layout ?? [];
  const fallback: LayoutEntry = { atMs: 0, mode: 'crop', x: 0.5 };
  const segments: RenderSegment[] = [];
  for (const cut of short.cuts) {
    // Ignore layout changes within SNAP_MS of a cut edge; look SNAP_MS ahead when picking a layout.
    const changes = layout.map((entry) => entry.atMs).filter((ms) => ms > cut.inMs + SNAP_MS && ms < cut.outMs - SNAP_MS);
    const boundaries = [cut.inMs, ...changes.map(align), cut.outMs];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const inMs = boundaries[index]!;
      const outMs = boundaries[index + 1]!;
      segments.push({ inMs, outMs, layout: layoutAt(layout, Math.min(inMs + SNAP_MS, outMs)) ?? fallback });
    }
  }
  return segments;
}

