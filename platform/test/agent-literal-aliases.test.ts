import { describe, expect, it } from 'vitest';
import { blockReferences, renderStructuredAnswer } from '../src/agents/structured-answer';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { compactAgentResult } from '../src/agents/response';
import type { EvidencePacket } from '../src/agents/contracts';

const first = `evidence:${'a'.repeat(64)}:0`;
const fourth = `evidence:${'b'.repeat(64)}:3`;
const aliases = new Map([['ref_1', first], ['ref_4', fourth]]);
const packet: EvidencePacket = { packetId: 'literal-regression', kind: 'youtube_transcript',
  sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
  excerpts: [
    { id: first, sourceId: 'source', text: 'Declared finding', startMs: 1000, endMs: 2000 },
    { id: fourth, sourceId: 'source', text: 'Different finding', startMs: 4000, endMs: 5000 },
  ], artifacts: [], warnings: [], usage: [] };
const base = { intent: 'context_answer' as const, confidence: 'high' as const, artifacts: [], warnings: [] };
function publish(text: string, refs: ReadonlyMap<string, string>) {
  const input = renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds: [first] }] }, refs);
  const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
  { userId: 'test', creditsRemaining: 10 }, input, [packet], 1);
  return { input, result, compact: compactAgentResult(result, ['evidence']) };
}

describe.each([['supplied aliases', aliases], ['no alias map', new Map<string, string>()]] as const)('legacy bracket protection with %s', (_name, refs) => {
  it.each([
    'The literal is "[ref_4]".',
    'The literal is “【ref_4】”.',
    "The literal is '[ref_4, ref_1]'.",
    'Read [ref_4](https://example.com/).',
    'Read [docs](https://example.com/ "[ref_4]").',
    '![ref_4](https://example.com/image.png)',
    'Read [ref_4][docs].\n\n[docs]: https://example.com/',
    'Read [ref_4].\n\n[ref_4]: https://example.com/',
    'Example: `value [ref_4]`.',
    'Example: fn([ref_4], value).',
    'Example: outer(\n `value`, [ref_4]\n).',
    'The literal is "see `value` and [ref_4]".',
    'Visit https://example.com/[ref_4].',
  ])('preserves %s through finalization and display', text => {
    const { input, result, compact } = publish(text, refs);
    expect(blockReferences({ text, evidenceIds: [first] }, refs)).toEqual([first]);
    expect(input.answer).toBe(`${text} [cite:${first}]`);
    expect(result.citations.map(c => c.id)).toEqual([first]);
    expect(result.warnings).toEqual([]);
    expect(compact.answer).toBe(`${text} [1 · 0:01]`);
    expect(compact.evidence?.map(c => c.id)).toEqual([first]);
  });
});

it('keeps real inline citations beside separate claims and ignores a quoted alias', () => {
  const text = 'First claim [ref_1]. The literal is "[ref_4]". Second claim [ref_4].';
  const { compact, result } = publish(text, aliases);
  expect(compact.answer).toBe('First claim [1 · 0:01]. The literal is "[ref_4]". Second claim [1 · 0:04].');
  expect(result.citations.map(c => c.id)).toEqual([first, fourth]);
});

it('keeps genuine table citations inline while protecting a link label', () => {
  const table = '| Claim | Source |\n| --- | --- |\n| First | [ref_1] |\n| Second | 【ref_4】 |\n\nRead [ref_4](https://example.com/).';
  const { compact } = publish(table, aliases);
  expect(compact.answer).toBe('| Claim | Source |\n| --- | --- |\n| First | [1 · 0:01] |\n| Second | [1 · 0:04] |\n\nRead [ref_4](https://example.com/).');
});
