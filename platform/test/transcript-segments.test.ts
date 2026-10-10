import { describe, expect, it } from 'vitest';
import { flatTranscript, hasSpeechAtTimestamp, MAX_TRANSCRIPT_SEGMENT_CHARACTERS, timestampVideoBounds, transcriptContextIndexes } from '../src/agents/runtime/transcript-segments';
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
  it('defaults to ten neighbors on each side and supports smaller counts', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 1500 }));
    expect(transcriptContextIndexes(long, 20.2)).toEqual(Array.from({ length: 22 }, (_, i) => i + 9));
    expect(transcriptContextIndexes(segments, 7.2, 3, 3)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(transcriptContextIndexes(segments, 7.2, 0, 0)).toEqual([6, 7]);
  });
  it('handles boundaries, gaps, invalid input, and requests beyond the transcript', () => {
    expect(transcriptContextIndexes(segments, 0)).toEqual(Array.from({ length: 11 }, (_, i) => i));
    expect(transcriptContextIndexes(segments, 14.2)).toEqual(Array.from({ length: 12 }, (_, i) => i + 3));
    expect(transcriptContextIndexes(segments, 100)).toEqual([]);
    expect(transcriptContextIndexes([], 1)).toEqual([]);
    expect(transcriptContextIndexes([{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 4000 }], 2)).toEqual([0, 1]);
    expect(() => transcriptContextIndexes(segments, NaN)).toThrow();
    expect(() => transcriptContextIndexes(segments, 1, 11)).toThrow();
  });
  it('shares speech overlap rules and omits oversized captions without changing IDs', () => {
    expect(hasSpeechAtTimestamp(segments, 7.2)).toBe(true);
    expect(hasSpeechAtTimestamp(segments, 20)).toBe(false);
    const original = [{ ...segments[0]!, text: 'x'.repeat(MAX_TRANSCRIPT_SEGMENT_CHARACTERS + 1) }, segments[1]!];
    const evidence = completeTranscriptEvidence(videoId, original, sourceId);
    expect(evidence.excerpts.map(excerpt => excerpt.id)).toEqual([`transcript:${videoId}:segment:1`]);
    expect(evidence.warnings[0]?.code).toBe('TRANSCRIPT_SEGMENT_TOO_LARGE');
    expect(flatTranscript(original)).toBe('1 Caption 1');
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
    expect(result.excerpts.map(excerpt => excerpt.text)).toEqual(segments.map(segment => segment.text));
    expect(result.artifacts[0]!.data).toMatchObject({ hasSpeechAtTimestamp: true, allReturnedSegmentsIncluded: false });
    const projected = finalizationEvidenceForModel([result], 40000).evidence[0]!;
    expect(projected.transcript?.timing).toHaveLength(15);
    expect(projected.transcript?.text).toContain('Caption 14');
  });
});
it('projects an empty live timestamp lookup as citable status without caption timing', async () => {
  const context = { runId: 'test', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
    provider: { transcript: async () => ({ cacheStatus: 'hit', assetVersions: ['a'.repeat(64)], value: {
      segments, track: {}, meta: { warnings: [], partial: false },
    } }) },
    executeEvidenceTool: async (execution: { execute: () => Promise<EvidencePacket> }) => versionEvidencePacket(await execution.execute()),
  } as unknown as AgentToolContext;
  const result = await executeGetVideoTranscript({ videoId }, context, 'outside', { timestampSeconds: 2700 });
  expect(result.excerpts[0]!.text).toContain('Transcript lookup status');
  expect(result.excerpts[0]!.startMs).toBeUndefined();
  const projected = finalizationEvidenceForModel([result], 40000).evidence[0]!;
  expect(projected.transcript?.text).toBe('');
  expect(projected.transcript?.timing).toEqual([]);
  expect(projected.excerpts![0]!.text).toBe(result.excerpts[0]!.text);
});

it('computes playback bounds from matching metadata, without inferring duration from captions', () => {
  const context = packet();
  context.artifacts = [{ type: 'youtube_transcript_context', data: { timestampSeconds: 2700 } }];
  const metadata = { ...packet(), artifacts: [{ type: 'youtube_video_metadata', data: { id: videoId, durationSeconds: 1800 } }] };
  expect(timestampVideoBounds([context])).toEqual([]);
  expect(timestampVideoBounds([context, metadata])).toEqual([{ videoId, timestampSeconds: 2700, durationSeconds: 1800, position: 'after the reported video end' }]);
  context.artifacts[0]!.data.timestampSeconds = 1800;
  expect(timestampVideoBounds([context, metadata])[0]!.position).toBe('at the reported video end');
  context.artifacts[0]!.data.timestampSeconds = 120;
  expect(timestampVideoBounds([context, metadata])[0]!.position).toBe('within the reported video duration');
  expect(timestampVideoBounds([context, metadata, { ...metadata, artifacts: [{ type: 'youtube_video_metadata', data: { id: videoId, durationSeconds: 3600 } }] }])).toEqual([]);
  const mixed = { ...context, sources: [...context.sources, { ...context.sources[0]!, id: 'other', videoId: 'otherVideo1' }] };
  expect(timestampVideoBounds([mixed, metadata])).toEqual([]);
  mixed.artifacts = [{ type: 'youtube_transcript_context', data: { timestampSeconds: 2700, videoId: 'otherVideo1' } }];
  expect(timestampVideoBounds([mixed, metadata])).toEqual([]);
});
