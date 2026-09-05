import { z } from 'zod';

const positive = z.number().int().positive();
export const storyboardSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  frameCount: positive,
  intervalMs: positive,
  sheets: z.array(z.object({
    tileWidth: positive, tileHeight: positive, columns: positive, rows: positive,
    firstFrameIndex: z.number().int().nonnegative(), frameCount: positive,
    intervalMs: positive,
    imageBase64: z.string().min(4).max(5_592_408).regex(/^\/9j\/[A-Za-z0-9+/]*={0,2}$/),
  })).min(1).max(2),
  meta: z.object({ partial: z.boolean(), warnings: z.array(z.string()).max(20) }),
}).superRefine((index, ctx) => {
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
