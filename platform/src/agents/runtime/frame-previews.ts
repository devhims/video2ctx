import { visualSpan, countVisualWork } from '../../lib/visual-diagnostics';
import { VerifiedImage } from '../../lib/verified-image';
import { mapInBatches } from '../../lib/map-in-batches';
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

export async function saveFramePreviews(bucket: R2Bucket, userId: string, value: VideoFrames, signal: AbortSignal, sharedBucket?: R2Bucket, verifiedImages?: VerifiedImage[]): Promise<FramePreview[]> {
  signal.throwIfAborted();
  const frames = framesSchema.parse(value).frames;
  return saveImagePreviews(bucket, userId, frames.map(frame => ({ imageBase64: frame.imageBase64,
    metadata: { timestampMs: frame.timestampMs, width: frame.width, height: frame.height } })), signal,
    sharedBucket ? {bucket:sharedBucket,videoId:value.videoId,verifiedImages} : undefined);
}

// Both visual tools share the existing collection, serving route and account cleanup.
export async function saveImagePreviews<T extends { width: number; height: number }>(
  bucket: R2Bucket, userId: string, images: { imageBase64: string; metadata: T }[], signal: AbortSignal,
  shared?: {bucket:R2Bucket;videoId:string;verifiedImages?: VerifiedImage[]},
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
        const verified = shared.verifiedImages?.some(image => image instanceof VerifiedImage && image.matches(shared.bucket, sharedImageKey));
        if (!verified && !await visualSpan('preview_r2', () => { countVisualWork('previewR2Heads'); return shared.bucket.head(sharedImageKey); })) throw new Error('Shared preview image is unavailable.');
        // This private capability can be revoked without deleting the source JPEG.
        await visualSpan('preview_r2', () => { countVisualWork('previewR2Puts'); return bucket.put(key,JSON.stringify({sharedImageKey}),{
          httpMetadata:{contentType:'application/json',cacheControl:'no-store'},
        }); });
      } else {
        await visualSpan('preview_r2', () => { countVisualWork('previewR2Puts'); return bucket.put(key,bytes,{httpMetadata:{contentType:'image/jpeg',cacheControl:'no-store'}}); });
      }
      signal.throwIfAborted();
      return preview;
    });
  } catch (error) {
    if (saved.length) await visualSpan('preview_r2', () => { countVisualWork('previewR2Deletes'); return bucket.delete(saved.map(value => value.key)); });
    throw error;
  }
}
