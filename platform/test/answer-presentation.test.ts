import { presentableWarnings } from '../src/agents/finalizer';
import { answerLengthGuidance } from '../src/agents/research/answer-guidance';

// Warnings from a production visual comparison (attention explainers, November 4, 2026).
const warnings = [
  { code: 'SAMPLED_VISUAL_EVIDENCE', message: 'Observations cover sampled storyboard frames only. Brief events and small text may be missed.' },
  { code: 'PARTIAL_STORYBOARD', message: 'Storyboard: limited to 6 sheets' },
  { code: 'VISUAL_ANALYSIS_WARNING', message: 'The small frame size makes many token labels and matrix entries difficult to read.' },
  { code: 'VISUAL_ANALYSIS_WARNING', message: 'Some small text and numbers in the contact-sheet frames are not legible at the supplied resolution.' },
  { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only. Timestamps identify requested seek positions.' },
  { code: 'FRAME_EXTRACTION_WARNING', message: '2 requested frame(s) could not be extracted.' },
  { code: 'FRAME_EXTRACTION_WARNING', message: 'Extraction time budget reached; completed frames were retained.' },
  { code: 'FRAME_EXTRACTION_WARNING', message: 'Best-effort media fallback produced frames below 720p.' },
  { code: 'FRAME_EXTRACTION_WARNING', message: 'Some requested frames could not be extracted.' },
  { code: 'FRAME_UNAVAILABLE', message: 'Frame at 740000ms is unavailable (FRAME_EXTRACTION_FAILED).' },
  { code: 'FRAME_UNAVAILABLE', message: 'Frame at 1250000ms is unavailable (FRAME_EXTRACTION_FAILED).' },
  { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only.' },
  { code: 'VISUAL_ANALYSIS_WARNING', message: 'The small dot-product labels are difficult to read at this resolution.' },
  { code: 'TRANSCRIPT_ANALYST_WARNING', message: 'Some figures in 2 transcript findings could not be matched to the transcript and are marked unverified.' },
  { code: 'SAVED_VIDEO_METADATA', message: 'These values were saved at 2026-10-30T21:16:54.581Z.' },
  { code: 'SOURCE_CAVEAT', message: 'The 12:20 and 20:50 descriptions rest on sampled storyboard frames.' },
  { code: 'SOURCE_CAVEAT', message: 'The beginner comparison is a judgment, not a measured learning outcome.' },
];

describe('answer presentation', () => {
  it('collapses restated limitations and keeps distinct warnings', () => {
    expect(presentableWarnings(warnings).map(warning => warning.message)).toEqual([
      'Observations cover sampled storyboard frames only. Brief events and small text may be missed.',
      'Storyboard: limited to 6 sheets',
      'The small frame size makes many token labels and matrix entries difficult to read.',
      'Observations cover selected still frames only. Timestamps identify requested seek positions.',
      'Extraction time budget reached; completed frames were retained.',
      'Best-effort media fallback produced frames below 720p.',
      'Frame at 740000ms is unavailable (FRAME_EXTRACTION_FAILED).',
      'Frame at 1250000ms is unavailable (FRAME_EXTRACTION_FAILED).',
      'Some figures in 2 transcript findings could not be matched to the transcript and are marked unverified.',
      'These values were saved at 2026-10-30T21:16:54.581Z.',
      'The 12:20 and 20:50 descriptions rest on sampled storyboard frames.',
      'The beginner comparison is a judgment, not a measured learning outcome.',
    ]);
  });

  it('keeps one restated limitation per named video and the generic count without per-frame warnings', () => {
    const perVideo = [
      { code: 'SAVED_VIDEO_METADATA', message: 'Saved at one time.', videoId: 'aaaaaaaaaaa' },
      { code: 'SAVED_VIDEO_METADATA', message: 'Saved at another time.', videoId: 'bbbbbbbbbbb' },
      { code: 'FRAME_EXTRACTION_WARNING', message: 'Some requested frames could not be extracted.' },
    ];
    expect(presentableWarnings(perVideo)).toEqual(perVideo);
  });

  it('gives each answer detail a visible length budget', () => {
    expect(answerLengthGuidance('standard')).toContain('150 to 400 words');
    expect(answerLengthGuidance(undefined)).toContain('150 to 400 words');
    expect(answerLengthGuidance('detailed')).toContain('700 words');
  });
});
