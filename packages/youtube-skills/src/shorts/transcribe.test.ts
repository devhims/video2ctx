import { describe, expect, test } from 'vitest';

import { dtwPreset, parseWhisperCliJson, whisperToTranscript } from './transcribe';
import { flattenWords } from './transcript';

describe('whisperToTranscript', () => {
  test('builds word-timed segments the rest of the skill reads like YouTube captions', () => {
    const transcript = whisperToTranscript('abcdefghijk', [
      { text: 'What', start: 0.21, end: 0.31 },
      { text: 'if', start: 0.31, end: 0.42 },
      { text: 'AI?', start: 0.48, end: 0.69 },
      { text: 'Minions', start: 1.0, end: 1.4 },
      { text: ' ', start: 1.5, end: 1.6 },
    ], 'small.en');
    expect(transcript.segments.map((segment) => segment.text)).toEqual(['What if AI?', 'Minions']);
    expect(transcript.track).toMatchObject({ id: 'whisper.small.en', kind: 'asr' });
    const words = flattenWords(transcript.segments);
    expect(words.map((word) => [word.text, word.startMs])).toEqual([['What', 210], ['if', 310], ['AI?', 480], ['Minions', 1_000]]);
  });

  test('builds words from whisper-cli DTW tokens, joining subword and punctuation tokens', () => {
    const words = parseWhisperCliJson({ transcription: [{ tokens: [
      { text: '[_BEG_]', t_dtw: -1, offsets: { from: 0, to: 0 } },
      { text: ' What', t_dtw: 51, offsets: { from: 0, to: 300 } },
      { text: ' Min', t_dtw: 80, offsets: { from: 400, to: 500 } },
      { text: 'ions', t_dtw: 95, offsets: { from: 500, to: 600 } },
      { text: '.', t_dtw: -1, offsets: { from: 600, to: 650 } },
    ] }] }, 1_000);
    expect(words).toEqual([
      { text: 'What', start: 1.51, end: 1.51 },
      { text: 'Minions.', start: 1.8, end: 1.8 },
    ]);
    expect(() => parseWhisperCliJson({})).toThrow(/no transcription/);
    expect(dtwPreset('large-v3')).toBe('large.v3');
    expect(dtwPreset('small.en')).toBe('small.en');
  });
});
