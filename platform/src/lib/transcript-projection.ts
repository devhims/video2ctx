import type { Transcript, TranscriptSegment } from 'all-things-youtube';
import { ApiError } from './http';

export type TranscriptFormat = 'text' | 'segments' | 'words';

export type TextTranscript = Pick<Transcript, 'videoId' | 'track' | 'translatedTo' | 'text' | 'meta'>;

export function parseTranscriptFormat(value?: string): TranscriptFormat {
  if (!value) return 'words';
  if (value === 'text' || value === 'segments' || value === 'words') return value;
  throw new ApiError(422, 'INVALID_TRANSCRIPT_FORMAT', 'Use text, segments, or words for transcript format.');
}

export function projectTranscript(
  transcript: Transcript,
  format: TranscriptFormat,
): Transcript | TextTranscript {
  if (format === 'words') return transcript;
  if (format === 'text') {
    return compact({
      videoId: transcript.videoId,
      track: transcript.track,
      translatedTo: transcript.translatedTo,
      text: transcript.text,
      meta: transcript.meta,
    }) as TextTranscript;
  }
  return {
    ...transcript,
    granularity: 'segment',
    segments: transcript.segments.map(withoutWords),
  };
}

function withoutWords(segment: TranscriptSegment): TranscriptSegment {
  const { words: _words, ...rest } = segment;
  return rest;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
