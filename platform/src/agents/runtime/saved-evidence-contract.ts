import { z } from 'zod';

export const SAVED_EVIDENCE_ARTIFACT = 'saved_original_evidence';
export const SAVED_EVIDENCE_READ_LIMIT = 16;
export const savedEvidenceCoverageSchema = z.object({
  assetVersion: z.string(), kind: z.enum(['transcript', 'comments']),
  totalExcerpts: z.number().int().nonnegative(), selectedExcerpts: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), returnedExcerpts: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().optional(),
  quoteCueIds: z.array(z.string()).optional(),
  captionSelection: z.enum(['keyword', 'chronological']).optional(),
  sourcePartial: z.boolean().optional(),
  sourceContinuationAvailable: z.boolean().optional(),
});
