import { parsePartialJson } from 'ai';
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

/** Log-only signal. A count mismatch never rejects an answer. */
export function numberedItemsMismatch(output: Pick<z.infer<typeof finalizationOutputSchema>, 'blocks' | 'warnings'>, expected: number | undefined): boolean {
  if (expected === undefined || output.warnings.some(warning => warning.code === 'ANSWER_SCOPE_SHORTFALL')) return false;
  const numbers = new Set([...output.blocks.map(block => block.text).join('\n').matchAll(
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(\d+)[.)][ \t]+/g,
  )].map(match => Number(match[1])));
  return numbers.size !== expected || !Array.from({ length: expected }, (_, index) => index + 1).every(number => numbers.has(number));
}

/** An answer made only of filler or a promise of future work is not an answer. */
export function fillerOnlyAnswer(output: { blocks: { text: string }[] }): boolean {
  const fragment = /^(?:the|a|an|and|but|because|however|therefore)[,:]?$/i;
  const promise = /^(?:I(?:['’]ll| will| am going to)|Let me) (?:first )?(?:look up|check|search|retrieve|fetch|inspect|read|analy[sz]e)\b[^.!?]*(?:[.!?])?$/i;
  return output.blocks.every(block => fragment.test(block.text.trim()) || promise.test(block.text.trim()));
}

/** Keep the complete blocks of an answer cut off at the output-token limit. A block
 * counts as complete only if its own object closed in the raw text. JSON that closes
 * cleanly despite the limit is kept whole and reported, so the case stays measurable. */
export async function salvageTruncatedAnswer<T extends { blocks: unknown[] }>(candidate: string | undefined, schema: z.ZodType<T>): Promise<{ output: T; droppedBlock: boolean; closedCleanly: boolean } | undefined> {
  const { value, state } = await parsePartialJson(candidate);
  if (state !== 'repaired-parse' && state !== 'successful-parse') return undefined;
  if (!value || typeof value !== 'object' || !Array.isArray((value as { blocks?: unknown }).blocks)) return undefined;
  const blocks = (value as { blocks: unknown[] }).blocks;
  const closedCleanly = state === 'successful-parse';
  const keep = closedCleanly ? blocks.length : Math.min(blocks.length, closedBlockCount(candidate!));
  if (keep < 1) return undefined;
  const parsed = schema.safeParse({ ...value, blocks: blocks.slice(0, keep) });
  return parsed.success ? { output: parsed.data, droppedBlock: keep < blocks.length, closedCleanly } : undefined;
}

/** Count entries of the top-level `blocks` array whose objects close in raw JSON text. */
function closedBlockCount(text: string): number {
  const stack: string[] = [];
  let inString = false, escaped = false, token = '', lastKey: string | undefined, blocksDepth = -1, closed = 0;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; if (stack.length === 1) lastKey = token; }
      else token += char;
    } else if (char === '"') { inString = true; token = ''; }
    else if (char === '{' || char === '[') {
      if (char === '[' && stack.length === 1 && lastKey === 'blocks') blocksDepth = 2;
      stack.push(char);
    } else if (char === '}' || char === ']') {
      stack.pop();
      if (char === '}' && stack.length === blocksDepth) closed += 1;
      if (stack.length < blocksDepth) blocksDepth = -1;
    } else if (char === ',' && stack.length === 1) lastKey = undefined;
  }
  return closed;
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

const INLINE_MARKER = /\[cite:([^\]]+)\]|\(source marker:([^\]]+)\]/g;

/** References one inline marker names, after aliasing. Unusable text yields none. */
function markerReferences(raw: string, aliases: ReadonlyMap<string, string>): string[] {
  return raw.split(',').map(part => part.trim()).filter(Boolean)
    .map(part => aliases.get(part) ?? part).filter(id => /^[A-Za-z0-9:_-]{1,300}$/.test(id));
}

/** Every reference a block's rendered citations come from: declared and inline. The
 * figure and coverage checks use this same set, so they judge what the reader sees. */
export function blockReferences(block: { text: string; evidenceIds: readonly string[] }, aliases: ReadonlyMap<string, string> = new Map()): string[] {
  const inline = [...block.text.matchAll(INLINE_MARKER)].flatMap(([, inlineId, escapedId]) => markerReferences((inlineId ?? escapedId)!, aliases));
  return [...new Set([...block.evidenceIds.map(id => aliases.get(id) ?? id), ...inline])];
}

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema> | z.infer<typeof clarificationAnswerSchema> | z.infer<typeof contextAnswerSchema>, aliases: ReadonlyMap<string, string> = new Map()): FinalizeAnswerInput {
  const input = value.intent === 'clarification' || value.intent === 'rejected' ? clarificationAnswerSchema.parse(value)
    : value.intent === 'context_answer' ? contextAnswerSchema.parse(value) : structuredAnswerSchema.parse(value);
  // Not an answer at all: the one content check that still earns a repair.
  if (fillerOnlyAnswer(input)) throw new z.ZodError([{ code: 'custom', path: ['blocks'],
    message: 'The answer is only a fragment or promise of future work. Answer the request now, or state the concrete missing context. Do not report planned work as completed.' }]);
  const answer = input.blocks.map(block => {
    const declared = new Set(block.evidenceIds);
    const placed = new Set<string>();
    // Inline references stay where the model placed them, even when the block did not
    // declare them; persisted evidence validation decides whether each one resolves.
    // A marker with no usable reference is shown as unavailable rather than dropped.
    const text = block.text
      .replace(/【ref_\d+】|\[ref_\d+\]/g, '')
      .replace(INLINE_MARKER, (_marker, inlineId: string | undefined, escapedId: string | undefined) => {
        const ids = markerReferences((inlineId ?? escapedId)!, aliases);
        if (!ids.length) return '[source unavailable]';
        for (const id of ids) placed.add(id);
        return ids.map(id => `[cite:${id}]`).join(' ');
      });
    const remaining = [...declared].filter(id => !placed.has(id)).map(id => `[cite:${id}]`).join(' ');
    // Appending text to the final table row would create an extra cell.
    const separator = /(?:^|\n)\s*\|.*\|\s*(?:\n|$)/.test(text) ? '\n\nSources: ' : ' ';
    return remaining ? `${text}${separator}${remaining}`.trim() : text.trim();
  }).join('\n\n');
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    warnings: input.warnings.map(warning => ({ ...warning, code: warning.code === 'ANSWER_SCOPE_SHORTFALL' ? 'PARTIAL_EVIDENCE' : warning.code })),
    citations: [],
    answer,
  });
}
