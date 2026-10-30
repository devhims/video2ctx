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

it.each(['CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED'])('preserves skipped transcript reason %s in metadata-only fallback', code => {
  const metadata = { ...packet, kind: 'youtube_video' as const };
  const skipped: EvidencePacket = { ...packet, packetId: 'skipped', sources: [], excerpts: [], artifacts: [],
    warnings: [{ code, message: 'Transcript access limitation.', videoId: 'abcdefghijk' }], usage: [] };
  const result = evidenceFallback([metadata, skipped], 'inspect_video')!;
  expect(result.warnings).toContainEqual(skipped.warnings[0]);
  expect(result.warnings.some(w => w.code === 'NO_CONTENT_EVIDENCE')).toBe(true);
});

// A video without captions or comments: report those outcomes instead of discovery boilerplate.
describe('empty or unavailable caption and comment outcomes', () => {
  const videoId = 'XqZsoesa55w';
  const metadata: EvidencePacket = { packetId: 'video', kind: 'youtube_video',
    sources: [{ id: 'youtube:video:XqZsoesa55w', provider: 'youtube', kind: 'video', videoId, title: 'Baby Shark Dance' }],
    excerpts: [{ id: 'video:XqZsoesa55w', sourceId: 'youtube:video:XqZsoesa55w', text: 'Baby Shark Dance. Captions: unavailable.' }],
    artifacts: [{ type: 'youtube_video_metadata', data: { id: videoId, captionAvailability: { status: 'unavailable', languages: [], checkedAt: '2026-10-30T09:00:00.000Z' } } }],
    warnings: [], usage: [] };
  const emptyComments = (fetchedCount: number): EvidencePacket => ({ packetId: `comments:${fetchedCount}`, kind: 'youtube_comments',
    sources: [{ id: 'youtube:XqZsoesa55w:comments', provider: 'youtube', kind: 'comments', videoId }], excerpts: [],
    artifacts: [{ type: 'youtube_comments', data: { returnedCount: 0, collection: { version: 1, fetchedCount, retainedCount: 0, morePages: false, continuationAccepted: true } } }],
    warnings: [], usage: [] });
  const captionsFailure = { toolName: 'get_video_transcript', message: 'CAPTIONS_UNAVAILABLE: Captions are not available for this video.', videoId };

  it('reports missing captions and an empty comment page, not potentially relevant videos', () => {
    const result = evidenceFallback([metadata, emptyComments(0)], 'inspect_video', undefined, undefined, [captionsFailure], [videoId])!;
    expect(result.answer).not.toContain('potentially relevant videos');
    expect(result.answer).toContain('Baby Shark Dance');
    expect(result.answer).toContain('no captions are available');
    expect(result.answer).toContain('returned no comments');
    // The claims cite the video's own metadata, so the answer is a normal cited research answer.
    expect(result.answer).toContain('[cite:video:XqZsoesa55w]');
    expect(buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
      { userId: 'user', creditsRemaining: 10 }, result, [metadata, emptyComments(0)], 0).citations).toHaveLength(1);
  });

  it('reports missing captions from a transcript failure alone', () => {
    const plain = { ...metadata, artifacts: [{ type: 'youtube_video_metadata', data: { id: videoId } }] };
    const result = evidenceFallback([plain], 'inspect_video', undefined, undefined, [captionsFailure], [videoId])!;
    expect(result.answer).toContain('no captions are available');
    expect(result.answer).not.toContain('comments');
  });

  it('does not treat a comment read with nothing retained as an empty comment page', () => {
    const plain = { ...metadata, artifacts: [{ type: 'youtube_video_metadata', data: { id: videoId } }] };
    const result = evidenceFallback([plain, emptyComments(20)], 'inspect_video', undefined, undefined, [], [videoId])!;
    expect(result.answer).not.toContain('returned no comments');
    expect(result.answer).toContain('potentially relevant videos');
  });
});

describe('uncited outcome report at the persistence check', () => {
  it('accepts only the exact regenerated report when nothing can be cited', async () => {
    const { isDurationLimitFallback } = await import('../src/agents/research/duration-limit-answer');
    const videoId = 'XqZsoesa55w';
    const emptyComments: EvidencePacket = { packetId: 'comments', kind: 'youtube_comments',
      sources: [{ id: 'youtube:XqZsoesa55w:comments', provider: 'youtube', kind: 'comments', videoId }], excerpts: [],
      artifacts: [{ type: 'youtube_comments', data: { collection: { version: 1, fetchedCount: 0, retainedCount: 0, morePages: false, continuationAccepted: true } } }],
      warnings: [], usage: [] };
    const failures = [{ toolName: 'get_video_transcript', message: 'CAPTIONS_UNAVAILABLE: Captions are not available for this video.', videoId }];
    const report = evidenceFallback([emptyComments], 'inspect_video', undefined, undefined, failures, [videoId])!;
    expect(report.answer).not.toContain('[cite:');
    const context = { failures, requestedVideoIds: [videoId] };
    expect(isDurationLimitFallback(report, [emptyComments], context)).toBe(true);
    expect(isDurationLimitFallback({ ...report, answer: `${report.answer} Viewers loved it.` }, [emptyComments], context)).toBe(false);
    // Without the recorded failure, the report cannot be regenerated, so the same text is not accepted.
    expect(isDurationLimitFallback(report, [emptyComments], { failures: [], requestedVideoIds: [videoId] })).toBe(false);
  });
});
