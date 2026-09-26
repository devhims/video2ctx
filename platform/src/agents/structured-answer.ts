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
  text: z.string().trim().min(1).describe('One complete paragraph, list item, or Markdown table. Finish the table within this block. End prose at a natural sentence boundary; never continue a sentence in the next block.'),
  evidenceIds: z.array(z.string().regex(/^[A-Za-z0-9:_-]+$/).max(300)).min(1).max(12),
});
// Executable routes require references in the transmitted JSON schema itself.
// Do not hide model-facing requirements in refinements that JSON Schema omits.
export const structuredAnswerSchema = fields.extend({
  intent: z.enum(['topic_research', 'inspect_video']),
  blocks: z.array(block).min(1).max(20),
});

export const clarificationAnswerSchema = fields.extend({
  intent: z.enum(['clarification', 'rejected']),
  blocks: z.array(block.extend({ evidenceIds: z.array(block.shape.evidenceIds.element).max(0) })).length(1),
});

export const contextAnswerSchema = fields.extend({
  intent: z.literal('context_answer'),
  blocks: z.array(block.extend({
    evidenceIds: z.array(block.shape.evidenceIds.element).max(12).describe('Cite persisted evidence for video facts. Use no evidence IDs only when discussing prior conversation statements, without treating them as verified video facts.'),
  })).min(1).max(20),
});

// The classifier owns intent; persisted evidence owns artifacts and citations.
export const finalizationOutputSchema = structuredAnswerSchema.omit({ intent: true, artifacts: true });
export const contextFinalizationOutputSchema = contextAnswerSchema.omit({ intent: true, artifacts: true });
export const conversationalFinalizationOutputSchema = clarificationAnswerSchema.omit({ intent: true, artifacts: true });
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

/** Render provisional model text only. Citations remain hidden until validation commits the answer. */
export function renderPartialAnswer(value: { blocks?: Array<{ text?: string } | undefined> }): string {
  return (value.blocks ?? []).flatMap(block => {
    if (typeof block?.text !== 'string' || !block.text.trim()) return [];
    return [block.text
      .replace(/【ref_\d*】?|\[ref_\d*\]?/g, '')
      .replace(/\[cite:[^\]]*\]?/g, '')
      .replace(/\(source marker:[^\]]*\]?/g, '')
      .trim()];
  }).filter(Boolean).join('\n\n').slice(0, 20_000);
}

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema> | z.infer<typeof clarificationAnswerSchema> | z.infer<typeof contextAnswerSchema>, aliases: ReadonlyMap<string, string> = new Map()): FinalizeAnswerInput {
  const input = value.intent === 'clarification' || value.intent === 'rejected' ? clarificationAnswerSchema.parse(value)
    : value.intent === 'context_answer' ? contextAnswerSchema.parse(value) : structuredAnswerSchema.parse(value);
  assertCoherentAnswerBlocks(input);
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    warnings: input.warnings.map(warning => ({ ...warning, code: warning.code === 'ANSWER_SCOPE_SHORTFALL' ? 'PARTIAL_EVIDENCE' : warning.code })),
    citations: [],
    answer: input.blocks.map(block => {
      const declared = new Set(block.evidenceIds);
      const placed = new Set<string>();
      // Inline placement can position only references declared for this block.
      // Persisted evidence validation still owns whether those IDs are valid.
      const text = block.text
        .replace(/【ref_\d+】|\[ref_\d+\]/g, '')
        .replace(/\[cite:([^\]]+)\]|\(source marker:([^\]]+)\]/g, (_marker, inlineId: string | undefined, escapedId: string | undefined) => {
          const rawId = inlineId ?? escapedId!;
          const id = aliases.get(rawId) ?? rawId;
          if (!declared.has(id)) return '[source unavailable]';
          placed.add(id);
          return `[cite:${id}]`;
        });
      const remaining = [...declared].filter(id => !placed.has(id)).map(id => `[cite:${id}]`).join(' ');
      // Appending text to the final table row would create an extra cell.
      const separator = /(?:^|\n)\s*\|.*\|\s*(?:\n|$)/.test(text) ? '\n\nSources: ' : ' ';
      return remaining ? `${text}${separator}${remaining}`.trim() : text.trim();
    }).join('\n\n'),
  });
}

/** Local checks complement the transmitted schema without constraining decoding. */
function assertCoherentAnswerBlocks(input: { blocks: { text: string }[]; warnings: { message: string }[] }) {
  const issues: z.core.$ZodIssue[] = [];
  // Narrow checks for known non-answers, not a minimum answer length. Quotes,
  // names, numbers, yes/no answers and supported partial answers remain valid.
  const texts = input.blocks.map(block => block.text.trim());
  const fragment = /^(?:the|a|an|and|but|because|however|therefore)[,:]?$/i;
  const promise = /^(?:I(?:['’]ll| will| am going to)|Let me) (?:first )?(?:look up|check|search|retrieve|fetch|inspect|read|analy[sz]e)\b[^.!?]*(?:[.!?])?$/i;
  if (texts.every(text => fragment.test(text) || promise.test(text))) {
    issues.push({code:'custom',path:['blocks'],message:'The answer is only a fragment or promise of future work. Answer the request now, or state the concrete missing context. Do not report planned work as completed.'});
  }

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
