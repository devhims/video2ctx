import { z } from 'zod';
import type { EvidencePacket } from '../contracts';
import { storyboardSchema, type Storyboard } from '../providers/youtube/storyboard';
import { framePreviewSchema, saveImagePreviews } from './frame-previews';

const storyboardPreviewObjectSchema = framePreviewSchema.extend({
  width: z.number().int().positive().max(16384),
  endTimestampMs: z.number().int().nonnegative(),
  frameCount: z.number().int().positive(),
  columns: z.number().int().positive(), rows: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
});
export const storyboardPreviewSchema = storyboardPreviewObjectSchema.refine(sheet => sheet.frameCount <= sheet.columns * sheet.rows
  && sheet.endTimestampMs === sheet.timestampMs + (sheet.frameCount - 1) * sheet.intervalMs,
{ message: 'Invalid storyboard preview mapping.' });
export const storyboardPreviewsSchema = z.array(storyboardPreviewSchema).max(20);
export type StoryboardPreview = z.infer<typeof storyboardPreviewSchema>;
export type SaveStoryboardPreviews = (storyboard: Storyboard, signal: AbortSignal) => Promise<StoryboardPreview[]>;
export const storyboardTraceSchema = z.object({
  mode: z.enum(['metadata', 'inspection']), sheets: storyboardPreviewsSchema,
});

export function packetStoryboardPreviews(packet: EvidencePacket): z.infer<typeof storyboardTraceSchema> {
  const data = packet.artifacts.find(artifact => artifact.type === 'youtube_storyboard_analysis')?.data;
  const selection = z.object({ mode: z.string() }).safeParse(data?.selection);
  const mode = selection.success && selection.data.mode === 'metadata' ? 'metadata' : 'inspection';
  const previews = storyboardPreviewsSchema.safeParse(data?.previews);
  return { mode, sheets: mode === 'inspection' && previews.success ? previews.data : [] };
}

export async function saveStoryboardPreviews(bucket: R2Bucket, userId: string, value: Storyboard, signal: AbortSignal): Promise<StoryboardPreview[]> {
  signal.throwIfAborted();
  const storyboard = storyboardSchema.parse(value);
  const images = storyboard.sheets.map(sheet => ({ imageBase64: sheet.imageBase64, metadata: {
    timestampMs: sheet.firstFrameIndex * sheet.intervalMs,
    endTimestampMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs,
    width: sheet.tileWidth * sheet.columns, height: sheet.tileHeight * sheet.rows,
    frameCount: sheet.frameCount, columns: sheet.columns, rows: sheet.rows, intervalMs: sheet.intervalMs,
  } }));
  // Validate descriptors and the aggregate payload before saving any objects.
  for (const image of images) storyboardPreviewObjectSchema.omit({ assetId: true, collectionId: true }).parse(image.metadata);
  const totalBytes = images.reduce((bytes, { imageBase64 }) => bytes + imageBase64.length * 3 / 4
    - (imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0), 0);
  if (totalBytes > 8 * 1024 * 1024) {
    throw new Error('Storyboard previews exceed the 8 MiB image limit.');
  }
  return saveImagePreviews(bucket, userId, images, signal);
}
