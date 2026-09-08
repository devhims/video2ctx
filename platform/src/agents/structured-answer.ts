import { z } from 'zod';
import { finalizeAnswerInputSchema, type FinalizeAnswerInput } from './contracts';

/** Model-facing only. Persisted and public answers retain their existing format. */
const fields = finalizeAnswerInputSchema.omit({ answer: true, citations: true, intent: true }).extend({
  warnings: z.array(z.object({
    code: z.enum(['SOURCE_CAVEAT', 'ANSWER_SCOPE_SHORTFALL']).describe('SOURCE_CAVEAT: limitations of sources, such as unverified demos. ANSWER_SCOPE_SHORTFALL: a specific requested item, count, or question could not be answered. Source uncertainty alone is not an unmet request.'),
    message: z.string().min(1).max(1_000),
  })).max(50).default([]),
});
const block = z.object({
  text: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(z.string().regex(/^[A-Za-z0-9:_-]+$/).max(300)).min(1).max(12),
});
// Executable routes require references in the transmitted JSON schema itself.
// Do not hide model-facing requirements in refinements that JSON Schema omits.
export const structuredAnswerSchema = fields.extend({
  intent: z.enum(['topic_research', 'inspect_video']),
  blocks: z.array(block).min(1).max(20),
});

export const clarificationAnswerSchema = fields.extend({
  intent: z.literal('clarification'),
  blocks: z.array(block.extend({ evidenceIds: z.array(block.shape.evidenceIds.element).max(0) })).length(1),
});

// The classifier owns intent; persisted evidence owns artifacts and citations.
export const finalizationOutputSchema = structuredAnswerSchema.omit({ intent: true, artifacts: true });
export const FINALIZATION_SCHEMA_VERSION = 'answer-blocks-v2';

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema> | z.infer<typeof clarificationAnswerSchema>): FinalizeAnswerInput {
  const input = value.intent === 'clarification' ? clarificationAnswerSchema.parse(value) : structuredAnswerSchema.parse(value);
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    warnings: input.warnings.map(warning => ({ ...warning, code: warning.code === 'ANSWER_SCOPE_SHORTFALL' ? 'PARTIAL_EVIDENCE' : warning.code })),
    citations: [],
    answer: input.blocks.map(block => {
      // Only application-owned references may create citation markers.
      const text = block.text.replace(/\[cite:/g, '(source marker:');
      return `${text} ${[...new Set(block.evidenceIds)].map(id => `[cite:${id}]`).join(' ')}`.trim();
    }).join('\n\n'),
  });
}
