import { annaCaptions } from './watercolor-anna';
import { kelogCaptions } from './watercolor-kelogsloops';
import type { Transcript } from 'all-things-youtube';

// Regression source: saved Transcript previews in session
// 094fc8e9-48b8-4b80-9e67-5a9d5b3df79e, collected 2026-10-26.
// All 201/425 original segments, not analyst paraphrases. The UI
// exposes whole-second start times; end times below are fixture boundaries.
// Caption text and starts are copied from the full saved previews.
export const annaId = 'LxyZ4a_YzSQ';
export const kelogId = 'yU_IUaa-7W0';
export const watercolorInitial = 'Compare Anna Bucciarelli’s https://www.youtube.com/watch?v=LxyZ4a_YzSQ and kelogsloops’ https://www.youtube.com/watch?v=yU_IUaa-7W0 for my beginner wet-on-wet practice plan, called Cedar. Use their narration and a compact table: how to judge readiness, how to extend a window that dries too quickly, and how to avoid blooms. Include an early, middle and late example from Anna, with creator names and clickable links to the actual supporting passages. Keep experiment elapsed time separate from video time, and separate your own recommendation from what each creator says. No comments or visual inspection needed.';
export const watercolorCorrection = 'Correction: name this plan Willow and use exactly three short numbered points from now on. Anna does discuss extending drying time later in the video. Please re-read the original saved captions and correct that omission, including whether smaller areas give more working time. Give precise passage-start links and short exact quotations for Anna’s medium and gravity advice and kelogsloops’ wet-but-not-beady cue and nearly dry brush warning. Keep elapsed experiment time separate from video time. Use existing saved transcripts, with no fresh YouTube retrieval.';
export const watercolorFollowup = 'After reopening, continue the same practice plan under its latest name and formatting preference, with no extra introduction or closing section. Preserve the corrected medium, surface-area and gravity advice. Use the saved-session read or search tool on the original Transcript assets rather than another analyst summary. Recover the four short exact quotations and precise passage links I requested. Return to Anna after kelogsloops: identify her paper, first pigment and later vein pigment, and calculate the elapsed interval from first stroke to the definition point. No fresh YouTube retrieval.';

export function watercolorTranscript(videoId: string): Transcript {
  const rows = videoId === annaId ? annaCaptions : kelogCaptions;
  return {
    videoId, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'asr', isTranslatable: true, isDefault: true },
    segments: rows.map(([seconds, text], index) => ({ startMs: seconds * 1000,
      endMs: Math.min(seconds + 2, rows[index + 1]?.[0] ?? seconds + 2) * 1000,
      durationMs: Math.min(2, (rows[index + 1]?.[0] ?? seconds + 2) - seconds) * 1000, text })),
    text: rows.map(([, text]) => text).join(' '),
    meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-26T08:19:30Z', partial: false, warnings: [] },
  };
}
