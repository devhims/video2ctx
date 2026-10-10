import type { TranscriptSegment } from 'all-things-youtube';
import type { EvidencePacket } from '../contracts';

/** IDs are original array positions, including positions occupied by empty captions. */
export function flatTranscript(segments: readonly TranscriptSegment[]): string {
  return segments.flatMap((segment, id) => usableTranscriptSegment(segment.text) ? [`${id} ${segment.text.replace(/[\r\n]+/g, ' ')}`] : []).join('\n');
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

/** Exact captions are never truncated; pathological captions are omitted with a warning. */
export const MAX_TRANSCRIPT_SEGMENT_CHARACTERS = 16_000;
export function usableTranscriptSegment(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TRANSCRIPT_SEGMENT_CHARACTERS;
}
export function hasSpeechAtTimestamp(segments: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[], seconds: number): boolean {
  return segments.some(segment => segment.startMs <= seconds * 1000 && segment.endMs > seconds * 1000);
}
export function parseSegmentCitation(id: string): { version: string; index: number } | undefined {
  const match = id.match(/^evidence:([a-f0-9]{64}):segment:(0|[1-9]\d*)$/);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { version: match[1]!, index: Number(match[2]) };
}
export function segmentCitationId(version: string, index: number): string {
  return `evidence:${version}:segment:${index}`;
}

/** Citable retrieval metadata, never represented as words spoken in a caption. */
export function transcriptContextStatus(id: string, sourceId: string, segments: readonly Pick<TranscriptSegment, 'endMs'>[], timestampSeconds: number): EvidencePacket['excerpts'][number] {
  const endMs = segments.reduce((end, segment) => Math.max(end, segment.endMs), 0);
  return { id, sourceId, text: `Transcript lookup status: no usable captions were returned near playback time ${timestampSeconds} seconds. `
    + (segments.length ? `The supplied transcript's last caption ends at ${endMs / 1000} seconds. ` : 'The supplied transcript contains no captions. ')
    + 'This describes transcript coverage, not the video duration or speech at the requested time.' };
}

/** Compare playback times with video metadata, never with the last caption time. */
export function timestampVideoBounds(packets: readonly EvidencePacket[]) {
  const durations = new Map<string, Set<number>>();
  for (const packet of packets) for (const artifact of packet.artifacts) {
    if (artifact.type !== 'youtube_video_metadata') continue;
    const videoIds = [...new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))];
    const videoId = typeof artifact.data.id === 'string' ? artifact.data.id : videoIds.length === 1 ? videoIds[0] : undefined;
    const duration = artifact.data.durationSeconds;
    if (!videoId || !videoIds.includes(videoId) || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) continue;
    const values = durations.get(videoId) ?? new Set<number>();
    values.add(duration);
    durations.set(videoId, values);
  }
  return packets.flatMap(packet => packet.artifacts.flatMap(artifact => {
    if (artifact.type !== 'youtube_transcript_context') return [];
    const requested = artifact.data.timestampSeconds;
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) return [];
    const sourceVideos = [...new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))];
    const requestedVideo = typeof artifact.data.videoId === 'string' ? artifact.data.videoId : sourceVideos.length === 1 ? sourceVideos[0] : undefined;
    if (!requestedVideo || !sourceVideos.includes(requestedVideo)) return [];
    return [requestedVideo].flatMap(videoId => {
      const values = durations.get(videoId);
      // Conflicting stored durations cannot establish a single boundary.
      if (values?.size !== 1) return [];
      const durationSeconds = [...values][0]!;
      return [{ videoId, timestampSeconds: requested, durationSeconds,
        position: requested > durationSeconds ? 'after the reported video end' : requested === durationSeconds ? 'at the reported video end' : 'within the reported video duration' }];
    });
  }));
}
