import type { TranscriptSegment } from 'all-things-youtube';
import type { EvidencePacket } from '../contracts';

/** IDs are original array positions, including positions occupied by empty captions. */
export function flatTranscript(segments: readonly TranscriptSegment[]): string {
  return segments.flatMap((segment, id) => segment.text ? [`${id} ${segment.text.replace(/[\r\n]+/g, ' ')}`] : []).join('\n');
}

/** Keep timing and full identifiers in application storage, once per source in model input. */
export function compactTranscript(excerpts: EvidencePacket['excerpts']) {
  const first = excerpts[0]?.id ?? '';
  const prefix = first.match(/^(.*[:_])\d+$/)?.[1];
  const shared = prefix !== undefined && excerpts.every(excerpt =>
    excerpt.id.startsWith(prefix) && /^\d+$/.test(excerpt.id.slice(prefix.length)));
  return {
    citationPrefix: shared ? prefix : '',
    text: excerpts.map(excerpt => `${shared ? excerpt.id.slice(prefix.length) : excerpt.id} ${excerpt.text.replace(/[\r\n]+/g, ' ')}`).join('\n'),
  };
}

/** Return all captions overlapping the instant, plus a small number of neighbours. */
export function transcriptContextIndexes(segments: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[], timestampSeconds: number, before = 10, after = 10): number[] {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) throw new Error('Timestamp must be nonnegative seconds.');
  if (![before, after].every(value => Number.isInteger(value) && value >= 0 && value <= 10)) throw new Error('Neighbour counts must be between 0 and 10.');
  const time = timestampSeconds * 1000;
  if (!segments.length || time > segments.reduce((end, segment) => Math.max(end, segment.endMs), 0)) return [];
  const overlapping = segments.flatMap((segment, index) => segment.startMs <= time && segment.endMs > time ? [index] : []);
  // A gap is context, not speech at the requested instant. The caller exposes this distinction.
  const next = segments.findIndex(segment => segment.startMs >= time);
  const anchor = next < 0 ? segments.length - 1 : next;
  const first = overlapping[0] ?? anchor;
  const last = overlapping.at(-1) ?? anchor;
  return Array.from({ length: Math.min(segments.length - 1, last + after) - Math.max(0, first - before) + 1 }, (_, index) => Math.max(0, first - before) + index);
}

/** Explicit clock notation can be routed before sending a transcript to a model. */
export function requestedTranscriptTimes(message: string): number[] {
  const withoutUrls = message.replace(/https?:\/\/\S+/g, '');
  return [...new Set([...withoutUrls.matchAll(/\b(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)\b/g)].map(match =>
    Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])))].slice(0, 4);
}
