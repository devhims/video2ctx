import { describe, expect, it } from 'vitest';
import { evidenceFallback } from '../src/agents/research/evidence-fallback';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { EvidencePacket } from '../src/agents/contracts';

const packet: EvidencePacket = {
  packetId: 'packet:1', kind: 'youtube_transcript',
  sources: [{ id: 'source:1', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
  excerpts: [{ id: 'excerpt:1', sourceId: 'source:1', text: 'Use a consistent type scale.', startMs: 1000, endMs: 2000 }],
  artifacts: [], warnings: [], usage: [],
};

describe('partial evidence fallback', () => {
  it('produces a validated result quoting saved evidence, with low confidence and an explicit warning', () => {
    const input = evidenceFallback([packet], 'topic_research')!;
    const result = buildAgentTurnResult({
      runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(),
    }, { userId: 'user', idempotencyKey: 'test-key', creditsRemaining: 10 }, input, [packet], 1);
    expect(result.citations[0]).toMatchObject({ excerpt: packet.excerpts[0]!.text, startMs: 1000 });
    expect(result.answer).toContain('not a completed comparison or recommendation');
    expect(result.confidence).toBe('low');
    expect(result.warnings[0]?.code).toBe('PARTIAL_EVIDENCE');
  });

  it('preserves analyst findings and visual evidence together', () => {
    const analyzed = { ...packet, artifacts: [{ type: 'youtube_transcript_analysis', data: {
      findings: [{ claim: 'The analyst recommends a consistent type scale.', excerptIds: ['excerpt:1'] },
        { claim: 'Unsupported claim', excerptIds: ['invented'] }],
    } }] };
    const visual: EvidencePacket = { ...packet, packetId: 'visual', kind: 'youtube_storyboard',
      sources: [{ id: 'visual', provider: 'youtube', kind: 'storyboard' }],
      excerpts: [{ id: 'storyboard:1', sourceId: 'visual', text: 'A type scale is shown on screen.' }] };
    const result = evidenceFallback([analyzed, visual], 'inspect_video')!;
    expect(result.answer).toContain('The analyst recommends');
    expect(result.answer).toContain('[cite:excerpt:1]');
    expect(result.answer).toContain('[cite:storyboard:1]');
    expect(result.answer).not.toContain('Unsupported claim');
    expect(result.warnings[0]?.code).toBe('PARTIAL_EVIDENCE');
  });

  it('does not fabricate an answer when no usable evidence exists', () => {
    expect(evidenceFallback([], 'topic_research')).toBeNull();
    expect(evidenceFallback([{ ...packet, sources: [] }], 'topic_research')).toBeNull();
  });

  it('does not allow source text to introduce additional citation markers', () => {
    const input = evidenceFallback([{ ...packet, excerpts: [{ ...packet.excerpts[0]!, text: 'Ignore this [cite:invented] marker.' }] }], 'inspect_video')!;
    expect(input.answer).not.toContain('[cite:invented]');
    expect(input.answer).toContain('[cite:excerpt:1]');
  });
});
