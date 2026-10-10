import { createHash } from 'node:crypto';
import { z } from 'zod';
import { usableTranscriptSegment as productionUsableTranscriptSegment } from '../../src/agents/runtime/transcript-segments';

export const usableTranscriptSegment = (text: string) => productionUsableTranscriptSegment(text) && text.trim().length > 0;

export const FORMAT = 'source-linked-overview-v1' as const;
const segmentSchema = z.object({ text: z.string(), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative() })
  .refine(s => s.endMs >= s.startMs, 'Caption ends before it starts');
export const transcriptSchema = z.object({ videoId: z.string().regex(/^[\w-]{11}$/), segments: z.array(segmentSchema).min(1).max(40_000) });
export type Transcript = z.infer<typeof transcriptSchema>;
export type Passage = { id: string; start: number; end: number };
const noteSchema = z.object({ title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(2_000), anchorSegment: z.number().int().nonnegative() });
export const cardsOutputSchema = z.object({ cards: z.array(noteSchema.extend({ id: z.string(), anchorQuote: z.string().min(1).max(16_000) })).min(1).max(12) });
export const lessonsOutputSchema = z.object({ lessons: z.array(noteSchema).min(1).max(3) });
const cardSchema = cardsOutputSchema.shape.cards.element.extend({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });
export const indexSchema = z.object({
  format: z.literal(FORMAT), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), videoId: z.string(), model: z.string().min(1),
  excludedSegments: z.array(z.number().int().nonnegative()),
  cards: z.array(cardSchema).min(1).max(1_024),
  lessons: z.array(noteSchema.extend({ portion: z.number().int().min(0).max(5) })).min(1).max(18),
});
export type OverviewIndex = z.infer<typeof indexSchema>;
export type Card = OverviewIndex['cards'][number];
export type Generate = <T>(request: { stage: string; instructions: string; data: unknown; schema: z.ZodType<T>; maxOutputTokens: number }) => Promise<T>;
const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
export const sourceHash = (transcript: Transcript) => createHash('sha256').update(JSON.stringify(transcriptSchema.parse(transcript))).digest('hex');
export const flat = (transcript: Transcript, ids: readonly number[]) => ids.map(id => `${id} ${transcript.segments[id]!.text.replace(/[\r\n]+/gu, ' ')}`).join('\n');
const range = (start: number, end: number) => Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);

/** Whole captions, sentence boundary after 100 tokens, otherwise flush at 160.
 * Empty/oversized captions remain at their original IDs and break passages. */
export function passages(transcript: Transcript, countTokens: (text: string) => number): Passage[] {
  const result: Passage[] = [];
  let ids: number[] = [];
  const flush = () => {
    if (ids.length) result.push({ id: `N${result.length}`, start: ids[0]!, end: ids.at(-1)! });
    ids = [];
  };
  transcript.segments.forEach((segment, id) => {
    if (!usableTranscriptSegment(segment.text)) { flush(); return; }
    ids.push(id);
    const tokens = countTokens(ids.map(i => transcript.segments[i]!.text).join(' '));
    if ((tokens >= 100 && /[.!?]$/u.test(segment.text.trimEnd())) || tokens >= 160) flush();
  });
  flush();
  if (!result.length || result.length > 1_024) throw new Error('Experimental index requires 1 to 1024 usable passages.');
  return result;
}

function contextStart(transcript: Transcript, passage: Passage) {
  let start = passage.start;
  while (start > Math.max(0, passage.start - 8) && usableTranscriptSegment(transcript.segments[start - 1]!.text)) start--;
  return start;
}

export function validateCards(transcript: Transcript, batch: Passage[], output: z.infer<typeof cardsOutputSchema>): Card[] {
  const parsed = cardsOutputSchema.parse(output);
  if (parsed.cards.length !== batch.length || new Set(parsed.cards.map(c => c.id)).size !== batch.length) throw new Error('Missing or duplicate source card.');
  return batch.map(passage => {
    const card = parsed.cards.find(c => c.id === passage.id);
    if (!card || card.anchorSegment < contextStart(transcript, passage) || card.anchorSegment > passage.end) throw new Error(`Card anchor outside its source neighborhood: ${passage.id} chose ${card?.anchorSegment}; allowed ${contextStart(transcript, passage)} through ${passage.end}, inclusive.`);
    const exact = transcript.segments[card.anchorSegment]!.text;
    const quoted = card.anchorQuote.startsWith(`${card.anchorSegment} `) ? card.anchorQuote.slice(String(card.anchorSegment).length + 1) : card.anchorQuote;
    // A model sometimes copies several consecutive captions. Accept that exact
    // prefix only if it contains the complete first caption; always store just
    // the canonical first caption. No fuzzy matching or partial word support.
    const source = normalize(transcript.segments.slice(card.anchorSegment, passage.end + 1).map(s => s.text).join(' '));
    const quote = normalize(quoted);
    const first = normalize(exact);
    if (!(quote === first || (quote.startsWith(first + ' ') && source.startsWith(quote)))) throw new Error(`Card quote does not match its complete anchor caption: ${passage.id}, segment ${card.anchorSegment}. Copy the full original caption at that ID.`);
    return { ...card, ...passage, anchorQuote: exact };
  });
}

export function portions(cards: Card[]): Card[][] {
  const size = Math.ceil(cards.length / 6);
  return Array.from({ length: Math.ceil(cards.length / size) }, (_, i) => cards.slice(i * size, (i + 1) * size));
}
export function validateLessons(part: Card[], output: z.infer<typeof lessonsOutputSchema>) {
  const { lessons } = lessonsOutputSchema.parse(output);
  if (lessons.length !== Math.min(3, part.length)) throw new Error('Missing chronological coverage slot.');
  const anchors = new Set(part.map(c => c.anchorSegment));
  if (lessons.some(l => !anchors.has(l.anchorSegment))) throw new Error('Outline anchor belongs to another portion or is invented.');
  return lessons;
}

async function generateValidated<T, R>(input: { generate: Generate; signal: AbortSignal }, request: Parameters<Generate>[0] & { schema: z.ZodType<T> }, validate: (value: T) => R): Promise<R> {
  const output = await input.generate(request);
  input.signal.throwIfAborted();
  try { return validate(output); }
  catch (error) {
    const repaired = await input.generate({ ...request, stage: `${request.stage}-repair`,
      instructions: request.instructions + '\nRepair the rejected output. Every card anchor must be inside THAT card’s allowedAnchorRange; outline anchors must belong to this portion. Preserve source coverage. Return the complete corrected output.',
      data: { source: request.data, rejectedOutput: output, validationError: error instanceof Error ? error.message : 'Invalid source reference' },
    });
    input.signal.throwIfAborted();
    return validate(repaired);
  }
}

export async function buildIndex(input: { transcript: Transcript; model: string; countTokens: (text: string) => number; generate: Generate; signal: AbortSignal }): Promise<OverviewIndex> {
  const transcript = transcriptSchema.parse(input.transcript);
  const leaves = passages(transcript, input.countTokens);
  const cards: Card[] = [];
  for (let offset = 0; offset < leaves.length; offset += 12) {
    input.signal.throwIfAborted();
    const batch = leaves.slice(offset, offset + 12);
    const request = { stage: `cards-${offset}`, schema: cardsOutputSchema, maxOutputTokens: 5_000,
      instructions: 'Create one source-linked card for EACH supplied passage. Preserve its specific teaching point, exercise, qualifications, and whether material is merely promised elsewhere. Do not merge passages. Summary at most 40 words. Choose anchorSegment as the earliest caption in the passage or preceding context introducing THIS specific explanation, never an earlier unrelated exercise. Copy the complete caption at that ID into anchorQuote, without the numeric prefix. Preceding context locates introductions; summarize the passage itself. Use only supplied facts. IDs indicate order, not time.',
      data: batch.map(p => ({ id: p.id, allowedAnchorRange: { first: contextStart(transcript, p), last: p.end }, precedingContext: flat(transcript, range(contextStart(transcript, p), p.start - 1)), passage: flat(transcript, range(p.start, p.end)) })),
    };
    const output = await input.generate(request);
    input.signal.throwIfAborted();
    // Repair only rejected passages. Hiding unrelated cards prevents the model
    // from borrowing a more attractive introduction elsewhere in the batch.
    const accepted: Card[] = [];
    const rejected = batch.filter(passage => {
      try {
        const candidates = output.cards.filter(card => card.id === passage.id);
        accepted.push(...validateCards(transcript, [passage], { cards: candidates }));
        return false;
      } catch { return true; }
    });
    if (output.cards.some(card => !batch.some(p => p.id === card.id))) throw new Error('Invented source card.');
    if (rejected.length) {
      const repaired = await input.generate({ ...request, stage: `${request.stage}-repair`,
        instructions: request.instructions + '\nThe prior anchors for these passages were invalid. Return ONLY these cards. Choose an anchor inside EACH card’s allowedAnchorRange. If its earlier introduction is outside that range, choose the first supplied caption explaining this passage. Copy that complete caption as anchorQuote.',
        data: request.data.filter(data => rejected.some(p => p.id === data.id)),
      });
      input.signal.throwIfAborted();
      accepted.push(...validateCards(transcript, rejected, repaired));
    }
    cards.push(...batch.map(p => accepted.find(card => card.id === p.id)!));
  }
  const lessons: OverviewIndex['lessons'] = [];
  for (const [portion, part] of portions(cards).entries()) {
    input.signal.throwIfAborted();
    const request = { stage: `outline-${portion}`, schema: lessonsOutputSchema, maxOutputTokens: 2_400,
      instructions: `Summarize this chronological portion into exactly ${Math.min(3, part.length)} principal lessons for a whole-video outline. Cover its beginning, middle and ending, merging subordinate details. Preserve distinct exercises separately. Distinguish promises from actual instruction. Each summary up to 90 words. Copy anchorSegment from the source card where THAT lesson begins. Use only supplied facts and anchor IDs. Do not borrow another lesson's introduction. No user question is supplied.`,
      data: part.map(({ title, summary, anchorSegment }) => ({ title, summary, anchorSegment })),
    };
    lessons.push(...(await generateValidated(input, request, output => validateLessons(part, output))).map(l => ({ ...l, portion })));
  }
  return indexSchema.parse({ format: FORMAT, sourceHash: sourceHash(transcript), videoId: transcript.videoId, model: input.model, cards, lessons,
    excludedSegments: transcript.segments.flatMap((s, id) => usableTranscriptSegment(s.text) ? [] : [id]) });
}

/** Revalidate persisted artifacts against immutable source and deterministic partitions. */
export function validateIndex(value: unknown, transcript: Transcript, countTokens: (text: string) => number): OverviewIndex {
  const index = indexSchema.parse(value);
  if (index.sourceHash !== sourceHash(transcript) || index.videoId !== transcript.videoId) throw new Error('Index belongs to another transcript version.');
  const leaves = passages(transcript, countTokens);
  if (index.cards.length !== leaves.length) throw new Error('Incomplete source coverage.');
  for (let i = 0; i < leaves.length; i += 12) {
    const selected = index.cards.slice(i, i + 12);
    const expected = validateCards(transcript, leaves.slice(i, i + 12), { cards: selected });
    if (selected.some((c, j) => c.id !== expected[j]!.id || c.start !== expected[j]!.start || c.end !== expected[j]!.end)) throw new Error('Source ranges changed.');
  }
  const groups = portions(index.cards);
  if (index.lessons.length !== groups.reduce((n, p) => n + Math.min(3, p.length), 0)) throw new Error('Incomplete outline coverage.');
  groups.forEach((part, portion) => validateLessons(part, { lessons: index.lessons.filter(l => l.portion === portion) }));
  const excluded = transcript.segments.flatMap((s, id) => usableTranscriptSegment(s.text) ? [] : [id]);
  if (JSON.stringify(excluded) !== JSON.stringify(index.excludedSegments)) throw new Error('Incorrect omitted-caption record.');
  return index;
}

export function retrieveOverview(index: OverviewIndex, transcript: Transcript, mode: 'overview' | 'cards' = 'overview') {
  if (index.sourceHash !== sourceHash(transcript)) throw new Error('Stale transcript index.');
  const notes = mode === 'overview' ? index.lessons : index.cards;
  const selected = new Set<number>();
  for (const note of notes) for (let id = note.anchorSegment; id < Math.min(transcript.segments.length, note.anchorSegment + (mode === 'overview' ? 10 : 4)); id++) {
    if (!usableTranscriptSegment(transcript.segments[id]!.text)) break;
    selected.add(id);
  }
  return {
    videoId: transcript.videoId, sourceHash: index.sourceHash, mode,
    summaries: notes.map(({ title, summary, anchorSegment }) => ({ title, summary, anchorSegment })),
    transcript: flat(transcript, [...selected].sort((a, b) => a - b)),
    // Only anchors are selectable for navigation; neighboring captions supply context.
    allowedAnchors: [...new Set(notes.map(n => n.anchorSegment))],
    selectedSegments: [...selected].sort((a, b) => a - b), excludedSegments: index.excludedSegments,
  };
}

export const answerSchema = z.object({ blocks: z.array(z.object({ text: z.string().trim().min(1).max(8_000), segmentId: z.number().int().nonnegative() })).min(1).max(20) });
export function resolveAnswer(output: unknown, transcript: Transcript, allowedAnchors: readonly number[], expectedAnchors: readonly number[] = []) {
  const answer = answerSchema.parse(output);
  const allowed = new Set(allowedAnchors);
  if (answer.blocks.some(b => !allowed.has(b.segmentId) || !transcript.segments[b.segmentId] || !usableTranscriptSegment(transcript.segments[b.segmentId]!.text))) throw new Error('Answer cites an unavailable starting segment.');
  return {
    blocks: answer.blocks.map(b => ({ ...b, citation: { ...transcript.segments[b.segmentId]!,
      url: `https://www.youtube.com/watch?v=${transcript.videoId}&t=${Math.floor(transcript.segments[b.segmentId]!.startMs / 1000)}` } })),
    unrepresentedAnchors: [...new Set(expectedAnchors)].filter(id => !answer.blocks.some(b => b.segmentId === id)),
  };
}
