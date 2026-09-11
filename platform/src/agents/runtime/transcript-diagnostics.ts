import { z } from 'zod';

export const transcriptValidationIssueSchema = z.object({
  code: z.enum(['ENTITY_NOT_SUPPORTED', 'QUANTITY_NOT_SUPPORTED', 'UNIT_NOT_EXPLICIT', 'UNIT_MISMATCH', 'BASIS_NOT_SUPPORTED', 'UNCERTAINTY_MISSING', 'CLAIM_QUANTITY_NOT_SUPPORTED', 'UNKNOWN_WINDOW', 'OUTPUT_LIMIT', 'SCHEMA_INVALID']),
  findingIndex: z.number().int().nonnegative().optional().describe('Zero-based index in the rejected model output.'),
  fieldIndex: z.number().int().nonnegative().optional(),
  windowIndex: z.number().int().nonnegative().optional(),
  message: z.string().max(1000),
});
export type TranscriptValidationIssue = z.infer<typeof transcriptValidationIssueSchema>;

/** Private run evidence. Never write content fields to console or send them to a model as accepted evidence. */
export const transcriptDiagnosticSchema = z.object({
  version: z.literal(1),
  stage: z.literal('transcript_analysis'),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  modelCallId: z.string().max(500),
  attemptId: z.string().uuid(),
  attempt: z.number().int().min(1).max(2),
  recordedAt: z.number(),
  outcome: z.enum(['started', 'rejected', 'accepted', 'failed', 'canceled']),
  elapsedMs: z.number().nonnegative(),
  code: z.enum(['GROUNDING_REJECTED', 'INVALID_REFERENCE', 'OUTPUT_LIMIT', 'SCHEMA_INVALID', 'PROVIDER_ERROR', 'ANALYSIS_ERROR', 'ANALYSIS_TIMEOUT', 'CANCELED']).optional(),
  finishReason: z.string().max(50).optional(),
  modelId: z.string().max(200).optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cancellationReason: z.string().max(50).optional(),
  statusCode: z.number().optional(),
  issues: z.array(transcriptValidationIssueSchema).max(100).optional(),
  issueCount: z.number().int().nonnegative().optional(),
  repairFeedback: z.string().max(4000).optional(),
  rejectedOutput: z.string().max(24000).optional(),
  sourceContext: z.object({ title: z.string().max(500).optional(), channel: z.string().max(300).optional() }).optional(),
  sourceWindows: z.array(z.object({ index: z.number().int(), startMs: z.number(), endMs: z.number(), text: z.string().max(2000) })).max(15).optional(),
  captureTruncated: z.boolean().optional(),
});
export type TranscriptDiagnostic = z.infer<typeof transcriptDiagnosticSchema>;
export type TranscriptDiagnosticSink = (event: TranscriptDiagnostic) => void;
