import { z } from 'zod';
import { finalizeAnswerInputSchema, type FinalizeAnswerInput } from './contracts';

/** Model-facing only. Persisted and public answers retain their existing format. */
const fields = finalizeAnswerInputSchema.omit({ answer: true, citations: true, intent: true }).extend({
  warnings: z.array(z.object({
    code: z.enum(['SOURCE_CAVEAT', 'ANSWER_SCOPE_SHORTFALL']).describe('SOURCE_CAVEAT: limitations of sources, such as unverified demos. ANSWER_SCOPE_SHORTFALL: a specific requested item, count, or question could not be answered. Source uncertainty alone is not an unmet request.'),
    message: z.string().min(1).max(1_000),
  })).max(3).default([]).describe('At most three distinct, material limitations. The application already returns warnings from the evidence packets. Do not repeat inherited warnings, summarize the answer, or discuss generating the response.'),
});
const block = z.object({
  // The SDK bounds generation tokens and the rendered contract bounds total
  // characters. A decoding limit on each paragraph can split words at its edge.
  text: z.string().trim().min(1).describe('One complete paragraph or list item. End at a natural sentence boundary; never continue a sentence in the next block.'),
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
export const FINALIZATION_SCHEMA_VERSION = 'answer-blocks-v3';

export function assertRequestedNumberedItems(output: z.infer<typeof finalizationOutputSchema>, expected: number | undefined) {
  if (expected === undefined || output.warnings.some(warning => warning.code === 'ANSWER_SCOPE_SHORTFALL')) return;
  const numbers = new Set([...output.blocks.map(block => block.text).join('\n').matchAll(
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(\d+)[.)][ \t]+/g,
  )].map(match => Number(match[1])));
  if (numbers.size !== expected || !Array.from({ length: expected }, (_, index) => index + 1).every(number => numbers.has(number))) {
    throw new z.ZodError([{ code: 'custom', path: ['blocks'],
      message: `The request requires ${expected} numbered items, labeled 1 through ${expected}. Supply each supported item, or state the actual shortfall and add ANSWER_SCOPE_SHORTFALL. Do not invent items.` }]);
  }
}

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema> | z.infer<typeof clarificationAnswerSchema>): FinalizeAnswerInput {
  const input = value.intent === 'clarification' ? clarificationAnswerSchema.parse(value) : structuredAnswerSchema.parse(value);
  assertCoherentAnswerBlocks(input);
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    warnings: input.warnings.map(warning => ({ ...warning, code: warning.code === 'ANSWER_SCOPE_SHORTFALL' ? 'PARTIAL_EVIDENCE' : warning.code })),
    citations: [],
    answer: input.blocks.map(block => {
      // Only application-owned references may create citation markers.
      const text = block.text
        .replace(/【ref_\d+】|\[ref_\d+\]/g, '')
        .replace(/\[cite:/g, '(source marker:');
      return `${text} ${[...new Set(block.evidenceIds)].map(id => `[cite:${id}]`).join(' ')}`.trim();
    }).join('\n\n'),
  });
}

/** Local checks complement the transmitted schema without constraining decoding. */
function assertCoherentAnswerBlocks(input: { blocks: { text: string }[]; warnings: { message: string }[] }) {
  const issues: z.core.$ZodIssue[] = [];
  for (let index = 1; index < input.blocks.length; index++) {
    const previous = input.blocks[index - 1]!.text.trim();
    const current = input.blocks[index]!.text.trim();
    if (!/[.!?。！？:）)\]"'`*]$/.test(previous) && /^\p{Ll}/u.test(current)) {
      issues.push({ code: 'custom', path: ['blocks', index - 1, 'text'],
        message: 'Each block must be a complete paragraph or list item. Rewrite the sentence that continues across this boundary.' });
    }
  }
  for (const [index, warning] of input.warnings.entries()) {
    const words = warning.message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const occurrences = new Map<string, number[]>();
    for (let offset = 0; offset + 8 <= words.length; offset++) {
      const key = words.slice(offset, offset + 8).join(' ');
      const positions = occurrences.get(key) ?? [];
      if (!positions.length || offset - positions.at(-1)! >= 8) positions.push(offset);
      occurrences.set(key, positions);
      if (positions.length >= 3) {
        issues.push({ code: 'custom', path: ['warnings', index, 'message'],
          message: 'Remove repetitive text. State each material source limitation once, without generation or continuation commentary.' });
        break;
      }
    }
  }
  if (issues.length) throw new z.ZodError(issues);
}
