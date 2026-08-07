import type { TranscriptSegment } from 'all-things-youtube';
import type { Evidence } from './search';

const WINDOW_MS = 30_000;
const STOP_WORDS = new Set([
  'about', 'does', 'from', 'give', 'have', 'into', 'provide', 'that', 'the',
  'their', 'this', 'video', 'what', 'when', 'where', 'which', 'with', 'would',
]);

export function transcriptEvidence(
  videoId: string,
  segments: TranscriptSegment[],
  question: string,
  limit = 12
): Evidence[] {
  const windows = new Map<number, { startMs: number; text: string[] }>();
  for (const segment of segments) {
    const bucket = Math.floor(segment.startMs / WINDOW_MS);
    const existing = windows.get(bucket) ?? { startMs: segment.startMs, text: [] };
    existing.text.push(segment.text);
    windows.set(bucket, existing);
  }

  const tokens = [...new Set(
    question.toLowerCase().match(/[a-z0-9]+/g)
      ?.map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)) ?? []
  )];
  const candidates = [...windows.values()].map((window) => {
    const text = window.text.join(' ').replace(/\s+/g, ' ').trim();
    const normalized = text.toLowerCase();
    const score = tokens.reduce((total, token) => total + (normalized.match(new RegExp(`\\b${token}`, 'g'))?.length ?? 0), 0);
    return { ...window, text, score };
  });
  const relevant = candidates.filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const selected = relevant.length
    ? [...relevant, ...candidates.filter((candidate) => candidate.score === 0)].slice(0, limit)
    : evenlySpaced(candidates, limit);

  return selected.map((candidate) => ({
    id: `transcript:${videoId}:${candidate.startMs}`,
    score: candidate.score,
    text: candidate.text,
    entityId: videoId,
    startMs: candidate.startMs,
    sourceKey: `youtube://${videoId}/transcript/${candidate.startMs}`,
  }));
}

function evenlySpaced<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * (items.length - 1) / (limit - 1))]!);
}
