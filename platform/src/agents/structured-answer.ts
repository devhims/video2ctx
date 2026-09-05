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
// Keep tool parameters as a top-level object so models can see the actual fields.
// Conditional citation rules are still enforced before an answer can be persisted.
export const structuredAnswerSchema = fields.extend({
  intent: z.enum(['topic_research', 'inspect_video', 'clarification']),
  blocks: z.array(block.extend({ evidenceIds: z.array(block.shape.evidenceIds.element).max(12) })).min(1).max(20),
}).superRefine((input, ctx) => {
  if (input.intent === 'clarification' && input.blocks.length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'Clarification requires exactly one block.' });
  }
  input.blocks.forEach((value, index) => {
    if (input.intent === 'clarification' ? value.evidenceIds.length !== 0 : value.evidenceIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['blocks', index, 'evidenceIds'],
        message: input.intent === 'clarification' ? 'Clarification must not cite evidence.' : 'Every answer block requires supporting evidenceIds.' });
    }
  });
});

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema>): FinalizeAnswerInput {
  const input = structuredAnswerSchema.parse(value);
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
