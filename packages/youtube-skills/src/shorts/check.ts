/**
 * Rules for `check`: problems a viewer notices that the earlier steps cannot see from captions and
 * shot sheets alone. Each function is pure; the CLI feeds them measurements from FFmpeg.
 */

/** A shot shorter than this plays as a flash of the wrong framing. */
export const MIN_SHOT_SEC = 1;
/** Audio louder than this right at a cut edge means a word is clipped or the next one has begun. */
export const EDGE_SPEECH_DB = -40;
/** How much audio to measure just inside each cut edge. */
export const EDGE_WINDOW_MS = 20;
/** A hand-built end card can add at most this much after the last word. */
export const MAX_END_CARD_SEC = 3.5;

export interface Span {
  startSec: number;
  endSec: number;
}

/**
 * Shots shorter than `minSec` in a rendered short, from its scene-change times. The first and last
 * shots count too: a camera change just after the start or just before the end is also a flash.
 */
export function flashShots(changesSec: number[], durationSec: number, minSec = MIN_SHOT_SEC): Span[] {
  const marks = [0, ...[...changesSec].sort((a, b) => a - b).filter((at) => at > 0 && at < durationSec), durationSec];
  const flashes: Span[] = [];
  for (let index = 0; index < marks.length - 1; index += 1) {
    const [startSec, endSec] = [marks[index]!, marks[index + 1]!];
    if (endSec - startSec < minSec) flashes.push({ startSec: round(startSec), endSec: round(endSec) });
  }
  return flashes;
}

/**
 * Source camera changes that sit within `windowMs` of a cut's edges. `shots` cannot give these
 * their own layout entry in time to matter, so they play as a flash unless the edge moves.
 */
export function edgeHuggingChanges(changesMs: number[], inMs: number, outMs: number, windowMs = MIN_SHOT_SEC * 1_000): Array<{ atMs: number; edge: 'start' | 'end'; gapMs: number }> {
  const found: Array<{ atMs: number; edge: 'start' | 'end'; gapMs: number }> = [];
  for (const atMs of changesMs) {
    if (atMs <= inMs || atMs >= outMs) continue;
    if (atMs - inMs < windowMs) found.push({ atMs, edge: 'start', gapMs: Math.round(atMs - inMs) });
    else if (outMs - atMs < windowMs) found.push({ atMs, edge: 'end', gapMs: Math.round(outMs - atMs) });
  }
  return found;
}

/** Whether the audio level measured just inside a cut edge is speech rather than a pause. */
export function edgeHasSpeech(levelDb: number, thresholdDb = EDGE_SPEECH_DB): boolean {
  return Number.isFinite(levelDb) && levelDb > thresholdDb;
}

/**
 * Why an overlay video does not belong to the current cut, if it doesn't: it is older than the cut
 * it should show or than the overlay project it was rendered from (rebuilt after a title or caption
 * fix, say), or its length is not the cut's length plus at most an end card.
 */
export function overlayVideoProblem(
  video: { durationSec: number; modifiedMs: number },
  cut: { durationSec: number; modifiedMs: number },
  project?: { modifiedMs: number },
): string | undefined {
  if (video.modifiedMs < cut.modifiedMs) return 'was rendered before the current cut; run overlay again and render it';
  if (project && video.modifiedMs < project.modifiedMs) return 'was rendered before its overlay project was last rebuilt; render it again';
  const extra = video.durationSec - cut.durationSec;
  if (extra < -0.15 || extra > MAX_END_CARD_SEC) {
    return `runs ${video.durationSec.toFixed(2)}s, but the current cut is ${cut.durationSec.toFixed(2)}s (plus at most a ${MAX_END_CARD_SEC}s end card); run overlay again and render it`;
  }
  return undefined;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** A deliverable short is cut from a source at least this sharp on its shorter side (1080p, landscape or vertical). */
export const MIN_SOURCE_SHORT_SIDE = 1080;
/** The softest source a user may accept for deliverables, with --allow-720p. */
export const OPT_IN_SOURCE_SHORT_SIDE = 720;

/**
 * Why a source is too soft for a deliverable render, if it is. A 9:16 crop keeps about a third of a
 * 16:9 frame's width, so a 1080p source is upscaled about 1.8x and a 720p one about 2.7x; YouTube's
 * 360p review stream is never a deliverable. `floor` is 720 once the user has accepted a 720p master.
 */
export function sourceTooSoft(source: { width: number; height: number }, floor: number = MIN_SOURCE_SHORT_SIDE): string | undefined {
  const shorter = Math.min(source.width, source.height);
  if (shorter >= floor) return undefined;
  const size = `${source.width}x${source.height}`;
  if (floor > OPT_IN_SOURCE_SHORT_SIDE && shorter >= OPT_IN_SOURCE_SHORT_SIDE) {
    return `the source is ${size}; deliverable shorts need at least 1080p, or 720p with --allow-720p once the user accepts softer video`;
  }
  return `the source is ${size}; deliverable shorts need at least 1080p (720p with --allow-720p)`;
}

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Why a deliverable render can't be trusted, from its `<id>.cuts.json`: it was cut from a source that
 * is too soft, or its source size is missing or unreadable (rendered before sizes were recorded, or
 * edited by hand), so nothing shows it came from a qualified master.
 */
export function renderSourceProblem(manifest: unknown): string | undefined {
  const record = typeof manifest === 'object' && manifest !== null ? manifest as { source?: { width?: unknown; height?: unknown }; sourceFloor?: unknown } : {};
  const source = record.source;
  const floor = record.sourceFloor;
  if (!source || !isSize(source.width) || !isSize(source.height) || (floor !== undefined && floor !== OPT_IN_SOURCE_SHORT_SIDE && floor !== MIN_SOURCE_SHORT_SIDE)) {
    return 'has no recorded source size, so it may come from a review copy; render it again from a master of at least 1080p';
  }
  const soft = sourceTooSoft({ width: source.width, height: source.height }, typeof floor === 'number' ? floor : MIN_SOURCE_SHORT_SIDE);
  return soft ? `was cut from a ${source.width}x${source.height} source: ${soft}` : undefined;
}
