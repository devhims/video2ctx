import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import { SessionEvidenceStore, versionEvidencePacket } from '../src/agents/runtime/session-evidence';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { buildAgentTurnResult } from '../src/agents/finalizer';

const id = 'abcdefghijk';
function transcript(text = 'A clear opening sentence.', partial = false): Transcript {
  return {
    videoId: id,
    track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
    segments: text ? [{ startMs: 0, endMs: 5600, durationMs: 5600, text }] : [],
    text,
    meta: { source: 'allthingsyoutube', fetchedAt: '2026-09-19T00:00:00Z', partial, warnings: [] },
  };
}
function within(name: string, fn: (store: SessionEvidenceStore, reopen: () => SessionEvidenceStore) => Promise<void>) {
  return runInDurableObject(env.AGENT_RUNTIME.getByName(name), async (_instance, state) => {
    const reopen = () => new SessionEvidenceStore(state.storage.sql, env.RESEARCH, `test-session/${name}/`);
    await fn(reopen(), reopen);
  });
}
function provider(fetch = vi.fn(async () => ({ value: transcript(), cacheStatus: 'miss' as const }))) {
  return { transcript: fetch } as unknown as YouTubeAgentProvider;
}
function context(store: SessionEvidenceStore, p: YouTubeAgentProvider): AgentToolContext {
  return {
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    provider: p,
    transcriptPolicy: { mode: 'complete_transcript' },
    executeEvidenceTool: async (execution) => {
      const packet = await versionEvidencePacket(await execution.execute());
      store.savePacket(packet);
      return packet;
    },
    finalize: vi.fn(),
  };
}
test('reuses raw transcripts across runs and object reconstruction, including language alias', async () =>
  within('reuse', async (store, reopen) => {
    const p = provider();
    const first = await executeGetVideoTranscript({ videoId: id }, context(store, sessionProvider(p, store)), 'first');
    const second = await executeGetVideoTranscript(
      { videoId: id, language: 'en' },
      context(reopen(), sessionProvider(p, reopen())),
      'second',
    );
    expect(p.transcript).toHaveBeenCalledTimes(1);
    expect(first.usage[0]!.credits).toBeGreaterThan(0);
    expect(second.usage[0]!.credits).toBe(0);
    expect(second.assetVersions).toEqual(first.assetVersions);
    expect(reopen().brief().assets).toHaveLength(1);
  }));
test('coalesces concurrent transcript retrieval independently of analysis', async () =>
  within('concurrent', async (store) => {
    const p = provider();
    const wrapped = sessionProvider(p, store);
    await Promise.all([wrapped.transcript(id), wrapped.transcript(id)]);
    expect(p.transcript).toHaveBeenCalledTimes(1);
  }));
test.each([transcript('', false), transcript('Incomplete captions', true)])(
  'does not save empty or incomplete transcripts',
  async (value) =>
    within(crypto.randomUUID(), async (store) => {
      const p = provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const })));
      await sessionProvider(p, store).transcript(id);
      await sessionProvider(p, store).transcript(id);
      expect(p.transcript).toHaveBeenCalledTimes(2);
      expect(store.brief().assets).toEqual([]);
    }),
);
test('refresh bypasses provider cache once per run and preserves complete data after a partial refresh', async () =>
  within('refresh', async (store) => {
    const fetch = vi.fn(async () => ({ value: transcript(), cacheStatus: 'miss' as const }));
    const p = provider(fetch);
    await sessionProvider(p, store).transcript(id);
    fetch.mockResolvedValueOnce({ value: transcript('Updated sentence.'), cacheStatus: 'miss' });
    const fresh = sessionProvider(p, store, true);
    const updated = await fresh.transcript(id);
    await fresh.transcript(id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual([id, undefined, { refresh: true }]);
    fetch.mockResolvedValueOnce({ value: transcript('Partial', true), cacheStatus: 'miss' });
    await sessionProvider(p, store, true).transcript(id);
    const cached = await sessionProvider(p, store).transcript(id);
    expect(cached.assetVersions).toEqual(updated.assetVersions);
    expect(store.brief().assets).toHaveLength(2);
  }));
test('raw transcript survives an analyst failure, and can be read and cited by a later run', async () =>
  within('analysis-failure', async (store) => {
    const p = provider();
    const ctx = context(store, sessionProvider(p, store));
    ctx.transcriptPolicy = {
      mode: 'contextual_analysis',
      researchQuestion: 'Summarize',
      analyze: vi.fn(async () => {
        throw new Error('analysis failed');
      }),
    };
    await expect(executeGetVideoTranscript({ videoId: id, focus: 'Opening' }, ctx, 'analysis')).rejects.toThrow(
      'analysis failed',
    );
    expect(store.evidence()).toHaveLength(0);
    const result = await store.readEvidence(store.brief().assets[0]!.version);
    expect(result.packets[0]!.excerpts[0]!.text).toBe('A clear opening sentence.');
    expect(store.evidence()).toHaveLength(1);
    await sessionProvider(p, store).transcript(id);
    expect(p.transcript).toHaveBeenCalledTimes(1);
  }));
test('version-specific IDs resolve conflicting transcripts without ambiguous citations', async () =>
  within('versions', async (store) => {
    const p = provider();
    const first = await executeGetVideoTranscript({ videoId: id }, context(store, sessionProvider(p, store)), 'old');
    vi.mocked(p.transcript).mockResolvedValueOnce({
      value: transcript('A corrected opening sentence.'),
      cacheStatus: 'miss',
    });
    const second = await executeGetVideoTranscript(
      { videoId: id },
      context(store, sessionProvider(p, store, true)),
      'new',
    );
    expect(first.excerpts[0]!.id).not.toBe(second.excerpts[0]!.id);
    const citation = second.excerpts[0]!.id;
    const result = buildAgentTurnResult(
      {
        runId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        userMessageId: crypto.randomUUID(),
        agentMessageId: crypto.randomUUID(),
      },
      { userId: 'test', creditsRemaining: 100 },
      {
        intent: 'context_answer',
        answer: `Correction [cite:${citation}]`,
        confidence: 'high',
        citations: [],
        artifacts: [],
        warnings: [],
      },
      [first, second],
      0,
    );
    expect(result.citations[0]!.excerpt).toBe('A corrected opening sentence.');
  }));
test('memory validates evidence, updates a topic, and removes dependent findings on deletion', async () =>
  within('memory', async (store) => {
    const packet = await executeGetVideoTranscript(
      { videoId: id },
      context(store, sessionProvider(provider(), store)),
      'tool',
    );
    store.remember(
      'run1',
      [
        { topic: 'opening', kind: 'finding', text: 'Opening finding', evidenceIds: [packet.excerpts[0]!.id] },
        { topic: 'invalid', kind: 'finding', text: 'Unsupported', evidenceIds: ['invented'] },
        { topic: 'intent', kind: 'context', text: 'Compare speakers', evidenceIds: [] },
      ],
      [packet],
    );
    store.remember(
      'run2',
      [{ topic: 'intent', kind: 'context', text: 'Compare interviewers', evidenceIds: [] }],
      [packet],
    );
    expect(store.brief().memories).toHaveLength(2);
    expect(store.brief().memories.find((memory) => memory.topic === 'intent')!.text).toBe('Compare interviewers');
    await store.delete(packet.assetVersions![0]);
    expect(store.brief().memories.map((memory) => memory.topic)).toEqual(['intent']);
    expect(store.evidence()).toEqual([]);
    expect(await store.read(packet.assetVersions![0]!)).toBeNull();
    store.remember(
      'late',
      [{ topic: 'stale', kind: 'finding', text: 'Stale', evidenceIds: [packet.excerpts[0]!.id] }],
      [packet],
    );
    expect(store.brief().memories).toHaveLength(1);
  }));
test('deletion fences in-flight retrieval and does not resurrect assets', async () =>
  within('delete-race', async (store) => {
    let complete!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const fetch = vi.fn(async () => {
      started();
      await wait;
      return { value: transcript(), cacheStatus: 'miss' as const };
    });
    const request = sessionProvider(provider(fetch), store).transcript(id);
    await ready;
    await store.delete();
    complete();
    await expect(request).rejects.toThrow('Session assets changed');
    expect(store.brief().assets).toEqual([]);
    expect((await env.RESEARCH.list({ prefix: 'test-session/delete-race/' })).objects).toEqual([]);
  }));
test('partially successful frames are reused by timestamp while failed frames retry', async () =>
  within('frames', async (store) => {
    const frames = vi.fn(async (request: { timestampsMs: number[] }) => ({
      cacheStatus: 'miss' as const,
      value: {
        videoId: id,
        frames: [
          {
            timestampMs: request.timestampsMs[0]!,
            width: 320,
            height: 180,
            mimeType: 'image/jpeg' as const,
            imageBase64: '/9j/2Q==',
          },
        ],
        failures: request.timestampsMs
          .slice(1)
          .map((timestampMs) => ({ timestampMs, code: 'FAILED', message: 'Unavailable', retryable: true })),
        meta: { partial: request.timestampsMs.length > 1, warnings: [] },
      },
    }));
    const p = { frames } as unknown as YouTubeAgentProvider;
    await sessionProvider(p, store).frames!(
      { videoId: id, timestampsMs: [1000, 2000], maxWidth: 320 },
      new AbortController().signal,
    );
    const result = await sessionProvider(p, store).frames!(
      { videoId: id, timestampsMs: [1000, 2000], maxWidth: 320 },
      new AbortController().signal,
    );
    expect(frames.mock.calls.map((call) => call[0].timestampsMs)).toEqual([[1000, 2000], [2000]]);
    expect(result.value.frames).toHaveLength(2);
    expect(result.value.failures).toEqual([]);
  }));

test('storyboard selections batch missing sheets and reuse overlapping sheets across runs', async () =>
  within('storyboards', async (store) => {
    const base = {
      videoId: id,
      frameCount: 6,
      intervalMs: 5000,
      manifest: {
        totalSheets: 3,
        framesPerSheet: 2,
        tileWidth: 100,
        tileHeight: 100,
        columns: 2,
        rows: 1,
        lastSampleMs: 25000,
      },
      meta: { partial: false, warnings: [] },
    };
    const storyboard = vi.fn(
      async (_id: string, _times: unknown, options: { metadataOnly?: boolean; sheetIndexes?: number[] }) => ({
        cacheStatus: 'miss' as const,
        value: {
          ...base,
          selection: { mode: options.metadataOnly ? ('metadata' as const) : ('indexes' as const) },
          sheets: options.metadataOnly
            ? []
            : options.sheetIndexes!.map((index) => ({
                firstFrameIndex: index * 2,
                frameCount: 2,
                tileWidth: 100,
                tileHeight: 100,
                columns: 2,
                rows: 1,
                intervalMs: 5000,
                imageBase64: '/9j/2Q==',
              })),
        },
      }),
    );
    const p = { storyboard } as unknown as YouTubeAgentProvider;
    await sessionProvider(p, store).storyboard!(id, undefined, { sheetIndexes: [0, 1], maxSheets: 2 });
    await sessionProvider(p, store).storyboard!(id, undefined, { sheetIndexes: [1, 2], maxSheets: 2 });
    expect(storyboard.mock.calls.map((call) => call[2])).toEqual([
      { metadataOnly: true },
      { sheetIndexes: [0, 1], maxSheets: 2 },
      { sheetIndexes: [2], maxSheets: 1 },
    ]);
    await expect(sessionProvider(p, store).storyboard!(id, undefined, { sheetIndexes: [3] })).rejects.toThrow(
      'Invalid storyboard selection',
    );
    expect(storyboard).toHaveBeenCalledTimes(3);
    expect(store.brief().assets.filter((asset) => asset.kind === 'storyboard_sheet')).toHaveLength(3);
  }));

test('forgetting memory during a run prevents that run from restoring its stale snapshot', async () =>
  within('memory-forget-race', async (store) => {
    store.remember('before', [{ kind: 'context', topic: 'intent', text: 'Old preference', evidenceIds: [] }], []);
    store.beginRun('active');
    store.deleteMemory('context:intent');
    store.remember('active', [{ kind: 'context', topic: 'intent', text: 'Old preference', evidenceIds: [] }], []);
    expect(store.brief().memories).toEqual([]);
    store.beginRun('next');
    store.remember(
      'next',
      [{ kind: 'context', topic: 'intent', text: 'New explicit preference', evidenceIds: [] }],
      [],
    );
    expect(store.brief().memories[0]!.text).toBe('New explicit preference');
  }));

test('refreshing a resolved language advances the compatible default alias and marks the old version historical', async () =>
  within('alias-refresh', async (store) => {
    const p = provider();
    const old = await sessionProvider(p, store).transcript(id);
    vi.mocked(p.transcript).mockResolvedValueOnce({ value: transcript('Fresh English captions'), cacheStatus: 'miss' });
    const latest = await sessionProvider(p, store, true).transcript(id, 'en');
    const reuse = await sessionProvider(p, store).transcript(id);
    expect(reuse.assetVersions).toEqual(latest.assetVersions);
    expect(reuse.value.text).toBe('Fresh English captions');
    expect(p.transcript).toHaveBeenCalledTimes(2);
    expect(store.brief().assets.find((asset) => asset.version === old.assetVersions![0])!.current).toBe(false);
  }));
