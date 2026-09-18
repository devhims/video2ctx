import { describe, expect, it } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import {
  evidencePacketForModel,
  finalizationEvidenceForModel,
  evidencePacketsForModel,
} from '../src/agents/runtime/model-evidence';

describe('agent model evidence', () => {
  it('preserves every direct transcript excerpt through recovery and finalization', () => {
    const packet = transcriptPacket();
    packet.artifacts = [{ type: 'youtube_complete_transcript', data: { allReturnedSegmentsIncluded: true } }];
    packet.excerpts = Array.from({ length: 12 }, (_, index) => ({ ...packet.excerpts[0]!, id: `caption:${index}`, text: `Location ${index}: ` + 'x'.repeat(1000) }));
    const projected = evidencePacketForModel(packet);
    expect(projected.excerpts).toEqual(packet.excerpts);
    const finalization = finalizationEvidenceForModel([packet], 40_000);
    expect(finalization.evidence[0]!.excerpts).toHaveLength(12);
    expect(finalization.evidence[0]!.excerpts![11]!.text).toBe(packet.excerpts[11]!.text);
    expect(finalization.fullIds.get('ref_12')).toBe('caption:11');
  });
  it('reports partial context when a complete transcript exceeds the finalization budget', () => {
    const packet = transcriptPacket();
    packet.artifacts = [{ type: 'youtube_complete_transcript', data: {} }];
    packet.excerpts = Array.from({ length: 100 }, (_, index) => ({ ...packet.excerpts[0]!, id: `caption:${index}`, text: 'x'.repeat(2000) }));
    const projected = evidencePacketsForModel([packet], { maxCharacters: 40_000 });
    expect(projected[0]!.warnings).toContainEqual(expect.objectContaining({ code: 'TRANSCRIPT_CONTEXT_TRUNCATED' }));
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(40_000);
  });

  it('replaces transcript text with the query-focused analyst result', () => {
    const packet = transcriptPacket();

    const result = evidencePacketForModel(packet);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('RAW TRANSCRIPT WINDOW');
    expect(result).toMatchObject({
      packetId: packet.packetId,
      kind: 'youtube_transcript',
      transcriptAnalysis: {
        summary: 'The video recommends a small set of concrete frontend skills.',
        findings: [{
          claim: 'TypeScript and component testing are the strongest recommendations.',
          excerptIds: ['transcript:abcdefghijk:window:3:180000'],
        }],
        coverage: {
          completeTranscriptRead: true,
          segmentCount: 400,
        },
        selectedExcerptCount: 1,
      },
    });
  });

  it('uses short recovery references without changing persisted evidence', () => {
    const packet = transcriptPacket();
    const before = JSON.stringify(packet);
    const { evidence, fullIds } = finalizationEvidenceForModel([packet], 40_000);
    const id = evidence[0]!.transcriptAnalysis!.findings[0]!.excerptIds[0]!;
    expect(id).toBe('ref_1');
    expect(fullIds.get(id)).toBe('transcript:abcdefghijk:window:3:180000');
    expect(JSON.stringify(packet)).toBe(before);
  });

  it('bounds the combined finalizer payload instead of forwarding every packet in full', () => {
    const packets = Array.from({ length: 20 }, (_, index) => ({
      ...transcriptPacket(),
      packetId: `packet:run:transcript-${index}`,
      artifacts: [{
        ...transcriptPacket().artifacts[0]!,
        data: {
          ...transcriptPacket().artifacts[0]!.data,
          summary: `Summary ${index} ${'context '.repeat(1_000)}`,
        },
      }],
    }));

    const result = evidencePacketsForModel(packets, { maxCharacters: 12_000 });
    const serialized = JSON.stringify(result);

    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(serialized).not.toContain('RAW TRANSCRIPT WINDOW');
    expect(result.length).toBeGreaterThan(0);
  });
});

function transcriptPacket(): EvidencePacket {
  return {
    packetId: 'packet:run:transcript',
    kind: 'youtube_transcript',
    sources: [{
      id: 'youtube:abcdefghijk:transcript',
      provider: 'youtube',
      kind: 'transcript',
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    }],
    excerpts: [{
      id: 'transcript:abcdefghijk:window:3:180000',
      sourceId: 'youtube:abcdefghijk:transcript',
      text: 'RAW TRANSCRIPT WINDOW that remains available for citation validation.',
      startMs: 180_000,
      endMs: 240_000,
    }],
    artifacts: [{
      type: 'youtube_transcript_analysis',
      title: 'Complete transcript analysis for abcdefghijk',
      data: {
        videoId: 'abcdefghijk',
        summary: 'The video recommends a small set of concrete frontend skills.',
        findings: [{
          claim: 'TypeScript and component testing are the strongest recommendations.',
          excerptIds: ['transcript:abcdefghijk:window:3:180000'],
        }],
        coverage: {
          completeTranscriptRead: true,
          segmentCount: 400,
          startMs: 0,
          endMs: 2_400_000,
        },
        selectedExcerptCount: 1,
      },
    }],
    warnings: [],
    usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'miss' }],
  };
}
