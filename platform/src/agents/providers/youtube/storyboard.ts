import { z } from 'zod';

const positive = z.number().int().positive();
export const storyboardManifestSchema = z.object({
  totalSheets: positive, framesPerSheet: positive,
  tileWidth: positive, tileHeight: positive, columns: positive, rows: positive,
  lastSampleMs: z.number().int().nonnegative(),
});
export interface StoryboardSelectionOptions {
  maxSheets?: number;
  sheetIndexes?: number[];
  metadataOnly?: boolean;
}
export const storyboardSchema = z.object({
  manifest: storyboardManifestSchema.optional(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  frameCount: positive,
  intervalMs: positive,
  selection: z.object({ mode: z.enum(['leading', 'spread', 'timestamps', 'indexes', 'metadata']),
    requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(20).optional(),
    requestedSheetIndexes: z.array(z.number().int().nonnegative()).max(20).optional() }).optional(),
  sheets: z.array(z.object({
    tileWidth: positive, tileHeight: positive, columns: positive, rows: positive,
    firstFrameIndex: z.number().int().nonnegative(), frameCount: positive,
    intervalMs: positive,
    imageBase64: z.string().min(4).max(5_592_408).regex(/^\/9j\/[A-Za-z0-9+/]*={0,2}$/),
  })).max(20),
  meta: z.object({ partial: z.boolean(), warnings: z.array(z.string()).max(20) }),
}).superRefine((index, ctx) => {
  if (index.selection?.mode === 'metadata' ? (!index.manifest || index.sheets.length !== 0) : index.sheets.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Metadata requires a manifest and no images; inspection requires images.' });
  }
  if (index.manifest && (index.manifest.framesPerSheet !== index.manifest.columns * index.manifest.rows
    || index.manifest.totalSheets !== Math.ceil(index.frameCount / index.manifest.framesPerSheet)
    || index.manifest.lastSampleMs !== (index.frameCount - 1) * index.intervalMs)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid storyboard manifest.' });
  }
  const seen = new Set<number>();
  for (const sheet of index.sheets) {
    if (sheet.frameCount > sheet.columns * sheet.rows || sheet.firstFrameIndex + sheet.frameCount > index.frameCount
      || sheet.intervalMs !== index.intervalMs) ctx.addIssue({ code: 'custom', message: 'Invalid storyboard frame mapping.' });
    for (let i = 0; i < sheet.frameCount; i++) {
      const frame = sheet.firstFrameIndex + i;
      if (seen.has(frame)) ctx.addIssue({ code: 'custom', message: 'Overlapping storyboard sheets.' });
      seen.add(frame);
    }
  }
});
export type Storyboard = z.infer<typeof storyboardSchema>;
