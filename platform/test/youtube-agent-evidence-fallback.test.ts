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

describe('pinned video caption gap (QA 020)', () => {
  const checkedAt = '2026-10-05T22:30:00.000Z';
  const metadata = (captionAvailability: Record<string, unknown>, availability: Record<string, unknown> = { status: 'available' }): EvidencePacket => ({
    packetId: 'metadata', kind: 'youtube_video',
    sources: [{ id: 'youtube:video:jNQXAC9IVRw', provider: 'youtube', kind: 'video', videoId: 'jNQXAC9IVRw', title: 'Me at the zoo' }],
    excerpts: [{ id: 'video:jNQXAC9IVRw:initial', sourceId: 'youtube:video:jNQXAC9IVRw', text: 'Me at the zoo' }],
    artifacts: [{ type: 'youtube_video_metadata', data: { id: 'jNQXAC9IVRw', captionAvailability, availability } }],
    warnings: [], usage: [],
  });
  const absent = metadata({ status: 'unavailable', languages: [], checkedAt });

  it('explains metadata-confirmed caption absence with pinned-video wording', () => {
    const result = evidenceFallback([absent], 'inspect_video', 'Finalization failed.', undefined,
      { videoId: 'jNQXAC9IVRw', captionsUnavailable: true })!;
    expect(result.answer).toContain('I retrieved metadata for the requested video');
    expect(result.answer).toContain('Requested video, metadata only:');
    expect(result.answer).not.toContain('potentially relevant videos');
    expect(result.warnings[0]).toEqual({ code: 'CAPTIONS_UNAVAILABLE', videoId: 'jNQXAC9IVRw',
      message: `YouTube metadata checked at ${checkedAt} reported no caption tracks for this video, so its transcript was not retrieved in this run. That observation does not prove captions are permanently unavailable.` });
    expect(result.warnings.map(warning => warning.code)).toEqual(['CAPTIONS_UNAVAILABLE', 'PARTIAL_EVIDENCE', 'NO_CONTENT_EVIDENCE']);
  });

  it.each([
    ['unknown caption status', metadata({ status: 'unknown', languages: [] }), { captionsUnavailable: false }],
    ['a stale absence this run did not confirm', absent, { captionsUnavailable: false }],
    ['an absence recorded only by a transcript error', metadata({ status: 'unknown', languages: [], checkedAt }), { captionsUnavailable: true }],
  ])('adds no caption warning for %s', (_label, packet, access) => {
    const result = evidenceFallback([packet], 'inspect_video', undefined, undefined, { videoId: 'jNQXAC9IVRw', ...access })!;
    expect(result.warnings.map(warning => warning.code)).toEqual(['PARTIAL_EVIDENCE', 'NO_CONTENT_EVIDENCE']);
  });

  it('keeps a country restriction distinct from caption absence', () => {
    const restricted = metadata({ status: 'unknown', languages: [] }, { status: 'available', restriction: 'region' });
    const result = evidenceFallback([restricted], 'inspect_video', undefined, undefined,
      { videoId: 'jNQXAC9IVRw', regionRestricted: true, captionsUnavailable: true })!;
    expect(result.warnings.map(warning => warning.code)).toEqual(['REGION_RESTRICTED', 'PARTIAL_EVIDENCE', 'NO_CONTENT_EVIDENCE']);
    expect(result.warnings[0]!.message).toContain('not evidence that captions are absent');
  });

  it('does not duplicate a skip already reported by the transcript tool', () => {
    const skipped: EvidencePacket = { ...packet, packetId: 'skipped', sources: [], excerpts: [], artifacts: [], usage: [],
      warnings: [{ code: 'CAPTIONS_UNAVAILABLE', videoId: 'jNQXAC9IVRw', message: 'Caption absence was already confirmed. Retrieval was skipped.' }] };
    const result = evidenceFallback([absent, skipped], 'inspect_video', undefined, undefined, { videoId: 'jNQXAC9IVRw', captionsUnavailable: true })!;
    expect(result.warnings.filter(warning => warning.code === 'CAPTIONS_UNAVAILABLE')).toEqual([skipped.warnings[0]]);
  });

  it('keeps discovery wording for topic research', () => {
    const result = evidenceFallback([absent], 'topic_research')!;
    expect(result.answer).toContain('I found potentially relevant videos');
    expect(result.warnings.map(warning => warning.code)).toEqual(['PARTIAL_EVIDENCE', 'NO_CONTENT_EVIDENCE']);
  });
});
