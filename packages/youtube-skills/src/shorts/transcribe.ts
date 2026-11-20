import type { Transcript, TranscriptSegment } from 'all-things-youtube';

/** One word from HyperFrames' Whisper transcript (seconds). */
export interface WhisperWord {
  text: string;
  start: number;
  end: number;
}

const SEGMENT_WORDS = 12;

/**
 * Turn Whisper words into the word-timed transcript shape `read` writes from YouTube captions,
 * so every later command works the same. Segments break at sentence ends or every 12 words.
 */
export function whisperToTranscript(videoId: string, words: WhisperWord[], model: string, language = 'en'): Transcript {
  const clean = words
    .filter((word) => typeof word.text === 'string' && word.text.trim() && Number.isFinite(word.start))
    .map((word) => ({ text: word.text.trim(), startMs: Math.round(word.start * 1_000), endMs: Math.round(Math.max(word.end, word.start) * 1_000) }))
    .sort((left, right) => left.startMs - right.startMs);
  const segments: TranscriptSegment[] = [];
  let current: typeof clean = [];
  const flush = () => {
    if (!current.length) return;
    const startMs = current[0]!.startMs;
    const endMs = current.at(-1)!.endMs;
    segments.push({
      startMs,
      endMs,
      durationMs: endMs - startMs,
      text: current.map((word) => word.text).join(' '),
      words: current.map((word, index) => ({ text: index === 0 ? word.text : ` ${word.text}`, startMs: word.startMs, offsetMs: word.startMs - startMs })),
    });
    current = [];
  };
  for (const word of clean) {
    current.push(word);
    if (current.length >= SEGMENT_WORDS || /[.?!]["')\]]*$/.test(word.text)) flush();
  }
  flush();
  return {
    videoId,
    track: { id: `whisper.${model}`, name: `Whisper ${model} (local)`, languageCode: language, kind: 'asr', isTranslatable: false },
    granularity: 'word',
    segments,
    text: segments.map((segment) => segment.text).join('\n'),
    meta: { source: 'whisper', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
  } as unknown as Transcript;
}

interface WhisperCliToken {
  text: string;
  t_dtw?: number;
  offsets?: { from: number; to: number };
}

/**
 * Words from whisper-cli's full JSON (-ojf). With --dtw each token carries a token-level
 * timestamp (t_dtw, in 10 ms units) that tracks the audio far better than segment offsets on
 * long recordings. A token starting with a space opens a new word; the rest join the current one.
 */
export function parseWhisperCliJson(value: unknown, offsetMs = 0): WhisperWord[] {
  const transcription = (value as { transcription?: Array<{ tokens?: WhisperCliToken[] }> })?.transcription;
  if (!Array.isArray(transcription)) throw new Error('whisper-cli JSON has no transcription.');
  const words: WhisperWord[] = [];
  for (const segment of transcription) {
    for (const token of segment.tokens ?? []) {
      if (!token.text || /^\[_.*\]$/.test(token.text.trim())) continue;
      const atMs = token.t_dtw !== undefined && token.t_dtw >= 0 ? token.t_dtw * 10 : token.offsets?.from;
      if (atMs === undefined) continue;
      const seconds = (atMs + offsetMs) / 1_000;
      const last = words.at(-1);
      if (token.text.startsWith(' ') || !last) {
        const text = token.text.trim();
        if (text) words.push({ text, start: seconds, end: seconds });
      } else {
        last.text += token.text;
        last.end = Math.max(last.start, seconds);
      }
    }
  }
  return words;
}

/** whisper.cpp's DTW alignment preset for a model name (large-v3 -> large.v3). */
export function dtwPreset(model: string): string {
  return model.replace(/^large-v(\d)/, 'large.v$1');
}
