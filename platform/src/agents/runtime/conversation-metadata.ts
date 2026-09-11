import { z } from 'zod';
import { isVideoMetadataBotChallenge } from '../../lib/youtube-metadata';
import { evidencePacketSchema, type EvidencePacket } from '../contracts';

export const MAX_MEMORY_METADATA_CHARACTERS = 8_000;
const MAX_MEMORY_VIDEOS = 8;
const text = (maximum: number) => z.string().transform(value => value.slice(0, maximum));
const metadataSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  channel: z.object({ id: text(200), name: text(200) }).optional(),
  viewCount: z.number().int().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  isLive: z.boolean().optional(), hasCaptions: z.boolean().optional(),
  keywords: z.array(text(80)).transform(values => values.slice(0, 20)).optional(),
  availability: z.object({ status: text(100), reason: text(300).optional(),
    playable: z.boolean().optional(), isPrivate: z.boolean().optional() }).optional(),
  freshness: z.object({ fetchedAt: z.number().int().nonnegative().max(8.64e15) }).optional(),
});

/** Project persisted provider evidence, never model-authored result artifacts.
 * Recording time is kept distinct from fetch time for historical packets that
 * did not persist freshness. Reusing this packet has no evidence charge. */
export function metadataForConversation(records: readonly { packet: EvidencePacket; recordedAt: number }[]): EvidencePacket[] {
  const selected: EvidencePacket[] = [];
  const seen = new Set<string>();
  for (const { packet, recordedAt } of [...records].reverse()) {
    if (packet.kind !== 'youtube_video') continue;
    const artifact = packet.artifacts.find(item => item.type === 'youtube_video_metadata');
    const parsed = metadataSchema.safeParse(artifact?.data);
    if (!parsed.success || isVideoMetadataBotChallenge(parsed.data)) continue;
    const data = parsed.data;
    if (seen.has(data.id)) continue;
    const source = packet.sources.find(item => item.videoId === data.id);
    if (!source) continue;
    const title = (artifact?.title ?? source.title ?? data.id).slice(0, 500);
    const timestamp = data.freshness?.fetchedAt ?? recordedAt;
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8.64e15) continue;
    const time = new Date(timestamp).toISOString();
    const memoryId = `memory:${data.id}:${recordedAt}`;
    const snapshot = evidencePacketSchema.parse({
      packetId: memoryId,
      kind: 'youtube_video',
      sources: [{ ...source, title, url: `https://www.youtube.com/watch?v=${data.id}` }],
      excerpts: [{ id: memoryId, sourceId: source.id, text: [
        `Historical metadata ${data.freshness ? 'fetched' : 'recorded'} at: ${time}. This is not a current lookup.`,
        data.viewCount !== undefined ? `Views: ${data.viewCount}` : undefined,
        `Title: ${title}`, data.channel ? `Channel: ${data.channel.name}` : undefined,
        data.durationSeconds !== undefined ? `Duration seconds: ${data.durationSeconds}` : undefined,
        data.availability ? `Availability at observation: ${data.availability.status}` : undefined,
        data.isLive !== undefined ? `Live: ${data.isLive}` : undefined,
        data.hasCaptions !== undefined ? `Captions available: ${data.hasCaptions}` : undefined,
        data.keywords?.length ? `Keywords: ${data.keywords.join(', ')}` : undefined,
      ].filter(Boolean).join('\n').slice(0, 2_000) }],
      artifacts: [{ type: 'youtube_video_metadata', title, data: {
        ...data, ...(data.freshness ? { freshness: { state: 'stale', fetchedAt: data.freshness.fetchedAt } } : {}),
        recordedAt, historical: true,
      } }],
      warnings: [{ code: 'HISTORICAL_VIDEO_METADATA', videoId: data.id,
        message: `Metadata was ${data.freshness ? 'fetched' : 'recorded'} at ${time} in an earlier turn. Label changing counts with that time; refresh if current data is required.` }],
      usage: [],
    });
    if (JSON.stringify([...selected, snapshot]).length > MAX_MEMORY_METADATA_CHARACTERS) continue;
    selected.push(snapshot);
    seen.add(data.id);
    if (selected.length >= MAX_MEMORY_VIDEOS) break;
  }
  return selected;
}

/** Current-run metadata supersedes historical observations of the same video. */
export function preferCurrentMetadata(packets: readonly EvidencePacket[]): EvidencePacket[] {
  const currentVideos = new Set(packets.filter(packet => packet.kind === 'youtube_video' && !packet.packetId.startsWith('memory:'))
    .flatMap(packet => packet.sources.flatMap(source => source.videoId ? [source.videoId] : [])));
  return packets.filter(packet => !packet.packetId.startsWith('memory:')
    || !packet.sources.some(source => source.videoId && currentVideos.has(source.videoId)));
}

export function evidenceWithConversationMetadata(current: readonly EvidencePacket[], history: readonly { metadata?: EvidencePacket[] }[]): EvidencePacket[] {
  const memory: EvidencePacket[] = [];
  const seen = new Set<string>();
  for (const turn of [...history].reverse()) for (const packet of turn.metadata ?? []) {
    const videoId = packet.sources[0]?.videoId;
    if (!videoId || seen.has(videoId)) continue;
    memory.push(packet);
    seen.add(videoId);
  }
  return preferCurrentMetadata([...memory, ...current]);
}
