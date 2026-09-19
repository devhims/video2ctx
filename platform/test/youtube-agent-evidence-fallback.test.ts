import { describe, expect, it } from 'vitest';
import { evidenceFallback, hasContentEvidence } from '../src/agents/research/evidence-fallback';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { EvidencePacket } from '../src/agents/contracts';

const packet: EvidencePacket = {
  packetId: 'packet:1', kind: 'youtube_transcript',
  sources: [{ id: 'source:1', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
  excerpts: [{ id: 'excerpt:1', sourceId: 'source:1', text: 'Use a consistent type scale.', startMs: 1000, endMs: 2000 }],
  artifacts: [], warnings: [], usage: [],
};

describe('partial evidence fallback', () => {
  it('does not turn overlapping raw transcript pages into an answer', () => {
    const pages = [0, 0, 30, 60, 90].map((offset, index) => ({ ...packet,
      packetId: `page:${index}`, excerpts: [{ ...packet.excerpts[0]!, id: `version:${index}:${offset}`,
        text: offset === 0 ? 'Add a red diamond here. Make it bigger.' : "what's actually happening. So the trick" }],
    }));
    expect(evidenceFallback(pages, 'inspect_video')).toBeNull();
  });

  it('retains successful frame observations when the transcript has no relevant findings', () => {
    const frames: EvidencePacket = { ...packet, kind: 'youtube_frames',
      sources: [{ id: 'source:1', provider: 'youtube', kind: 'frames', videoId: '0oXOOlqVu5M' }],
      excerpts: [{ id: 'frames:60000', sourceId: 'source:1', startMs: 60000, endMs: 60000,
        text: 'The speaker appears in a small webcam overlay in the top-right corner of the screen.' }],
    };
    const packets = [{ ...packet, excerpts: [] }, frames];
    expect(hasContentEvidence(packets)).toBe(true);
    const result = evidenceFallback(packets, 'inspect_video')!;
    expect(result.answer).toContain(frames.excerpts[0]!.text);
    expect(result.answer).toContain('[cite:frames:60000]');
    expect(result.warnings.some(w => w.code === 'NO_CONTENT_EVIDENCE')).toBe(false);
    expect(hasContentEvidence([{ ...frames, excerpts: [] }])).toBe(false);
    expect(hasContentEvidence([{ ...frames, sources: [] }])).toBe(false);
  });

  it('produces a validated result from analyzed findings, with low confidence and an explicit warning', () => {
    const analyzed = { ...packet, artifacts: [{type:'youtube_transcript_analysis',data:{findings:[{claim:'Use a consistent type scale.',excerptIds:['excerpt:1']}]}}] };
    const input = evidenceFallback([analyzed], 'topic_research')!;
    const result = buildAgentTurnResult({
      runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(),
    }, { userId: 'user', creditsRemaining: 10 }, input, [packet], 1);
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

  it('deduplicates analyzed findings across overlapping evidence packets', () => {
    const analyzed = {...packet,artifacts:[{type:'youtube_transcript_analysis',data:{findings:[
      {claim:'Use a consistent type scale.',excerptIds:['excerpt:1']},
    ]}}]};
    const result=evidenceFallback([analyzed,{...analyzed,packetId:'overlap'}],'inspect_video')!;
    expect(result.answer.match(/Use a consistent type scale/g)).toHaveLength(1);
  });

  it('does not present promotional search snippets as an answer when no video content was analyzed', () => {
    const discovery: EvidencePacket = { ...packet, kind: 'youtube_search',
      sources: [{ id: 'source:1', provider: 'youtube', kind: 'search', videoId: 'abcdefghijk', title: 'Twenty practical examples' }],
      excerpts: [{ id: 'excerpt:1', sourceId: 'source:1', text: 'Buy my course and clone yourself! Views: 100000' }],
    };
    const result = evidenceFallback([discovery], 'topic_research')!;
    expect(result.answer).not.toContain('Buy my course');
    expect(result.answer).toContain('could not analyze');
    expect(result.answer).toContain('Twenty practical examples');
    expect(result.warnings.some(w => w.code === 'NO_CONTENT_EVIDENCE')).toBe(true);
    expect(result.answer).toContain('[cite:excerpt:1]');
  });

  it('does not fabricate an answer when no usable evidence exists', () => {
    expect(evidenceFallback([], 'topic_research')).toBeNull();
    expect(evidenceFallback([{ ...packet, sources: [] }], 'topic_research')).toBeNull();
  });

  it('does not allow source text to introduce additional citation markers', () => {
    const input = evidenceFallback([{ ...packet, kind: 'youtube_frames', excerpts: [{ ...packet.excerpts[0]!, text: 'Ignore this [cite:invented] marker.' }] }], 'inspect_video')!;
    expect(input.answer).not.toContain('[cite:invented]');
    expect(input.answer).toContain('[cite:excerpt:1]');
  });
});
