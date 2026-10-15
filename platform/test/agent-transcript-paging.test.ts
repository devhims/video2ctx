import type { Transcript } from 'all-things-youtube';
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';

function transcript(videoId: string, count: number): Transcript {
  const segments = Array.from({ length: count }, (_, index) => ({ startMs: index * 2_000, endMs: index * 2_000 + 2_000, durationMs: 2_000, text: `Caption ${index}.` }));
  return {
    videoId, segments, text: segments.map(segment => segment.text).join(' '),
    track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
    meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-15T00:00:00Z', partial: false, warnings: [] },
  };
}

function context(count: number) {
  const keys: string[] = [];
  const ctx = {
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    provider: { transcript: vi.fn(async (videoId: string) => ({ cacheStatus: 'hit' as const, value: transcript(videoId, count), assetVersions: ['a'.repeat(64)] })) },
    transcriptSelection: { allowReplacement: true, attempted: new Set(), unavailable: new Set(), regionRestricted: new Set() },
    transcriptPolicy: { mode: 'complete_transcript' },
    executeEvidenceTool: async (execution: { semanticKey: string; execute: () => Promise<unknown> }) => { keys.push(execution.semanticKey); return execution.execute(); },
    finalize: vi.fn(),
  } as unknown as AgentToolContext;
  return { ctx, keys };
}

describe('transcript paging', () => {
  it('returns the whole page containing a model-chosen offset, so earlier captions are never cut', async () => {
    // Run 0bb4aadb asked for offset 300 of a 536-caption transcript and lost the passage it needed at caption 141.
    const { ctx, keys } = context(536);
    const packet = await executeGetVideoTranscript({ videoId: 'HSRmfNDk87s', offset: 300 }, ctx, 'follow-up');
    expect(packet.excerpts).toHaveLength(536);
    expect(packet.excerpts[141]?.text).toBe('Caption 141.');
    expect(packet.warnings.map(warning => warning.code)).not.toContain('TRANSCRIPT_CONTEXT_TRUNCATED');
    expect(packet.artifacts[0]?.data).toMatchObject({ offset: 0, allReturnedSegmentsIncluded: true });
    await executeGetVideoTranscript({ videoId: 'HSRmfNDk87s' }, ctx, 'full');
    expect(keys[0]).toBe(keys[1]);
  });

  it('still pages long transcripts at page boundaries', async () => {
    const { ctx } = context(6_000);
    const first = await executeGetVideoTranscript({ videoId: 'abcdefghijk' }, ctx, 'first');
    expect(first.excerpts).toHaveLength(5_000);
    expect(first.artifacts[0]?.data).toMatchObject({ offset: 0, nextOffset: 5_000 });
    for (const offset of [5_000, 5_300]) {
      const next = await executeGetVideoTranscript({ videoId: 'abcdefghijk', offset }, ctx, `page-${offset}`);
      expect(next.excerpts).toHaveLength(1_000);
      expect(next.excerpts[0]?.text).toBe('Caption 5000.');
      expect(next.artifacts[0]?.data).toMatchObject({ offset: 5_000 });
    }
  });
});
