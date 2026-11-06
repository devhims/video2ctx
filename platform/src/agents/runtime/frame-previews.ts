import { visualSpan, countVisualWork } from '../../lib/visual-diagnostics';
import { VerifiedImage } from '../../lib/verified-image';
import { mapInBatches, FRAME_IO_CONCURRENCY, EVIDENCE_IO_CONCURRENCY } from '../../lib/map-in-batches';
import { z } from 'zod';
import { videoImageKey } from '../../lib/video-catalog';
import { sha256 } from '../../lib/http';
import { framesSchema, type VideoFrames } from '../../lib/youtube-frames-contract';
import type { EvidencePacket } from '../contracts';

export const framePreviewSchema = z.object({
  assetId: z.string().regex(/^[a-f0-9]{64}$/),
  collectionId: z.string().regex(/^[a-f0-9]{64}$/),
  timestampMs: z.number().int().nonnegative(),
  width: z.number().int().positive().max(1920),
  height: z.number().int().positive().max(16384),
});
export type FramePreview = z.infer<typeof framePreviewSchema>;
export type SaveFramePreviews = (frames: VideoFrames, signal: AbortSignal, verifiedImages?: VerifiedImage[]) => Promise<FramePreview[]>;

function frameCollectionId(userId: string) {
  return sha256(`agent-frames:${userId}`);
}

export async function framePreviewPrefix(userId: string) {
  return `agent-frames/${await frameCollectionId(userId)}/`;
}

export function framePreviewKey(collectionId: string, assetId: string) {
  return `agent-frames/${collectionId}/${assetId}.jpg`;
}

export function packetFramePreviews(packet: EvidencePacket): FramePreview[] {
  if (packet.kind !== 'youtube_frames') return [];
  const artifact = packet.artifacts.find(value => ['youtube_frame_analysis', 'youtube_frame_retrieval'].includes(value.type));
  const parsed = z.array(framePreviewSchema).max(6).safeParse(artifact?.data?.previews);
  return parsed.success ? parsed.data : [];
}

/** One saved frame: its asset version and the moment it shows. */
export type SavedFrame = { version: string; timestampMs: number };

/** Previews saved when these exact frame versions were retrieved. A packet's preview at a frame's
 * time is taken only when that packet holds the frame's own version: a packet has one frame per
 * time, so sharing another version proves nothing about it. Deleting a version removes every
 * packet that uses it, so a carried reference cannot outlive its image. */
export function recordedFramePreviews(packets: readonly EvidencePacket[], frames: readonly SavedFrame[]) {
  const found = new Map<number, FramePreview>();
  for (const packet of [...packets].reverse()) {
    if (packet.kind !== 'youtube_frames') continue;
    const times = new Set(frames.filter(frame => packet.assetVersions?.includes(frame.version)).map(frame => frame.timestampMs));
    if (!times.size) continue;
    for (const artifact of packet.artifacts) {
      if (!['youtube_frame_retrieval', 'youtube_frame_analysis'].includes(artifact.type) || !Array.isArray(artifact.data.previews)) continue;
      for (const item of artifact.data.previews) {
        const preview = framePreviewSchema.safeParse(item);
        if (preview.success && times.has(preview.data.timestampMs) && !found.has(preview.data.timestampMs))
          found.set(preview.data.timestampMs, preview.data);
      }
    }
  }
  return found.size ? [...found.values()].sort((a, b) => a.timestampMs - b.timestampMs) : undefined;
}

const observationFramesSchema = z.object({ excerptId: z.string(), framesMs: z.array(z.number().int().nonnegative()).min(2).max(6) });
const FRAME_ARTIFACTS = ['youtube_frame_retrieval', 'youtube_frame_analysis'];

/** Frame times a cited excerpt covers. Shared and combined findings record every supporting
 * frame; a combined finding stored before that record names only its first and last frames. */
export function citedFrameTimes(artifacts: EvidencePacket['artifacts'], excerpt: { id: string; startMs?: number; endMs?: number }): number[] {
  if (excerpt.startMs === undefined) return [];
  for (const artifact of artifacts) {
    if (!FRAME_ARTIFACTS.includes(artifact.type)) continue;
    for (const field of ['sharedObservations', 'combinedObservations'] as const)
      for (const item of Array.isArray(artifact.data[field]) ? artifact.data[field] : []) {
        const observation = observationFramesSchema.safeParse(item);
        if (observation.success && observation.data.excerptId === excerpt.id) return [...observation.data.framesMs].sort((a, b) => a - b);
      }
  }
  return excerpt.endMs !== undefined && excerpt.endMs > excerpt.startMs ? [excerpt.startMs, excerpt.endMs] : [excerpt.startMs];
}

/** Previews for one cited excerpt, taken only from the packet that holds the excerpt: within
 * one packet each time has one capture, so these are the pixels the answer used. */
export function citedPacketFramePreviews(packet: EvidencePacket, excerpt: { id: string; startMs?: number; endMs?: number }): FramePreview[] {
  if (packet.kind !== 'youtube_frames') return [];
  const previews = new Map<number, FramePreview>();
  for (const artifact of packet.artifacts) {
    if (!FRAME_ARTIFACTS.includes(artifact.type) || !Array.isArray(artifact.data.previews)) continue;
    for (const item of artifact.data.previews) {
      const preview = framePreviewSchema.safeParse(item);
      if (preview.success && !previews.has(preview.data.timestampMs)) previews.set(preview.data.timestampMs, preview.data);
    }
  }
  return citedFrameTimes(packet.artifacts, excerpt).flatMap(time => previews.get(time) ?? []);
}

/** Answer artifact recording which saved previews each cited frame excerpt used. Every frame
 * citation of a new answer has an entry; an empty list records that its packet saved no preview,
 * so no other capture of the same moment may stand in. Only answers without it are older. */
export const CITED_FRAME_PREVIEWS = 'cited_frame_previews';
export const citedFramePreviewsSchema = z.object({
  citations: z.array(z.object({ citationId: z.string(), frames: z.array(framePreviewSchema).max(6) })),
});

export async function saveFramePreviews(bucket: R2Bucket, userId: string, value: VideoFrames, signal: AbortSignal, sharedBucket?: R2Bucket, verifiedImages?: VerifiedImage[]): Promise<FramePreview[]> {
  signal.throwIfAborted();
  const frames = framesSchema.parse(value).frames;
  return saveImagePreviews(bucket, userId, frames.map(frame => ({ imageBase64: frame.imageBase64,
    metadata: { timestampMs: frame.timestampMs, width: frame.width, height: frame.height } })), signal,
    sharedBucket ? {bucket:sharedBucket,videoId:value.videoId,verifiedImages} : undefined, FRAME_IO_CONCURRENCY);
}

// Both visual tools share the existing collection, serving route and account cleanup.
export async function saveImagePreviews<T extends { width: number; height: number }>(
  bucket: R2Bucket, userId: string, images: { imageBase64: string; metadata: T }[], signal: AbortSignal,
  shared?: {bucket:R2Bucket;videoId:string;verifiedImages?: VerifiedImage[]},
  concurrency = EVIDENCE_IO_CONCURRENCY,
): Promise<(T & { assetId: string; collectionId: string })[]> {
  signal.throwIfAborted();
  const collectionId = await frameCollectionId(userId);
  const saved: { key: string; preview: T & { assetId: string; collectionId: string } }[] = [];
  try {
    // All started writes settle before rollback. Preserve descriptor order even
    // when individual uploads finish out of order.
    return await mapInBatches(images, async (image) => {
      signal.throwIfAborted();
      const assetId = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      const key = framePreviewKey(collectionId, assetId);
      const preview = { ...image.metadata, assetId, collectionId };
      saved.push({ key, preview });
      const bytes = Uint8Array.from(atob(image.imageBase64), value => value.charCodeAt(0));
      if (shared) {
        const sharedImageKey = await videoImageKey(shared.videoId,bytes);
        const verified = shared.verifiedImages?.find(image => image instanceof VerifiedImage && image.matches(shared.bucket, sharedImageKey));
        if (!verified && !await visualSpan('preview_r2', () => { countVisualWork('previewR2Heads'); return shared.bucket.head(sharedImageKey); })) throw new Error('Shared preview image is unavailable.');
        // This private capability can be revoked without deleting the source JPEG.
        await visualSpan('preview_r2', () => { countVisualWork('previewR2Puts'); return bucket.put(key,JSON.stringify(verified?.previewReference() ?? {sharedImageKey}),{
          httpMetadata:{contentType:'application/json',cacheControl:'no-store'},
        }); });
      } else {
        await visualSpan('preview_r2', () => { countVisualWork('previewR2Puts'); return bucket.put(key,bytes,{httpMetadata:{contentType:'image/jpeg',cacheControl:'no-store'}}); });
      }
      signal.throwIfAborted();
      return preview;
    }, concurrency);
  } catch (error) {
    if (saved.length) await visualSpan('preview_r2', () => { countVisualWork('previewR2Deletes'); return bucket.delete(saved.map(value => value.key)); });
    throw error;
  }
}
