import { z } from 'zod';
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
export type SaveFramePreviews = (frames: VideoFrames, signal: AbortSignal) => Promise<FramePreview[]>;

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
  const artifact = packet.artifacts.find(value => value.type === 'youtube_frame_analysis');
  const parsed = z.array(framePreviewSchema).max(6).safeParse(artifact?.data?.previews);
  return parsed.success ? parsed.data : [];
}

export async function saveFramePreviews(bucket: R2Bucket, userId: string, value: VideoFrames, signal: AbortSignal): Promise<FramePreview[]> {
  signal.throwIfAborted();
  const frames = framesSchema.parse(value).frames;
  const collectionId = await frameCollectionId(userId);
  const saved: { key: string; preview: FramePreview }[] = [];
  try {
    // At most six writes, each bounded by the extraction contract. Sequential
    // writes keep cancellation and rollback from racing outstanding uploads.
    for (const frame of frames) {
      signal.throwIfAborted();
      const assetId = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      const key = framePreviewKey(collectionId, assetId);
      const preview = { assetId, collectionId, timestampMs: frame.timestampMs, width: frame.width, height: frame.height };
      saved.push({ key, preview });
      await bucket.put(key, Uint8Array.from(atob(frame.imageBase64), value => value.charCodeAt(0)), {
        httpMetadata: { contentType: 'image/jpeg', cacheControl: 'no-store' },
      });
      signal.throwIfAborted();
    }
    return saved.map(value => value.preview);
  } catch (error) {
    if (saved.length) await bucket.delete(saved.map(value => value.key));
    throw error;
  }
}
