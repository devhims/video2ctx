import { z } from 'zod';
import { clockTime } from '../../runtime/clock-time';

/**
 * Analyst rule shared by frame and storyboard analysis. The output schema enforces the
 * structure: a finding owns exactly one frame, and a shared finding lists two or more.
 */
export const ATOMIC_VISUAL_FINDING_GUIDANCE = 'Each finding describes exactly one frame and cites only that frame. Use sharedFindings only for one fact that is fully visible in each of its listed frames on its own, such as the same unchanged scoreboard. Never use sharedFindings for comparisons, changes, or earlier versus later descriptions; describe each frame in its own finding instead.';

/** Saved visual analyses written with one frame per finding and separate shared findings. */
export const VISUAL_PROVENANCE_VERSION = 2;

/** Excerpt text for a frame-specific observation. */
export function visualObservationText(kind: 'requested' | 'sampled', observation: string, timeMs: number): string {
  return `Visual observation at ${kind} frame ${clockTime(timeMs)}: ${observation}`;
}

/** Excerpt text for one shared observation, kept as a single excerpt naming every frame. */
export function sharedVisualObservationText(kind: 'requested' | 'sampled', observation: string, timesMs: readonly number[]): string {
  return `Shared visual observation, reported as visible in each of the ${kind} frames at ${[...timesMs].sort((a, b) => a - b).map(clockTime).join(', ')}: ${observation}`;
}

/** Two or more distinct frames; a repeated frame does not make an observation shared. */
export function distinctFrames<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Recorded with a visual analysis, so a shared excerpt can be traced to every frame it names. */
export const sharedObservationSchema = z.object({ excerptId: z.string(), framesMs: z.array(z.number().int().nonnegative()).min(2) });

/** Excerpt text for a finding an analyst attached to several frames outside sharedFindings. */
export function combinedVisualObservationText(kind: 'requested' | 'sampled', observation: string, timesMs: readonly number[]): string {
  return `Visual observation reported for the ${kind} frames at ${[...timesMs].sort((a, b) => a - b).map(clockTime).join(', ')} together. It may compare them, so it is not attributed to any one frame: ${observation}`;
}

/**
 * Evidence excerpts for one visual analysis. A single-frame finding becomes one excerpt
 * at its frame. A shared finding, or a multi-frame finding from an older analyst, becomes
 * one excerpt spanning its frames and is never copied onto each frame.
 */
export function visualAnalysisExcerpts<F>(options: {
  kind: 'requested' | 'sampled';
  idPrefix: string;
  sourceId: string;
  findings: ReadonlyArray<{ observation: string; frames: readonly F[] }>;
  sharedFindings: ReadonlyArray<{ observation: string; frames: readonly F[] }>;
  timeOf: (frame: F) => number;
  /** The frame key in a single-frame excerpt ID. Defaults to its time. */
  idOf?: (frame: F) => number;
  assertAvailable: (frame: F) => void;
}) {
  const key = (frame: F) => options.idOf?.(frame) ?? options.timeOf(frame);
  const excerpts: Array<{ id: string; sourceId: string; text: string; startMs: number; endMs: number }> = [];
  const sharedObservations: Array<z.infer<typeof sharedObservationSchema>> = [];
  const span = (id: string, frames: readonly F[], text: (times: number[]) => string, shared: boolean) => {
    const times = frames.map(options.timeOf).sort((a, b) => a - b);
    excerpts.push({ id, sourceId: options.sourceId, text: text(times), startMs: times[0]!, endMs: times.at(-1)! });
    if (shared) sharedObservations.push({ excerptId: id, framesMs: times });
  };
  // Ordinary multi-frame findings are combined and attributed to no frame; shared findings
  // are visible in each listed frame and recorded as such. Single frames read the same in both.
  const add = (finding: { observation: string; frames: readonly F[] }, prefix: string, shared: boolean) => {
    const frames = distinctFrames(finding.frames);
    frames.forEach(options.assertAvailable);
    if (frames.length === 1) {
      const time = options.timeOf(frames[0]!);
      excerpts.push({ id: `${prefix}:${key(frames[0]!)}`, sourceId: options.sourceId,
        text: visualObservationText(options.kind, finding.observation, time), startMs: time, endMs: time });
    } else if (frames.length > 1) {
      span(shared ? prefix : `${prefix}:combined`, frames, times => (shared ? sharedVisualObservationText : combinedVisualObservationText)(
        options.kind, finding.observation, times), shared);
    }
  };
  options.findings.forEach((finding, index) => add(finding, `${options.idPrefix}:${index}`, false));
  options.sharedFindings.forEach((finding, index) => add(finding, `${options.idPrefix}:shared:${index}`, true));
  return { excerpts, sharedObservations };
}
