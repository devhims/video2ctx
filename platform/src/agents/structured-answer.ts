import { endsInCodeBlock, mapCitationProse, trimCitationProse } from './markdown-citations';
import { parsePartialJson } from 'ai';
import { z } from 'zod';
import { finalizeAnswerInputSchema, type FinalizeAnswerInput } from './contracts';

/** Model-facing only. Persisted and public answers retain their existing format. */
const fields = finalizeAnswerInputSchema.omit({ answer: true, citations: true, intent: true }).extend({
  warnings: z.array(z.object({
    code: z.enum(['SOURCE_CAVEAT', 'ANSWER_SCOPE_SHORTFALL']).describe('SOURCE_CAVEAT: limitations of sources, such as unverified demos. ANSWER_SCOPE_SHORTFALL: a specific requested item, count, or question could not be answered. Source uncertainty alone is not an unmet request.'),
    message: z.string().min(1).max(1_000),
    unansweredPart: z.string().max(400).optional().describe('Required to mark ANSWER_SCOPE_SHORTFALL as partial: identify the specific requested item, count, or question that this answer leaves unanswered. Do not list a source limitation or an extra requirement the user did not ask for. Omit for SOURCE_CAVEAT. Without a nonblank unansweredPart the warning remains a source caveat.'),
  })).max(3).default([]).describe('At most three distinct, material limitations. The application already returns warnings from the evidence packets. Do not repeat inherited warnings, summarize the answer, or discuss generating the response.'),
});
export const ANSWER_CITATION_GUIDANCE = 'Place [cite:ref_N] beside the claim it supports in prose, or in Markdown table Source cells. Use only supplied evidence IDs, and include every cited ID in the block evidenceIds array. Related claims with different sources can share one natural paragraph, with a citation beside each claim. For example: "The query stays live [cite:ref_1]. Moving a card updates other users [cite:ref_2]." Use that example only when supported by the supplied evidence, with evidenceIds ["ref_1", "ref_2"]. List each ID separately in evidenceIds, without ranges or duplicates. Never write reference ranges or bare aliases as citations. The application renders inline markers as source links and appends any evidenceIds not placed inline.';
const block = z.object({
  // The SDK bounds generation tokens and the rendered contract bounds total
  // characters. A decoding limit on each paragraph can split words at its edge.
  text: z.string().min(1).regex(/\S/, 'A block must contain non-whitespace text.').describe(`One complete paragraph, list item, or Markdown table. Finish the table within this block. End prose at a natural sentence boundary; never continue a sentence in the next block. ${ANSWER_CITATION_GUIDANCE}`),
  evidenceIds: z.array(z.string().regex(/^[A-Za-z0-9:_-]+$/).max(300)).min(1).max(12).describe('Individual supplied evidence IDs supporting this block. List each ID separately, without ranges or duplicates. The application renders these as citations.'),
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
    evidenceIds: z.array(block.shape.evidenceIds.element).max(12).describe('List individual supplied evidence IDs for video facts, without ranges or duplicates. The application renders these as citations. Use no evidence IDs only when discussing prior conversation statements, without treating them as verified video facts.'),
  })).min(1).max(20),
});

// The classifier owns intent; persisted evidence owns artifacts and citations.
export const finalizationOutputSchema = structuredAnswerSchema.omit({ intent: true, artifacts: true });
export const contextFinalizationOutputSchema = contextAnswerSchema.omit({ intent: true, artifacts: true });
export const conversationalFinalizationOutputSchema = clarificationAnswerSchema.omit({ intent: true, artifacts: true });
export const FINALIZATION_SCHEMA_VERSION = 'answer-blocks-v5';

/** Log-only signal. A count mismatch never rejects an answer. */
export function numberedItemsMismatch(output: Pick<z.infer<typeof finalizationOutputSchema>, 'blocks' | 'warnings'>, expected: number | undefined): boolean {
  if (expected === undefined || output.warnings.some(warning => warning.code === 'ANSWER_SCOPE_SHORTFALL' && warning.unansweredPart?.trim())) return false;
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
    return [trimCitationProse(mapCitationProse(block.text, prose => prose
      .replace(/【\s*ref_[^】\n]*(?:】|$)|\[\s*ref_[^\]\n]*(?:\]|$)/g, '')
      .replace(/\[cite:[^\]]*\]?/g, '')
      .replace(/\(source marker:[^\]]*\]?/g, ''), true), true)];
  }).filter(Boolean).join('\n\n').slice(0, 20_000);
}

/** Legacy bracketed aliases use the same literal/link protection as the range pass.
 * Scan the whole block so quotes and calls spanning Markdown chunks stay protected. */
function normalizeBareReferences(text: string): string {
  const prose: Array<[number, number]> = [];
  mapCitationProse(text, (chunk, from, to) => { prose.push([from, to]); return chunk; }, false, LINK_NODES);
  const literals = literalSpans(text, prose);
  return mapCitationProse(text, (chunk, proseStart) => chunk.replace(
    /\[\s*(ref_\d+(?:\s*,\s*ref_\d+)*)\s*\]|【\s*(ref_\d+(?:\s*,\s*ref_\d+)*)\s*】/g,
    (marker: string, square: string | undefined, wide: string | undefined, offset: number) => {
      const start = proseStart + offset;
      if (literals.some(([from, to]) => start < to && start + marker.length > from)) return marker;
      return `[cite:${square ?? wide}]`;
    }), false, LINK_NODES);
}

const ALIAS = String.raw`ref_\d+`;
const RANGE_SEPARATOR = String.raw`(?:-|–|—|\bto\b|\bthrough\b|\bthru\b)`;
const ALIAS_ITEM = String.raw`${ALIAS}(?:\s*${RANGE_SEPARATOR}\s*(?:ref_)?\d+)?`;
const ALIAS_LIST = String.raw`${ALIAS_ITEM}(?:\s*,\s*${ALIAS_ITEM})*`;
const ALIAS_RANGE = new RegExp(String.raw`^ref_(\d+)\s*${RANGE_SEPARATOR}\s*(?:ref_)?(\d+)$`);
// A bare alias must stand alone: not part of an identifier, path, URL or quotation.
const ALIAS_BEFORE = String.raw`(?<![\w\-./:=#?&%@~+$\\\[【'"‘“\`])`;
const ALIAS_AFTER = String.raw`(?![\w\-/:(\]】'"’”\`]|\.\w)`;
// Consume a range as one item before its endpoints can match separately. Bracketed
// lists are checked as a whole, including lists mixing ranges and individual aliases.
const MODEL_REFERENCES = new RegExp([
  String.raw`\[cite:[^\]]*\]|\(source marker:[^\]]*\]`,
  String.raw`\[\s*(?<square>${ALIAS_LIST})\s*\]|【\s*(?<wide>${ALIAS_LIST})\s*】`,
  // A group directly after "]" is a link destination, not a citation.
  String.raw`(?<linked>\])?\(\s*(?<group>${ALIAS_LIST})\s*\)`,
  String.raw`${ALIAS_BEFORE}(?<bare>${ALIAS_ITEM})${ALIAS_AFTER}`,
].join('|'), 'g');

/** Expand only complete, ascending ranges of supplied aliases. Bound work by the
 * actual alias map before iterating, even for enormous model-written endpoints. */
function expandAliasList(listed: string, aliases: ReadonlyMap<string, string>): string[] | undefined {
  const resolved = new Set<string>();
  for (const item of listed.split(',').map(part => part.trim())) {
    const range = ALIAS_RANGE.exec(item);
    if (!range) {
      if (!aliases.has(item)) return undefined;
      resolved.add(item);
      continue;
    }
    const first = Number(range[1]), last = Number(range[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last
      || last - first + 1 > aliases.size) return undefined;
    // Alias numbers are canonical decimal integers, never padded identifiers.
    if (String(first) !== range[1] || String(last) !== range[2]) return undefined;
    for (let number = first; number <= last; number += 1) {
      const alias = `ref_${number}`;
      if (!aliases.has(alias)) return undefined;
      resolved.add(alias);
    }
  }
  return [...resolved];
}
// Links, images and definitions are copied unchanged, so no citation lands inside a label or URL.
const LINK_NODES = ['link', 'linkReference', 'image', 'imageReference', 'definition'] as const;

/** Text an alias form must not touch: bare URLs up to the next whitespace, and call-like text such
 * as fn(value, ref_1), outer(inner(ref_1)) or a call split across lines, from the name to its
 * matching parenthesis. Parentheses inside quoted strings, and escaped characters there, do not
 * count. Calls start only in prose. Scan the whole block, not each prose chunk, so inline code
 * or a line break inside a call cannot end it early. */
function literalSpans(text: string, prose: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const urls = [...text.matchAll(/(?:\b[A-Za-z][A-Za-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/g)]
    .map((match): [number, number] => [match.index!, match.index! + match[0].length]);
  // Quotes describe literal text. Do not turn their contents into evidence links.
  // Apostrophes within words do not open a quotation.
  const quotes = [...text.matchAll(/(?<![\p{L}\p{N}_\\])(?:"(?:\\.|[^"\\\n])*"|“[^”\n]*”|'(?:\\.|[^'\\\n])*'|‘[^’\n]*’)/gu)]
    .map((match): [number, number] => [match.index!, match.index! + match[0].length]);
  const calls: Array<[number, number]> = [];
  for (const match of text.matchAll(/[A-Za-z_$][\w$.]*\(/g)) {
    const start = match.index!;
    // A call starts in prose. Text inside code or a link is already preserved.
    if (start < (calls.at(-1)?.[1] ?? 0) || !prose.some(([from, to]) => start >= from && start < to)) continue;
    let depth = 0;
    let quote = '';
    // An unclosed call ends at the next blank line, so it cannot hide later paragraphs.
    const paragraphEnd = text.slice(start).search(/\n[ \t]*\n/);
    const limit = paragraphEnd < 0 ? text.length : start + paragraphEnd;
    let end = limit;
    for (let index = start + match[0].length - 1; index < limit; index += 1) {
      const char = text[index]!;
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
        // Quoted strings end at a line break, except template strings, so a stray apostrophe
        // inside a call cannot hide its closing parenthesis on a later line.
        else if (char === '\n' && quote !== '`') quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) { end = index + 1; break; }
    }
    calls.push([start, end]);
  }
  return [...urls, ...quotes, ...calls];
}

/** Resolve parenthesized groups and bare aliases only when every alias names supplied evidence.
 * Ranges include both endpoints and every supplied alias between them. Incomplete or
 * reversed ranges, unknown groups, URLs, quoted literals, calls and links stay as written. */
function resolveAliasForms(text: string, aliases: ReadonlyMap<string, string>): string {
  if (!aliases.size) return text;
  const prose: Array<[number, number]> = [];
  mapCitationProse(text, (chunk, from, to) => { prose.push([from, to]); return chunk; }, false, LINK_NODES);
  const literals = literalSpans(text, prose);
  return mapCitationProse(text, (chunk, proseStart) => {
    return chunk.replace(MODEL_REFERENCES, (marker: string, ...args: unknown[]) => {
      const groups = args.at(-1) as Record<string, string | undefined>;
      const offset = args.at(-3) as number;
      const listed = groups.square ?? groups.wide ?? groups.group ?? groups.bare;
      const start = proseStart + offset;
      if (!listed || groups.linked || literals.some(([from, to]) => start < to && start + marker.length > from)) return marker;
      const expanded = expandAliasList(listed, aliases);
      return expanded ? `[cite:${expanded.join(',')}]` : marker;
    });
  }, false, LINK_NODES);
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
  const inline: string[] = [];
  mapCitationProse(normalizeBareReferences(resolveAliasForms(block.text, aliases)), prose => {
    inline.push(...[...prose.matchAll(INLINE_MARKER)]
      .flatMap(([, inlineId, escapedId]) => markerReferences((inlineId ?? escapedId)!, aliases)));
    return prose;
  });
  return [...new Set([...block.evidenceIds.map(id => aliases.get(id) ?? id), ...inline])];
}

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema> | z.infer<typeof clarificationAnswerSchema> | z.infer<typeof contextAnswerSchema>, aliases: ReadonlyMap<string, string> = new Map(),
  validateRenderedBlocks?: (blocks: Array<{ text: string }>) => void): FinalizeAnswerInput {
  const input = value.intent === 'clarification' || value.intent === 'rejected' ? clarificationAnswerSchema.parse(value)
    : value.intent === 'context_answer' ? contextAnswerSchema.parse(value) : structuredAnswerSchema.parse(value);
  // Not an answer at all: the one content check that still earns a repair.
  if (fillerOnlyAnswer(input)) throw new z.ZodError([{ code: 'custom', path: ['blocks'],
    message: 'The answer is only a fragment or promise of future work. Answer the request now, or state the concrete missing context. Do not report planned work as completed.' }]);
  const renderedBlocks = input.blocks.map(block => {
    const declared = new Set(block.evidenceIds.map(id => aliases.get(id) ?? id));
    const placed = new Set<string>();
    // Inline references stay where the model placed them, even when the block did not
    // declare them; persisted evidence validation decides whether each one resolves.
    // A marker with no usable reference is shown as unavailable rather than dropped.
    const text = mapCitationProse(normalizeBareReferences(resolveAliasForms(block.text, aliases)), prose => prose
      .replace(INLINE_MARKER, (_marker, inlineId: string | undefined, escapedId: string | undefined) => {
        const ids = markerReferences((inlineId ?? escapedId)!, aliases);
        if (!ids.length) return '[source unavailable]';
        for (const id of ids) placed.add(id);
        return ids.map(id => `[cite:${id}]`).join(' ');
      }));
    const remaining = [...declared].filter(id => !placed.has(id)).map(id => `[cite:${id}]`).join(' ');
    // Appending text to the final table row would create an extra cell.
    if (remaining && endsInCodeBlock(text)) {
      // Keep citations inside a numbered point, before its code, rather than
      // introducing an unnumbered Sources paragraph ahead of the whole answer.
      if (/^\d+[.)][ \t]+/.test(text)) return text.replace(/^[^\n]+/, line => `${line} ${remaining}`);
      return `Sources: ${remaining}\n\n${text}`;
    }
    const separator = /(?:^|\n)\s*\|.*\|\s*(?:\n|$)/.test(text) ? '\n\nSources: ' : ' ';
    return trimCitationProse(remaining ? `${text}${separator}${remaining}` : text);
  });
  validateRenderedBlocks?.(renderedBlocks.map(text => ({ text })));
  const answer = renderedBlocks.join('\n\n');
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    // A model's category alone is not evidence of an unmet request. Keep the
    // caveat, but only promote a separately identified unanswered part to partial.
    // Application-generated coverage/failure warnings are added outside this path.
    warnings: input.warnings.map(warning => {
      const unansweredPart = warning.unansweredPart?.trim();
      return warning.code === 'ANSWER_SCOPE_SHORTFALL' && unansweredPart
        ? { code: 'PARTIAL_EVIDENCE', message: `Unanswered request: ${unansweredPart}. ${warning.message}`.slice(0, 1_000) }
        : { code: 'SOURCE_CAVEAT', message: warning.message };
    }),
    citations: [],
    answer,
  });
}
