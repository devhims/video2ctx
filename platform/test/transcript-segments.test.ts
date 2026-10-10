import { describe, expect, it } from 'vitest';
import { flatTranscript, requestedTranscriptTimes, transcriptContextIndexes } from '../src/agents/runtime/transcript-segments';
import { completeTranscriptEvidence, executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import { finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';
import { versionEvidencePacket } from '../src/agents/runtime/session-evidence';
import type { EvidencePacket } from '../src/agents/contracts';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';

const segments = Array.from({ length: 15 }, (_, index) => ({ text: `Caption ${index}`, startMs: index * 1000, durationMs: 1500, endMs: index * 1000 + 1500 }));
const videoId = 'abcdefghijk';
const sourceId = `youtube:${videoId}:transcript`;
function packet(): EvidencePacket {
  return { packetId: 'p', kind: 'youtube_transcript', sources: [{ id: sourceId, provider: 'youtube', kind: 'transcript', videoId }],
    excerpts: completeTranscriptEvidence(videoId, segments, sourceId).excerpts,
    assetVersions: ['a'.repeat(64)], artifacts: [{ type: 'youtube_complete_transcript', data: {} }], warnings: [], usage: [] };
}

describe('original segment references', () => {
  it('keeps original indexes and exact whitespace and long caption text in stored evidence', () => {
    const original = [{ ...segments[0]!, text: '' }, { ...segments[1]!, text: '  first\nsecond ' + 'x'.repeat(3000) }];
    const evidence = completeTranscriptEvidence(videoId, original, sourceId);
    expect(evidence.excerpts).toEqual([{ id: `transcript:${videoId}:segment:1`, sourceId, text: original[1]!.text, startMs: 1000, endMs: 2500 }]);
    expect(flatTranscript(original)).toContain('1   first second ');
  });

  it('keeps the same versioned anchor through full and selective reads, with distinct versions isolated', async () => {
    const full = await versionEvidencePacket(packet());
    const partial = await versionEvidencePacket({ ...packet(), packetId: 'time', excerpts: [packet().excerpts[7]!] });
    expect(partial.excerpts[0]).toEqual(full.excerpts[7]);
    expect(finalizationEvidenceForModel([partial], 40000).fullIds.get('ref_7')).toBe(full.excerpts[7]!.id);
    expect(finalizationEvidenceForModel([full, partial], 40000).fullIds.get('ref_7')).toBe(full.excerpts[7]!.id);
    const changed = await versionEvidencePacket({ ...packet(), assetVersions: ['b'.repeat(64)] });
    expect(changed.excerpts[7]!.id).not.toBe(full.excerpts[7]!.id);
    const projected = finalizationEvidenceForModel([full, changed], 160000);
    expect(projected.fullIds.size).toBe(30);
    expect(projected.evidence[0]!.transcript!.text.split('\n')).toHaveLength(15);
  });

  it('excludes aliases whose captions did not fit the model budget', () => {
    const p = packet();
    p.excerpts = p.excerpts.map(excerpt => ({ ...excerpt, text: 'x'.repeat(3000) }));
    const projected = finalizationEvidenceForModel([p], 10000);
    const lines = projected.evidence[0]!.transcript!.text.split('\n');
    expect(projected.fullIds.size).toBe(lines.length);
    expect(projected.fullIds.size).toBeLessThan(15);
    expect(JSON.stringify(projected.evidence).length).toBeLessThanOrEqual(10000);
  });
});

describe('timestamp transcript context', () => {
  it('returns all overlapping captions plus three neighbors on each side', () => {
    expect(transcriptContextIndexes(segments, 7.2)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(transcriptContextIndexes(segments, 7.2, 0, 0)).toEqual([6, 7]);
  });
  it('handles boundaries, gaps, invalid input, and requests beyond the transcript', () => {
    expect(transcriptContextIndexes(segments, 0)).toEqual([0, 1, 2, 3]);
    expect(transcriptContextIndexes(segments, 14.2)).toEqual([10, 11, 12, 13, 14]);
    expect(transcriptContextIndexes(segments, 100)).toEqual([]);
    expect(transcriptContextIndexes([], 1)).toEqual([]);
    expect(transcriptContextIndexes([{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 4000 }], 2)).toEqual([0, 1]);
    expect(() => transcriptContextIndexes(segments, NaN)).toThrow();
    expect(() => transcriptContextIndexes(segments, 1, 11)).toThrow();
  });
  it('recognizes playback clocks without interpreting video URLs or numeric IDs as time', () => {
    expect(requestedTranscriptTimes('Explain 17:20 and 1:18:30.')).toEqual([1040, 4710]);
    expect(requestedTranscriptTimes('Explain segment 201 https://example.com/12:30')).toEqual([]);
  });
  it('persists only the selected neighborhood and exposes timing only for that selection', async () => {
    const executions: string[] = [];
    const context = {
      runId: 'test', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
      provider: { transcript: async () => ({ cacheStatus: 'hit', sessionReused: true, assetVersions: ['a'.repeat(64)], value: {
        segments, track: {}, meta: { warnings: [], partial: false },
      } }) },
      executeEvidenceTool: async (execution: { toolName: string; execute: () => Promise<EvidencePacket> }) => { executions.push(execution.toolName); return execution.execute(); },
    } as unknown as AgentToolContext;
    const result = await executeGetVideoTranscript({ videoId }, context, 'time', { timestampSeconds: 7.2 });
    expect(executions).toEqual(['get_transcript_context']);
    expect(result.excerpts.map(excerpt => excerpt.text)).toEqual(segments.slice(3, 11).map(segment => segment.text));
    expect(result.artifacts[0]!.data).toMatchObject({ hasSpeechAtTimestamp: true, allReturnedSegmentsIncluded: false });
    const projected = finalizationEvidenceForModel([result], 40000).evidence[0]!;
    expect(projected.transcript?.timing).toHaveLength(8);
    expect(projected.transcript?.text).not.toContain('Caption 14');
  });
});
