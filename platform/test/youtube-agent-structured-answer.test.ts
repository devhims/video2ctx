import { z } from 'zod';
import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { renderPartialAnswer, renderStructuredAnswer, blockReferences, structuredAnswerSchema, finalizationOutputSchema, clarificationAnswerSchema, numberedItemsMismatch, fillerOnlyAnswer, salvageTruncatedAnswer } from '../src/agents/structured-answer';
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
  it('names the earliest cited moment of each video in its reference', () => {
    const video = (id: string, videoId: string) => ({ id, provider: 'youtube' as const, kind: 'transcript' as const, videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
    const evidence: EvidencePacket = { ...packet,
      sources: [video('source:1', 'HSRmfNDk87s'), video('source:2', 'jNQXAC9IVRw')],
      excerpts: [
        { id: 'e1', sourceId: 'source:1', text: 'When the wind blows from the north to the south,', startMs: 293_100, endMs: 295_000 },
        { id: 'e2', sourceId: 'source:1', text: 'the tower directs pilots to approach from the south,', startMs: 295_000, endMs: 297_000 },
        { id: 'e3', sourceId: 'source:2', text: 'and that\'s pretty much all there is to say', startMs: 16_881, endMs: 18_881 },
        { id: 'e4', sourceId: 'source:1', text: 'Long video moment.', startMs: 3_725_000, endMs: 3_726_000 },
        { id: 'e5', sourceId: 'source:2', text: 'Title: Me at the zoo' },
      ],
    };
    const input = renderStructuredAnswer({ ...base, blocks: [
      { text: 'Land into the wind.', evidenceIds: ['e2', 'e1'] },
      { text: 'Two videos.', evidenceIds: ['e1', 'e3'] },
      { text: 'Late.', evidenceIds: ['e4'] },
      { text: 'Untimed.', evidenceIds: ['e5'] },
    ] });
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, input, [evidence], 1);
    const compact = compactAgentResult(result);
    expect(compact.answer).toBe('Land into the wind. [1 · 4:53]\n\nTwo videos. [1 · 4:53][2 · 0:16]\n\nLate. [1 · 1:02:05]\n\nUntimed. [2]');
    expect(compact.sources.map(source => source.url)).toEqual(['https://www.youtube.com/watch?v=HSRmfNDk87s', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
  });
  it('preserves the same reference group in inline and fenced code while citing prose', () => {
    const marker = '[ref_2405, ref_2406]';
    const code = `Inline: \`${marker}\`.\n\n\`\`\`js\nconst refs = ${marker};\n\`\`\``;
    const text = `Claim ${marker}.\n\n${code}`;
    const aliases = new Map([['ref_2405', 'e1'], ['ref_2406', 'e2']]);
    const block = { text, evidenceIds: ['e1'] };
    const evidence: EvidencePacket = { ...packet,
      sources: [{ ...packet.sources[0]!, videoId: 'video000001' },
        { ...packet.sources[0]!, id: 'source:2', videoId: 'video000002' }],
      excerpts: [...packet.excerpts, { id: 'e2', sourceId: 'source:2', text: 'Second passage.' }],
    };
    expect(blockReferences({ text: code, evidenceIds: [] }, aliases)).toEqual([]);
    expect(blockReferences(block, aliases)).toEqual(['e1', 'e2']);
    const input = renderStructuredAnswer({ ...base, blocks: [block] }, aliases);
    expect(input.answer).toBe(`Claim [cite:e1] [cite:e2].\n\n${code}`);
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, input, [evidence], 1);
    expect(compactAgentResult(result).answer).toBe(`Claim [1 · 0:01][2].\n\n${code}`);
    expect(renderPartialAnswer({ blocks: [block] })).toBe(`Claim .\n\n${code}`);
  });
  it.each([
    '```js\n[ref_2405, ref_2406]\n```',
    '```js\n[ref_2405, ref_2406]',
    '    [ref_2405, ref_2406]',
    '> ~~~js\n> [ref_2405, ref_2406]\n> ~~~',
    '- Example:\n\n  ```js\n  [ref_2405, ref_2406]\n  ```',
  ])('keeps appended citations outside a trailing code block: %s', text => {
    const rendered = renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds: ['e1'] }] });
    expect(rendered.answer).toBe(`Sources: [cite:e1]\n\n${text}`);
  });
  it('leaves literal canonical markers intact when a prose citation is unavailable', () => {
    const code = '`[cite:unknown]` and `[cite:e1]`';
    const result = finalize(['e1'], `Missing [cite:unknown]. Examples ${code}.`);
    expect(compactAgentResult(result).answer).toBe(`Missing [source unavailable]. Examples ${code}. [1]`);
    expect(result.citations.map(citation => citation.id)).toEqual(['e1']);
  });
  it.each(['[ref_2405, ref_2406]', '[cite:e1]', '[cite:unknown]', '(source marker:e1]'])('does not validate or format code-only markers: %s', marker => {
    const text = `Inline: \`${marker}\`.\n\n~~~text\n${marker}\n~~~`;
    const block = { text, evidenceIds: [] };
    expect(blockReferences(block)).toEqual([]);
    const input = renderStructuredAnswer({ ...base, intent: 'context_answer', blocks: [block] });
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, input, [packet], 1);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe(text);
    expect(compactAgentResult(result).answer).toBe(text);
    expect(renderPartialAnswer({ blocks: [block] })).toBe(text);
  });
  it.each([
    '\`\`\`js\n[ref_2405, ref_2406]',
    'Inline: \`[ref_2405, ref_2406]',
    'Inline: \`\`a \` [ref_2405, ref_2406]',
    '> ~~~js\n> [ref_2405, ref_2406]',
  ])('preserves unfinished code in streaming previews: %s', text => {
    expect(renderPartialAnswer({ blocks: [{ text }] })).toBe(text);
  });
  it.each(['[ref_2405, ref_2406]', '【ref_2405, ref_2406】', '[ ref_2405,ref_2406 ]'])('resolves grouped bare references through validation and public formatting: %s', marker => {
    const aliases = new Map([['ref_2405', 'e1'], ['ref_2406', 'e2']]);
    const block = { text: `Claim ${marker}.`, evidenceIds: ['e1'] };
    const evidence: EvidencePacket = { ...packet,
      sources: [{ ...packet.sources[0]!, videoId: 'video000001' },
        { ...packet.sources[0]!, id: 'source:2', videoId: 'video000002' }],
      excerpts: [...packet.excerpts, { id: 'e2', sourceId: 'source:2', text: 'Second passage.', startMs: 3000, endMs: 4000 }],
    };
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 },
    renderStructuredAnswer({ ...base, blocks: [block] }, aliases), [evidence], 1);
    const compact = compactAgentResult(result);
    expect(compact.answer).toBe('Claim [1 · 0:01][2 · 0:03].');
    expect(compact.sources.map(source => source.url)).toEqual([
      'https://www.youtube.com/watch?v=video000001',
      'https://www.youtube.com/watch?v=video000002',
    ]);
    expect(blockReferences(block, aliases)).toEqual(['e1', 'e2']);
  });
  it('marks an unknown grouped bare reference unavailable without inventing a source', () => {
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 },
    renderStructuredAnswer({ ...base, blocks: [{ text: 'Claim [ref_2405, ref_9999].', evidenceIds: ['e1'] }] },
      new Map([['ref_2405', 'e1']])), [packet], 1);
    expect(compactAgentResult(result).answer).toBe('Claim [1] [source unavailable].');
    expect(result.citations.map(citation => citation.id)).toEqual(['e1']);
  });
  it.each(['[ref_2405, ref_2406]', '[ref_2405, ref_', '【ref_2405, ref_2406】'])('hides grouped references in provisional output: %s', marker => {
    expect(renderPartialAnswer({ blocks: [{ text: `Claim ${marker}` }] })).toBe('Claim');
  });

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
  // A placeholder would otherwise render as citation chips with no answer and complete the run.
  const placeholderAliases = new Map([['ref_1', 'e1'], ['ref_2', 'e2']]);
  it.each(['…', '...', '… [cite:ref_1]', '【ref_1】…', '[ref_1] [ref_2]', '(ref_1) — ref_2', '**…**', '\u200b',
    // The renderer turns a whole supported range into citations, separator word included.
    'ref_1 through ref_2', 'ref_1 to ref_2', '… (ref_1 thru ref_2).', '[ref_1 through ref_2]'])(
    'rejects a placeholder-only answer for one repair: %j', text => {
      expect(() => renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds: ['e1'] }] }, placeholderAliases))
        .toThrow(/placeholder with no answer text/);
    });
  it.each(['Sí.', 'El orador recomienda grabar en 4K.', '42 [cite:ref_1]', '【注意】 [cite:ref_1]',
    // Code, links, URLs, quotes and unsupported ranges are preserved by the renderer as visible text.
    '`ref_1`', '"(ref_1)"', '"(ref_1 through ref_2)"', '    [ref_1, ref_2]', '[ref_1](https://example.com)',
    'https://example.com/ref_1', 'ref_2 to ref_1'])('keeps an answer whose rendered text remains: %j', text => {
    expect(() => renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds: ['e1'] }] }, placeholderAliases)).not.toThrow();
  });
  it('judges a bare range by the aliases that render it', () => {
    // Without the aliases the renderer leaves the range as literal text, so it is text.
    expect(fillerOnlyAnswer({ blocks: [{ text: 'ref_1 through ref_2' }] })).toBe(false);
    expect(fillerOnlyAnswer({ blocks: [{ text: 'ref_1 through ref_2' }] }, placeholderAliases)).toBe(true);
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
      code: 'ANSWER_SCOPE_SHORTFALL', message: 'Only sampled images were inspected.',
    }] }, 10)).toBe(true);
    expect(numberedItemsMismatch({ ...output, warnings: [{
      code: 'ANSWER_SCOPE_SHORTFALL', unansweredPart: 'The second requested item', message: 'Only one item is supported by the available evidence.',
    }] }, 10)).toBe(false);
  });
  it('flags filler-only answers as a signal', () => {
    expect(fillerOnlyAnswer({ blocks: [{ text: "I'll look up the transcript." }] })).toBe(true);
    expect(fillerOnlyAnswer({ blocks: [{ text: 'The' }, { text: 'No.' }] })).toBe(false);
    expect(fillerOnlyAnswer({ blocks: [{ text: '… [cite:e1]' }, { text: '...' }] })).toBe(true);
    // One substantive block is an answer; any further placeholder is a formatting issue.
    expect(fillerOnlyAnswer({ blocks: [{ text: '… [cite:e1]' }, { text: 'La respuesta. [cite:e1]' }] })).toBe(false);
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
    expect(renderStructuredAnswer({ ...base, blocks, warnings: [{ code: 'ANSWER_SCOPE_SHORTFALL', unansweredPart: 'Four of the ten requested examples', message: 'Only six of ten requested examples are supported.' }] }).warnings[0]?.code).toBe('PARTIAL_EVIDENCE');
    expect(structuredAnswerSchema.safeParse({ ...base, blocks, warnings: [{ code: 'PARTIAL_EVIDENCE', message: 'Other search results were not reviewed.' }] }).success).toBe(false);
  });

  it('keeps source caveats nonblocking even if the model supplies an unansweredPart', () => {
    const warnings = renderStructuredAnswer({ ...base,
      blocks: [{ text: 'Supported finding', evidenceIds: ['e1'] }],
      warnings: [{ code: 'SOURCE_CAVEAT', unansweredPart: 'Only sampled frames', message: 'Brief moments may be missed.' }],
    }).warnings;
    expect(warnings).toEqual([{ code: 'SOURCE_CAVEAT', message: 'Brief moments may be missed.' }]);
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
  it('resolves single bare references using the same validation path', () => {
    const rendered = renderStructuredAnswer({ ...base, blocks: [
      { text: 'Supported claim【ref_1】 with an example[ref_2].', evidenceIds: ['ref_1'] },
    ] }, new Map([['ref_1', 'e1'], ['ref_2', 'e2']]));
    expect(rendered.answer).toBe('Supported claim[cite:e1] with an example[cite:e2].');
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
    await expect(salvageTruncatedAnswer(candidate, output)).resolves.toEqual({ droppedBlock: true, closedCleanly: false, output: expect.objectContaining({ blocks: [
      expect.objectContaining({ text: 'First complete point.' }), expect.objectContaining({ text: 'Second complete point.' }),
    ] }) });
  });
  it('keeps every block of a comparison when only the outer JSON is missing', async () => {
    const candidate = answer('Product A has 54.2% protein.', 'Product B has 61.0% protein.').slice(0, -2);
    await expect(salvageTruncatedAnswer(candidate, output)).resolves.toEqual({ droppedBlock: false, closedCleanly: false, output: expect.objectContaining({ blocks: [
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
  it('keeps every block when JSON closes cleanly despite the limit, and reports it', async () => {
    await expect(salvageTruncatedAnswer(answer('First point.', 'Second point.'), output)).resolves.toMatchObject({
      droppedBlock: false, closedCleanly: true, output: { blocks: [{ text: 'First point.' }, { text: 'Second point.' }] } });
    await expect(salvageTruncatedAnswer(answer('The only point.'), output))
      .resolves.toMatchObject({ droppedBlock: false, closedCleanly: true, output: { blocks: [{ text: 'The only point.' }] } });
  });
  it('returns nothing when no complete block exists', async () => {
    await expect(salvageTruncatedAnswer('{"confidence":"medium","warnings":[],"blocks":[{"text":"Cut off', output)).resolves.toBeUndefined();
    await expect(salvageTruncatedAnswer('not json', output)).resolves.toBeUndefined();
    await expect(salvageTruncatedAnswer(undefined, output)).resolves.toBeUndefined();
  });
});

describe('model-written aliases and passage references', () => {
  const transcript = (id: string, startMs?: number, endMs?: number, sourceId = 'youtube:videoAAAAAA:transcript') =>
    ({ id, sourceId, text: `Excerpt ${id}.`, ...(startMs === undefined ? {} : { startMs }), ...(endMs === undefined ? {} : { endMs }) });
  const evidence: EvidencePacket = { ...packet,
    sources: [
      { id: 'youtube:videoAAAAAA:transcript', provider: 'youtube', kind: 'transcript', videoId: 'videoAAAAAA' },
      { id: 'youtube:videoAAAAAA:frames', provider: 'youtube', kind: 'frames', videoId: 'videoAAAAAA' },
      { id: 'youtube:video:videoAAAAAA', provider: 'youtube', kind: 'video', videoId: 'videoAAAAAA' },
      { id: 'youtube:videoBBBBBB:transcript', provider: 'youtube', kind: 'transcript', videoId: 'videoBBBBBB' },
    ],
    excerpts: [
      transcript('t1', 10_000, 15_000), transcript('t2', 15_000, 20_000), transcript('t3', 14_000, 18_000),
      transcript('t4', 40_000, 45_000), transcript('t5', 15_000, 40_000),
      transcript('n1', 60_000, 90_000), transcript('n2', 62_000, 64_000), transcript('n3', 70_000, 75_000),
      transcript('m1', 16_000), transcript('x1', 30_000, 20_000),
      transcript('f1', 12_000, 12_000, 'youtube:videoAAAAAA:frames'),
      transcript('u1', undefined, undefined, 'youtube:video:videoAAAAAA'),
      transcript('b1', 10_000, 15_000, 'youtube:videoBBBBBB:transcript'),
    ],
  };
  const aliases = new Map([['ref_1', 't1'], ['ref_2', 't2'], ['ref_9', 't4'], ['ref_30', 't1'], ['ref_36', 't4'],
    ['ref_143', 't1'], ['ref_144', 't2']]);
  function publish(text: string, evidenceIds: string[] = ['t1'], references: ReadonlyMap<string, string> = aliases,
    packets: EvidencePacket[] = [evidence]) {
    const input = renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds }] }, references);
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, input, packets, 1);
    return { input, result, compact: compactAgentResult(result, ['evidence']) };
  }

  it('resolves a known parenthesized alias group into one reference for a continuous passage', () => {
    const { input, result, compact } = publish('Blooms form when water meets a drying wash (ref_143, ref_144).');
    expect(input.answer).toBe('Blooms form when water meets a drying wash [cite:t1] [cite:t2].');
    expect(compact.answer).toBe('Blooms form when water meets a drying wash [1 · 0:10].');
    expect(compact.answer).not.toMatch(/ref_\d/);
    expect(result.citations.map(citation => citation.id)).toEqual(['t1', 't2']);
    expect(compact.evidence?.map(({ id, startMs, endMs }) => ({ id, startMs, endMs }))).toEqual([
      { id: 't1', startMs: 10_000, endMs: 15_000 }, { id: 't2', startMs: 15_000, endMs: 20_000 }]);
  });
  it.each([
    ['See ref_9.', 'See [1 · 0:40]. [1 · 0:10]'],
    ['ref_9 shows the wash.', '[1 · 0:40] shows the wash. [1 · 0:10]'],
    ['(see ref_9) and **ref_2**.', '(see [1 · 0:40]) and **[1 · 0:15]**. [1 · 0:10]'],
    ['| Step | Source |\n| --- | --- |\n| Wash | ref_9 |', '| Step | Source |\n| --- | --- |\n| Wash | [1 · 0:40] |\n\nSources: [1 · 0:10]'],
  ])('resolves a known bare alias where the model placed it: %s', (text, expected) => {
    expect(publish(text).compact.answer).toBe(expected);
  });
  it('counts resolved aliases as block references for answer checks', () => {
    expect(blockReferences({ text: 'Claim (ref_143, ref_144), ref_9, (ref_1, ref_404) and ref_30 to ref_36.', evidenceIds: [] }, aliases))
      .toEqual(['t1', 't2', 't4']);
  });
  it.each([
    'Unknown (ref_404) here.',
    'Unknown ref_404 here.',
    'Mixed (ref_1, ref_404) here.',
    'The demo runs ref_30 to ref_36 here.',
    'The demo runs ref_30 through ref_36 here.',
    'The demo runs ref_30-ref_36 here.',
    'The demo runs ref_30–36 here.',
    'The demo runs (ref_30 to ref_36) here.',
    'The demo runs [ref_30-ref_36] here.',
  ])('leaves unknown, mixed and range forms exactly as written: %s', text => {
    const { input, result } = publish(text);
    expect(input.answer).toBe(`${text} [cite:t1]`);
    expect(result.citations.map(citation => citation.id)).toEqual(['t1']);
    expect(result.warnings.map(warning => warning.code)).not.toContain('CITATIONS_UNAVAILABLE');
  });
  it.each([
    'Literal `ref_1` and `(ref_1, ref_2)` here.',
    'Link https://example.com/ref_1 here.',
    'Link [docs](https://example.com/a?id=ref_1) here.',
    'Names my_ref_1, xref_1, ref_1x, ref_1.5, ref_1-based and ref_1\'s here.',
    'Quoted "ref_1" and call(ref_1) and fn(ref_1, ref_2) here.',
    'Bracketed [see ref_1] stays here.',
  ])('leaves code, URLs, identifiers and quotations unchanged: %s', text => {
    expect(publish(text).input.answer).toBe(`${text} [cite:t1]`);
  });
  it.each([
    'Call fn(value, ref_1) here.',
    'Call fn(ref_1, ref_2, value) here.',
    'Call fn(ref_1, ref_2) here.',
    'Call outer(inner(ref_1), ref_2) here.',
    'Call fn(a, b(c), ref_1) here.',
    'Call obj.method(ref_1) here.',
    'Call fn(ref_1 here.',
  ])('leaves aliases in call-like text unchanged in any argument position: %s', text => {
    const { input, result, compact } = publish(text);
    expect(input.answer).toBe(`${text} [cite:t1]`);
    expect(result.citations.map(citation => citation.id)).toEqual(['t1']);
    expect(compact.answer).toBe(`${text} [1 · 0:10]`);
  });
  it.each([
    'Call fn(")", ref_1) here.',
    'Call fn(\'close)\', ref_1) here.',
    'Call fn("a\\")", ref_1) here.',
    'Call fn(`)`, ref_1) here.',
    'Call fn(\n  value, ref_1\n) here.',
    'Call fn(\n  ")",\n  (ref_1, ref_2)\n) here.',
    'Call fn(it\'s, ref_1\n) here.',
  ])('leaves quoted and multiline call-like text unchanged: %s', text => {
    const { input, result, compact } = publish(text);
    expect(input.answer).toBe(`${text} [cite:t1]`);
    expect(result.citations.map(citation => citation.id)).toEqual(['t1']);
    expect(compact.answer).toBe(`${text} [1 · 0:10]`);
  });
  it.each([
    ['Call fn(")", value) returns, then the wash dries ref_9.', 'Call fn(")", value) returns, then the wash dries [1 · 0:40]. [1 · 0:10]'],
    ['Call fn(\n  value\n) returns, then the wash dries (ref_9).', 'Call fn(\n  value\n) returns, then the wash dries [1 · 0:40]. [1 · 0:10]'],
    ['Call fn(value is unclosed.\n\nThe wash dries ref_9.', 'Call fn(value is unclosed.\n\nThe wash dries [1 · 0:40]. [1 · 0:10]'],
    ['After fn(value) returns, the wash dries ref_9.', 'After fn(value) returns, the wash dries [1 · 0:40]. [1 · 0:10]'],
    ['The wash dries (ref_9), as fn(x) shows.', 'The wash dries [1 · 0:40], as fn(x) shows. [1 · 0:10]'],
    ['Blooms appear (see ref_9) after fn(ref_2).', 'Blooms appear (see [1 · 0:40]) after fn(ref_2). [1 · 0:10]'],
    ['See [docs](https://example.com/wash) and ref_9.', 'See [docs](https://example.com/wash) and [1 · 0:40]. [1 · 0:10]'],
    ['Visit https://example.com/wash, then ref_9.', 'Visit https://example.com/wash, then [1 · 0:40]. [1 · 0:10]'],
    ['Visit https://example.com/wash (ref_9).', 'Visit https://example.com/wash [1 · 0:40]. [1 · 0:10]'],
  ])('still resolves prose aliases beside call-like text, links and URLs: %s', (text, expected) => {
    expect(publish(text).compact.answer).toBe(expected);
  });
  it.each([
    'See [the wash ref_9](https://example.com/wash) here.',
    'See [docs](https://example.com/ref_9) here.',
    'See [docs](ref_9) here.',
    'See [docs](https://example.com/wash "ref_9") here.',
    'See [docs](https://example.com/wash "Notes (ref_1, ref_2)") here.',
    '[See (ref_1)](https://example.com/docs) here.',
    'See [docs](https://example.com/?value=ok,ref_1) here.',
    'See ![frame (ref_143, ref_144)](https://example.com/frame.png) here.',
    'See <https://example.com/ref_9> here.',
    'See [docs][wash] and [ref_9 notes][wash] here.\n\n[wash]: https://example.com/?value=ok,ref_1 "ref_2"\n\nMore prose.',
    'Visit https://example.com/?value=ok,ref_1 for notes.',
    'Visit https://example.com/(ref_1, ref_2) for notes.',
    'Visit www.example.com/?q=ok,ref_9 for notes.',
  ])('leaves Markdown links, definitions and bare URLs unchanged: %s', text => {
    const { input, result, compact } = publish(text);
    expect(input.answer).toBe(`${text} [cite:t1]`);
    expect(result.citations.map(citation => citation.id)).toEqual(['t1']);
    expect(compact.answer).toBe(`${text} [1 · 0:10]`);
  });
  it('excludes aliases in call-like text and links from block references', () => {
    expect(blockReferences({ text: 'fn(value, ref_1), [see ref_2](https://example.com) and ref_9.', evidenceIds: [] }, aliases))
      .toEqual(['t4']);
  });
  it('leaves aliases inside a fenced code block unchanged', () => {
    const text = 'Example:\n\n```text\n(ref_143, ref_144) ref_9\n```\n\nDone.';
    expect(publish(text).input.answer).toBe(`${text} [cite:t1]`);
  });
  it('does not resolve parenthesized or bare aliases without a supplied alias map', () => {
    const text = 'Claim (ref_1, ref_2) and ref_9.';
    expect(publish(text, ['t1'], new Map()).input.answer).toBe(`${text} [cite:t1]`);
  });

  it.each([
    ['an exact duplicate', 'Claim [cite:t1] [cite:t1].', ['t1'], 'Claim [1 · 0:10].'],
    ['touching intervals', 'Claim.', ['t1', 't2'], 'Claim. [1 · 0:10]'],
    ['overlapping intervals', 'Claim.', ['t1', 't3'], 'Claim. [1 · 0:10]'],
    ['out-of-order references', 'Claim.', ['t2', 't1'], 'Claim. [1 · 0:10]'],
    ['nested intervals, judged by the furthest end so far', 'Claim.', ['n2', 'n3', 'n1'], 'Claim. [1 · 1:00]'],
    ['a gap, never bridged by uncited evidence', 'Claim.', ['t1', 't4'], 'Claim. [1 · 0:10][1 · 0:40]'],
    ['a gap cited in reverse order', 'Claim.', ['t4', 't1'], 'Claim. [1 · 0:10][1 · 0:40]'],
    ['another source kind of the same video', 'Claim.', ['t1', 'f1'], 'Claim. [1 · 0:10][1 · 0:12]'],
    ['another video', 'Claim.', ['t1', 'b1'], 'Claim. [1 · 0:10][2 · 0:10]'],
    ['a missing end time', 'Claim.', ['t2', 'm1'], 'Claim. [1 · 0:15][1 · 0:16]'],
    ['an end before the start', 'Claim.', ['t1', 'x1'], 'Claim. [1 · 0:10][1 · 0:30]'],
    ['an untimed excerpt of the same video', 'Claim.', ['t1', 'u1'], 'Claim. [1 · 0:10][1]'],
  ])('shows references for %s', (_case, text, evidenceIds, expected) => {
    const { result, compact } = publish(text, evidenceIds);
    expect(compact.answer).toBe(expected);
    expect(result.citations.map(citation => citation.id).sort()).toEqual([...new Set(evidenceIds)].sort());
    expect(compact.evidence?.map(citation => citation.id).sort()).toEqual([...new Set(evidenceIds)].sort());
  });
  it('keeps public source numbers in first-use order across groups', () => {
    const { compact } = publish('Second video first [cite:b1]. Then [cite:t4] [cite:t1].', ['t1']);
    expect(compact.answer).toBe('Second video first [1 · 0:10]. Then [2 · 0:10][2 · 0:40].');
    expect(compact.sources.map(source => source.videoId)).toEqual(['videoBBBBBB', 'videoAAAAAA']);
  });
  it('records each citation kind from persisted evidence and keeps it out of public evidence', () => {
    const { result, compact } = publish('Claim.', ['t1', 'f1', 'u1']);
    expect(result.citations.map(({ id, sourceKind }) => [id, sourceKind])).toEqual([['t1', 'transcript'], ['f1', 'frames'], ['u1', 'video']]);
    expect(compact.evidence?.some(citation => 'sourceKind' in citation)).toBe(false);
  });
  it('does not merge excerpts of different kinds that share a source ID', () => {
    const shared = (packetId: string, kind: 'transcript' | 'frames', excerpt: EvidencePacket['excerpts'][number]): EvidencePacket => ({
      ...packet, packetId, sources: [{ id: 'shared', provider: 'youtube', kind, videoId: 'videoAAAAAA' }], excerpts: [excerpt] });
    const packets = [shared('p:transcript', 'transcript', transcript('s1', 10_000, 20_000, 'shared')),
      shared('p:frames', 'frames', transcript('s2', 15_000, 15_000, 'shared'))];
    const { result, compact } = publish('Claim.', ['s1', 's2'], aliases, packets);
    expect(result.citations.map(citation => citation.sourceKind)).toEqual(['transcript', 'frames']);
    expect(compact.answer).toBe('Claim. [1 · 0:10][1 · 0:15]');
  });
  it('does not merge stored excerpts without a recorded kind', () => {
    const { result } = publish('Claim.', ['t1', 't2']);
    expect(compactAgentResult(result).answer).toBe('Claim. [1 · 0:10]');
    const stored = structuredClone(result);
    for (const citation of stored.citations) delete citation.sourceKind;
    expect(compactAgentResult(stored).answer).toBe('Claim. [1 · 0:10][1 · 0:15]');
    stored.citations[0]!.sourceKind = 'transcript';
    expect(compactAgentResult(stored).answer).toBe('Claim. [1 · 0:10][1 · 0:15]');
  });
  it('does not merge stored excerpts whose times are not finite', () => {
    const { result } = publish('Claim.', ['t1', 't2']);
    const stored = structuredClone(result);
    stored.citations[1]!.startMs = Number.NaN;
    stored.citations[0]!.endMs = Number.POSITIVE_INFINITY;
    expect(compactAgentResult(stored).answer).toBe('Claim. [1 · 0:10][1]');
  });
});
