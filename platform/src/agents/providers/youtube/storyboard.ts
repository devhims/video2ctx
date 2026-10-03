import { z } from 'zod';
import { ApiError } from '../../../lib/http';

export const MAX_STORYBOARD_SHEETS = 20;

const positive = z.number().int().positive();
export const storyboardManifestSchema = z.object({
  totalSheets: positive, framesPerSheet: positive,
  tileWidth: positive, tileHeight: positive, columns: positive, rows: positive,
  lastSampleMs: z.number().int().nonnegative(),
});
export interface StoryboardSelectionOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
  refresh?: boolean;
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
    requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(MAX_STORYBOARD_SHEETS).optional(),
    requestedSheetIndexes: z.array(z.number().int().nonnegative()).max(MAX_STORYBOARD_SHEETS).optional() }).optional(),
  sheets: z.array(z.object({
    tileWidth: positive, tileHeight: positive, columns: positive, rows: positive,
    firstFrameIndex: z.number().int().nonnegative(), frameCount: positive,
    intervalMs: positive,
    imageBase64: z.string().min(4).max(5_592_408).regex(/^\/9j\/[A-Za-z0-9+/]*={0,2}$/),
  })).max(MAX_STORYBOARD_SHEETS),
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

/** Image-download failures do not make the discovered manifest incomplete. */
export function storyboardMetadata(board: Storyboard): Storyboard {
  return storyboardSchema.parse({ ...board, sheets: [], selection: { mode: 'metadata' },
    meta: { partial: false, warnings: [] } });
}

/** Match the processor's spread selection, including its middle-sheet overview. */
export function storyboardSheetIndexes(
  board: Pick<Storyboard, 'manifest' | 'intervalMs'>,
  options: Pick<StoryboardSelectionOptions, 'maxSheets' | 'sheetIndexes'> & { timestampsMs?: number[] },
): number[] {
  const manifest = board.manifest;
  if (!manifest) throw new Error('Storyboard manifest unavailable.');
  const count = options.maxSheets ?? MAX_STORYBOARD_SHEETS;
  const invalid = () => new ApiError(422, 'INVALID_INPUT', `Invalid storyboard selection. Available sheet indexes are 0 through ${manifest.totalSheets - 1}; timestamps must be below ${manifest.lastSampleMs + board.intervalMs} ms. Select 1 to ${MAX_STORYBOARD_SHEETS} sheets within maxSheets=${count}.`);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STORYBOARD_SHEETS) throw invalid();
  const take = Math.min(count, manifest.totalSheets);
  const indexes = options.sheetIndexes ?? (options.timestampsMs
    ? [...new Set(options.timestampsMs.map(time => Math.floor(time / (manifest.framesPerSheet * board.intervalMs))))]
    : Array.from({ length: take }, (_, i) => take === 1
      ? Math.floor((manifest.totalSheets - 1) / 2)
      : Math.round(i * (manifest.totalSheets - 1) / (take - 1))));
  if (!indexes.length || indexes.length > count || new Set(indexes).size !== indexes.length
    || (options.sheetIndexes && options.timestampsMs)
    || indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= manifest.totalSheets)
    || options.timestampsMs?.some(time => !Number.isSafeInteger(time) || time < 0
      || time >= manifest.lastSampleMs + board.intervalMs)) {
    throw invalid();
  }
  return [...indexes].sort((a, b) => a - b);
}
