import { describe, expect, test } from 'vitest';
import { parseTranscriptFormat, projectTranscript } from '../src/lib/transcript-projection';

const transcript = {
  videoId: 'abcdefghijk',
  track: {
    id: 'en',
    languageCode: 'en',
    name: 'English',
    kind: 'manual' as const,
    isTranslatable: true,
    isDefault: true,
  },
  translatedTo: { languageCode: 'fr', name: 'French' },
  segments: [{
    startMs: 0,
    durationMs: 1000,
    endMs: 1000,
    text: 'Bonjour',
    words: [{ text: 'Bonjour', startMs: 0, offsetMs: 0 }],
  }],
  granularity: 'word' as const,
  text: 'Bonjour',
  meta: {
    source: 'allthingsyoutube' as const,
    fetchedAt: '2026-08-17T00:00:00.000Z',
    partial: false,
    warnings: [],
  },
};

describe('transcript projections', () => {
  test('preserves the existing rich response when format is omitted', () => {
    expect(projectTranscript(transcript, parseTranscriptFormat(undefined))).toEqual(transcript);
  });

  test('returns compact text without timing arrays', () => {
    expect(projectTranscript(transcript, parseTranscriptFormat('text'))).toEqual({
      videoId: 'abcdefghijk',
      track: transcript.track,
      translatedTo: transcript.translatedTo,
      text: 'Bonjour',
      meta: transcript.meta,
    });
  });

  test('removes word timing from segment output', () => {
    expect(projectTranscript(transcript, parseTranscriptFormat('segments'))).toEqual({
      ...transcript,
      granularity: 'segment',
      segments: [{ startMs: 0, durationMs: 1000, endMs: 1000, text: 'Bonjour' }],
    });
  });

  test('rejects unsupported formats', () => {
    expect(() => parseTranscriptFormat('srt')).toThrow('Use text, segments, or words');
  });
});
