import { z } from 'zod';
import { finalizeAnswerInputSchema, type FinalizeAnswerInput } from './contracts';

/** Model-facing only. Persisted and public answers retain their existing format. */
const fields = finalizeAnswerInputSchema.omit({ answer: true, citations: true, intent: true });
const block = z.object({
  text: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(z.string().regex(/^[A-Za-z0-9:_-]+$/).max(300)).min(1).max(12),
});
export const structuredAnswerSchema = z.discriminatedUnion('intent', [
  fields.extend({
    intent: z.enum(['topic_research', 'inspect_video']),
    blocks: z.array(block).min(1).max(8),
  }),
  fields.extend({
    intent: z.literal('clarification'),
    blocks: z.array(block.extend({ evidenceIds: z.array(z.string()).max(0) })).min(1).max(1),
  }),
]);

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema>): FinalizeAnswerInput {
  const input = structuredAnswerSchema.parse(value);
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    warnings: input.warnings,
    citations: [],
    answer: input.blocks.map(block => {
      // Only application-owned references may create citation markers.
      const text = block.text.replace(/\[cite:/g, '(source marker:');
      return `${text} ${[...new Set(block.evidenceIds)].map(id => `[cite:${id}]`).join(' ')}`.trim();
    }).join('\n\n'),
  });
}
