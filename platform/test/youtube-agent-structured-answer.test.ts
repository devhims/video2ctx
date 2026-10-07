import { z } from 'zod';
import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { renderPartialAnswer, renderStructuredAnswer, structuredAnswerSchema, finalizationOutputSchema, clarificationAnswerSchema, numberedItemsMismatch, fillerOnlyAnswer, salvageTruncatedAnswer } from '../src/agents/structured-answer';
import { compactAgentResult } from '../src/agents/response';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { EvidencePacket } from '../src/agents/contracts';

const packet: EvidencePacket = {
  packetId: 'packet:1', kind: 'youtube_transcript',
  sources: [{ id: 'source:1', provider: 'youtube', kind: 'transcript' }],
  excerpts: [{ id: 'e1', sourceId: 'source:1', text: 'Original transcript.', startMs: 1000, endMs: 2000 }],
  artifacts: [], warnings: [], usage: [],
};
const base = { intent: 'inspect_video' as const, confidence: 'medium' as const, artifacts: [], warnings: [] };
function finalize(evidenceIds: string[], text = 'Supported finding without manually written citations.') {
  return buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
  { userId: 'test', creditsRemaining: 10 },
  renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds }] }), [packet], 1);
}
describe('structured answer citations', () => {
  it('keeps validated row citations inside a comparison table without leaking evidence IDs', () => {
    const table='| Test | Result | Source |\n| --- | --- | --- |\n| Coding | Supported result | [cite:ref_1] |';
    const input=renderStructuredAnswer({...base,blocks:[{text:table,evidenceIds:['e1']}]},new Map([['ref_1','e1']]));
    const result=buildAgentTurnResult({runId:crypto.randomUUID(),conversationId:crypto.randomUUID(),userMessageId:crypto.randomUUID(),agentMessageId:crypto.randomUUID()},
      {userId:'test',creditsRemaining:10},input,[packet],1);
    const compact=compactAgentResult(result);
    expect(compact.answer).toBe(table.replace('[cite:ref_1]','[1]'));
    expect(compact.sources).toHaveLength(1);
    expect(compact.answer).not.toContain('source marker:');
  });
  it('places remaining table references below the table instead of adding a trailing cell', () => {
    const table='| Test | Result |\n| --- | --- |\n| Coding | Supported result |';
    expect(renderStructuredAnswer({...base,blocks:[{text:table,evidenceIds:['e1']}]}).answer)
      .toBe(`${table}\n\nSources: [cite:e1]`);
  });
  it.each(['[cite:e1]', '[cite:ref_1]', '(source marker:ref_1]'])('QA 012: preserves a declared reference in a bullet: %s', marker => {
    expect(renderStructuredAnswer({ ...base, blocks: [
      { text: `- A supported observation. ${marker}`, evidenceIds: ['e1'] },
    ] }, new Map([['ref_1', 'e1']])).answer).toBe('- A supported observation. [cite:e1]');
  });
  it('keeps an undeclared inline reference in place for persistence to verify', () => {
    const table='| Test | Source |\n| --- | --- |\n| Coding | [cite:ref_2] |';
    expect(renderStructuredAnswer({...base,blocks:[{text:table,evidenceIds:['e1']}]},new Map([['ref_2','e2']])).answer)
      .toBe('| Test | Source |\n| --- | --- |\n| Coding | [cite:e2] |\n\nSources: [cite:e1]');
  });
  it.each(['[cite:ref_2]', '(source marker:ref_2]'])('keeps a reference another block declares where the model placed it: %s', marker => {
    expect(renderStructuredAnswer({ ...base, blocks: [
      { text: `First source ${marker}.`, evidenceIds: ['e1'] },
      { text: 'Second source.', evidenceIds: ['e2'] },
    ] }, new Map([['ref_2', 'e2']])).answer).toBe('First source [cite:e2]. [cite:e1]\n\nSecond source. [cite:e2]');
  });
  it('marks a marker with no usable reference as unavailable without echoing its text', () => {
    const answer = renderStructuredAnswer({ ...base, blocks: [
      { text: 'A supported first block.', evidenceIds: ['e1'] },
      { text: 'Another claim [cite:untrusted marker payload].', evidenceIds: ['e1'] },
    ] }).answer;
    expect(answer).toBe('A supported first block. [cite:e1]\n\nAnother claim [source unavailable]. [cite:e1]');
    expect(answer).not.toContain('untrusted marker payload');
  });
  it.each([
    ['[cite:ref_1, ref_2]', 'Claim [cite:e1] [cite:e2].'],
    ['[cite: ref_1]', 'Claim [cite:e1]. [cite:e2]'],
  ])('splits a marker holding several references: %s', (marker, expected) => {
    expect(renderStructuredAnswer({ ...base, blocks: [{ text: `Claim ${marker}.`, evidenceIds: ['e1', 'e2'] }] },
      new Map([['ref_1', 'e1'], ['ref_2', 'e2']])).answer).toBe(expected);
  });
  it.each(['The', "I'll look up the transcript."])('rejects a filler-only answer for one repair: %s', text => {
    expect(() => renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds: ['e1'] }] })).toThrow(/fragment or promise/);
  });
  it('renders bounded provisional text without model-written source markers', () => {
    expect(renderPartialAnswer({ blocks: [
      { text: 'First draft [cite:ref_1]' },
      { text: 'Second draft 【ref_2】(source marker:evidence:private:ref_3]' },
    ] })).toBe('First draft\n\nSecond draft');
    expect(renderPartialAnswer({ blocks: [{ text: 'x'.repeat(25_000) }] })).toHaveLength(20_000);
  });
  it('reports a numbered-item mismatch as a signal without rejecting the answer', () => {
    const output = finalizationOutputSchema.parse({ confidence: 'medium', warnings: [],
      blocks: [{ text: '1. A single item that ends', evidenceIds: ['e1'] }] });
    expect(numberedItemsMismatch(output, 10)).toBe(true);
    const complete = { ...output, blocks: Array.from({ length: 10 }, (_, i) => ({
      text: `### ${i + 1}. Complete supported item.`, evidenceIds: ['e1'],
    })) };
    expect(numberedItemsMismatch(complete, 10)).toBe(false);
    expect(numberedItemsMismatch({ ...output, warnings: [{
      code: 'ANSWER_SCOPE_SHORTFALL', message: 'Only one item is supported by the available evidence.',
    }] }, 10)).toBe(false);
  });
  it('flags filler-only answers as a signal', () => {
    expect(fillerOnlyAnswer({ blocks: [{ text: "I'll look up the transcript." }] })).toBe(true);
    expect(fillerOnlyAnswer({ blocks: [{ text: 'The' }, { text: 'No.' }] })).toBe(false);
  });
  it('allows a complete long paragraph without forcing a citation into a word at 2000 characters', () => {
    const text = 'A complete supported sentence. '.repeat(75).trim();
    expect(renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds: ['e1'] }] }).answer)
      .toBe(`${text} [cite:e1]`);
    expect(z.toJSONSchema(finalizationOutputSchema).properties?.blocks).not.toMatchObject({
      items: { properties: { text: { maxLength: 2000 } } },
    });
  });

  it('keeps headings and blocks that start with a lowercase name', () => {
    expect(renderStructuredAnswer({ ...base, blocks: [
      { text: '## Results', evidenceIds: ['e1'] },
      { text: 'iPhone battery life lasted all day.', evidenceIds: ['e1'] },
    ] }).answer).toBe('## Results [cite:e1]\n\niPhone battery life lasted all day. [cite:e1]');
  });

  it('keeps repetitive warning text rather than rejecting the answer', () => {
    expect(renderStructuredAnswer({ ...base,
      blocks: [{ text: 'The report is supported.', evidenceIds: ['e1'] }],
      warnings: [{ code: 'SOURCE_CAVEAT', message: 'Continue the report from where it was cut off. '.repeat(4) }],
    }).warnings).toHaveLength(1);
  });

  it('still rejects answers larger than the public response limit without silently cutting them', () => {
    expect(() => renderStructuredAnswer({ ...base, blocks: [{
      text: 'A complete sentence. '.repeat(1100), evidenceIds: ['e1'],
    }] })).toThrow();
  });
  it('transmits required references and omits application-owned fields for finalization', async () => {
    const schema = await zodSchema(finalizationOutputSchema).jsonSchema;
    expect(schema).toMatchObject({ type: 'object', properties: {
      blocks: { minItems: 1, maxItems: 20, items: { properties: {
        evidenceIds: { minItems: 1, maxItems: 12 },
      }, required: ['text', 'evidenceIds'] } },
    }, required: expect.arrayContaining(['confidence', 'blocks']) });
    expect(schema.properties).not.toHaveProperty('intent');
    expect(schema.properties).not.toHaveProperty('artifacts');
    expect(schema.properties).toHaveProperty('warnings.maxItems', 3);
    expect(finalizationOutputSchema.safeParse({ confidence: 'medium', blocks: [{ text: 'Unsupported', evidenceIds: [] }] }).success).toBe(false);
  });
  it('expresses clarification rules separately in JSON Schema', () => {
    expect(z.toJSONSchema(clarificationAnswerSchema)).toMatchObject({ properties: {
      blocks: { minItems: 1, maxItems: 1, items: { properties: { evidenceIds: { maxItems: 0 } } } },
    } });
    expect(clarificationAnswerSchema.safeParse({ ...base, intent: 'clarification', blocks: [{ text: 'Question?', evidenceIds: ['e1'] }] }).success).toBe(false);
  });
  it('exposes answer fields directly in the model tool schema', () => {
    const schema = z.toJSONSchema(structuredAnswerSchema);
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('blocks');
    expect(schema.properties).toHaveProperty('intent');
  });
  it('renders a marker-free model answer with exact persisted text and timestamps', () => {
    const result = finalize(['e1', 'e1']);
    expect(result.answer).toBe('Supported finding without manually written citations. [cite:e1]');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ excerpt: 'Original transcript.', startMs: 1000, endMs: 2000 });
  });
  it('retains up to twelve supporting references for a multi-video comparison', () => {
    const evidenceIds = Array.from({ length: 12 }, (_, index) => `e${index + 1}`);
    const result = renderStructuredAnswer({ ...base, intent: 'topic_research', blocks: [{
      text: 'The four videos support this comparison.', evidenceIds,
    }] });
    expect(result.answer.match(/\[cite:/g)).toHaveLength(12);
    expect(structuredAnswerSchema.safeParse({ ...base, blocks: [{
      text: 'Comparison', evidenceIds: [...evidenceIds, 'e13'],
    }] }).success).toBe(false);
  });
  it.each(['topic_research', 'inspect_video'] as const)('renders ten cited points for %s and keeps a bounded block limit', intent => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ text: `${i + 1}. Supported point`, evidenceIds: ['e1'] }));
    const result = renderStructuredAnswer({ ...base, intent, blocks });
    expect(result.answer.match(/\[cite:e1\]/g)).toHaveLength(10);
    expect(structuredAnswerSchema.safeParse({ ...base, intent, blocks: Array(21).fill(blocks[0]) }).success).toBe(false);
  });

  it('distinguishes source caveats from unmet scope and reserves runtime warning codes', () => {
    const blocks = [{ text: 'Supported finding', evidenceIds: ['e1'] }];
    expect(renderStructuredAnswer({ ...base, blocks, warnings: [{ code: 'SOURCE_CAVEAT', message: 'Self-reported demo.' }] }).warnings[0]?.code).toBe('SOURCE_CAVEAT');
    expect(renderStructuredAnswer({ ...base, blocks, warnings: [{ code: 'ANSWER_SCOPE_SHORTFALL', message: 'Only six of ten requested examples are supported.' }] }).warnings[0]?.code).toBe('PARTIAL_EVIDENCE');
    expect(structuredAnswerSchema.safeParse({ ...base, blocks, warnings: [{ code: 'PARTIAL_EVIDENCE', message: 'Other search results were not reviewed.' }] }).success).toBe(false);
  });

  it('requires references on every block, not just somewhere in the answer', () => {
    expect(structuredAnswerSchema.safeParse({ ...base, blocks: [
      { text: 'Supported', evidenceIds: ['e1'] }, { text: 'Unsupported', evidenceIds: [] },
    ] }).success).toBe(false);
  });
  it('allows a clarification question without inventing evidence', () => {
    const input = renderStructuredAnswer({ ...base, intent: 'clarification',
      blocks: [{ text: 'Which aspect should I inspect?', evidenceIds: [] }] });
    expect(input.answer).toBe('Which aspect should I inspect?');
    expect(input.citations).toEqual([]);
  });
  it('still requires at least one persisted citation for a research answer', () => {
    expect(() => finalize(['invented'])).toThrow(expect.objectContaining({ code: 'AGENT_CITATION_REQUIRED' }));
  });
  it('marks an injected reference that matches no saved evidence as unavailable', () => {
    const result = finalize(['e1'], 'Text [cite:invented]');
    expect(result.answer).toBe('Text [source unavailable] [cite:e1]');
    expect(result.citations.map(citation => citation.id)).toEqual(['e1']);
  });
  it('removes model-written short reference markers before adding validated citations', () => {
    const rendered = renderStructuredAnswer({ ...base, blocks: [
      { text: 'Supported claim【ref_1】 with an example[ref_2].', evidenceIds: ['e1'] },
    ] });
    expect(rendered.answer).toBe('Supported claim with an example. [cite:e1]');
  });
});

it.each(['No.', '42', 'Raynald Westerling', '"The"', 'The stored transcript is unavailable.', 'I checked the history. Your first question was about wolves.'])(
  'retains a legitimate short answer or completed explanation: %s', text => {
    expect(renderStructuredAnswer({intent:'context_answer',confidence:'high',warnings:[],artifacts:[],blocks:[{text,evidenceIds:[]}]}).answer).toBe(text);
  },
);

describe('truncated answer salvage', () => {
  const output = finalizationOutputSchema;
  const answer = (...texts: string[]) => JSON.stringify({ confidence: 'medium', warnings: [],
    blocks: texts.map(text => ({ text, evidenceIds: ['e1'] })) });
  it('keeps complete blocks and drops the block cut off mid-sentence', async () => {
    const candidate = answer('First complete point.', 'Second complete point.').slice(0, -2) + ', {"text": "Third point was cut off mid';
    await expect(salvageTruncatedAnswer(candidate, output)).resolves.toEqual({ droppedBlock: true, output: expect.objectContaining({ blocks: [
      expect.objectContaining({ text: 'First complete point.' }), expect.objectContaining({ text: 'Second complete point.' }),
    ] }) });
  });
  it('keeps every block of a comparison when only the outer JSON is missing', async () => {
    const candidate = answer('Product A has 54.2% protein.', 'Product B has 61.0% protein.').slice(0, -2);
    await expect(salvageTruncatedAnswer(candidate, output)).resolves.toEqual({ droppedBlock: false, output: expect.objectContaining({ blocks: [
      expect.objectContaining({ text: 'Product A has 54.2% protein.' }), expect.objectContaining({ text: 'Product B has 61.0% protein.' }),
    ] }) });
  });
  it('keeps a complete single block when only the closing brace is missing', async () => {
    await expect(salvageTruncatedAnswer(answer('The only point.').slice(0, -1), output))
      .resolves.toMatchObject({ droppedBlock: false, output: { blocks: [{ text: 'The only point.' }] } });
  });
  it('drops a block whose citations were cut off even though its text closed', async () => {
    const candidate = answer('First complete point.').slice(0, -2) + ', {"text": "Second point.", "evidenceIds": ["e1"';
    await expect(salvageTruncatedAnswer(candidate, output))
      .resolves.toMatchObject({ droppedBlock: true, output: { blocks: [{ text: 'First complete point.' }] } });
  });
  it('is not confused by quotes, braces or the word blocks inside answer text', async () => {
    const candidate = answer('A "quoted} {blocks": [ claim.', 'Second \\ point.').slice(0, -2) + ', {"text": "Cut';
    await expect(salvageTruncatedAnswer(candidate, output)).resolves.toMatchObject({ droppedBlock: true,
      output: { blocks: [{ text: 'A "quoted} {blocks": [ claim.' }, { text: 'Second \\ point.' }] } });
  });
  it('drops the last block when JSON closes cleanly despite the limit', async () => {
    await expect(salvageTruncatedAnswer(answer('First point.', 'Second point.'), output))
      .resolves.toMatchObject({ droppedBlock: true, output: { blocks: [{ text: 'First point.' }] } });
    await expect(salvageTruncatedAnswer(answer('The only point.'), output)).resolves.toBeUndefined();
  });
  it('returns nothing when no complete block exists', async () => {
    await expect(salvageTruncatedAnswer('{"confidence":"medium","warnings":[],"blocks":[{"text":"Cut off', output)).resolves.toBeUndefined();
    await expect(salvageTruncatedAnswer('not json', output)).resolves.toBeUndefined();
    await expect(salvageTruncatedAnswer(undefined, output)).resolves.toBeUndefined();
  });
});
