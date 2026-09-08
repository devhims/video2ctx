import { z } from 'zod';
import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { renderStructuredAnswer, structuredAnswerSchema, finalizationOutputSchema, clarificationAnswerSchema } from '../src/agents/structured-answer';
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
    userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID() },
  { userId: 'test', idempotencyKey: 'test', creditsRemaining: 10 },
  renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds }] }), [packet], 1);
}
describe('structured answer citations', () => {
  it('transmits required references and omits application-owned fields for finalization', async () => {
    const schema = await zodSchema(finalizationOutputSchema).jsonSchema;
    expect(schema).toMatchObject({ type: 'object', properties: {
      blocks: { minItems: 1, maxItems: 20, items: { properties: {
        evidenceIds: { minItems: 1, maxItems: 12 },
      }, required: ['text', 'evidenceIds'] } },
    }, required: expect.arrayContaining(['confidence', 'blocks']) });
    expect(schema.properties).not.toHaveProperty('intent');
    expect(schema.properties).not.toHaveProperty('artifacts');
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
  it('rejects invented references rather than manufacturing citations', () => {
    expect(() => finalize(['invented'])).toThrow(/persisted evidence/);
  });
  it('does not allow answer text to inject extra references', () => {
    expect(finalize(['e1'], 'Text [cite:invented]').citations.map(c => c.id)).toEqual(['e1']);
  });
});
