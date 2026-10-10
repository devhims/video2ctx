import { extractionFixture } from './fixtures/extraction-diagnostic';
import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { executeAnalyzeVideoFrames } from '../src/agents/providers/youtube/tools/analyze-video-frames';
import { executeAnalyzeVideoStoryboard } from '../src/agents/providers/youtube/tools/analyze-video-storyboard';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import type { Transcript } from 'all-things-youtube';
import { SessionEvidenceStore, versionEvidencePacket } from '../src/agents/runtime/session-evidence';
import { remember } from './fixtures/memory';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { buildAgentTurnResult } from '../src/agents/finalizer';

function visualGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function oneSheet(videoId: string) {
  return { videoId, frameCount: 2, intervalMs: 5000,
    manifest: { totalSheets: 1, framesPerSheet: 2, tileWidth: 100, tileHeight: 100,
      columns: 2, rows: 1, lastSampleMs: 5000 },
    selection: { mode: 'spread' as const },
    sheets: [{ firstFrameIndex: 0, frameCount: 2, tileWidth: 100, tileHeight: 100,
      columns: 2, rows: 1, intervalMs: 5000, imageBase64: '/9j/2Q==' }],
    meta: { partial: false, warnings: [] } };
}

function oneFrame(videoId: string) {
  return { videoId, frames: [{ timestampMs: 1000, width: 640, height: 360,
    mimeType: 'image/jpeg' as const, imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } };
}

function retrieveVisual(p: YouTubeAgentProvider, kind: 'storyboard' | 'frames', videoId: string, signal?: AbortSignal) {
  return kind === 'storyboard' ? p.storyboard!(videoId, undefined, { maxSheets: 1, signal })
    : p.frames!({ videoId, timestampsMs: [1000], maxWidth: 640 }, signal);
}

test.each([
  ['storyboard', 'storyboard'], ['frames', 'storyboard'], ['storyboard', 'frames'],
] as const)('different-video %s/%s retrievals complete independently while the first extraction is blocked', async (firstKind, secondKind) =>
  within(`parallel-${firstKind}-${secondKind}`, async (store, reopen) => {
    const held = visualGate(), firstStarted = visualGate();
    const secondId = 'lmnopqrstuv';
    const fetched = vi.fn(async (videoId: string) => {
      if (videoId === id) { firstStarted.release(); await held.promise; }
    });
    const upstream = {
      storyboard: async (videoId: string) => { await fetched(videoId); return { cacheStatus: 'miss', value: oneSheet(videoId) }; },
      frames: async ({ videoId }: { videoId: string }) => { await fetched(videoId); return { cacheStatus: 'miss', value: oneFrame(videoId) }; },
    } as unknown as YouTubeAgentProvider;
    const p = sessionProvider(upstream, store);
    const first = retrieveVisual(p, firstKind, id);
    await firstStarted.promise;
    let secondDone = false;
    const second = retrieveVisual(p, secondKind, secondId).then(value => { secondDone = true; return value; });
    try {
      await vi.waitFor(() => expect(secondDone).toBe(true), { timeout: 1000 });
      expect(fetched).toHaveBeenCalledTimes(2);
      expect((await second).value.videoId).toBe(secondId);
    } finally {
      held.release();
      await Promise.allSettled([first, second]);
    }
    const count = (kind: string) => kind === 'storyboard' ? 2 : 1;
    expect(reopen().brief().assets).toHaveLength(count(firstKind) + count(secondKind));
    const restored = sessionProvider(upstream, reopen());
    await Promise.all([retrieveVisual(restored, firstKind, id), retrieveVisual(restored, secondKind, secondId)]);
    expect(fetched).toHaveBeenCalledTimes(2);
  }));

test('different-video frame requests keep the previous single-job session limit', async () =>
  within('serial-frame-capacity', async store => {
    const held = visualGate(), entered = visualGate();
    const frames = vi.fn(async ({ videoId }: { videoId: string }) => {
      if (videoId === id) { entered.release(); await held.promise; }
      return { cacheStatus: 'miss', value: oneFrame(videoId) };
    });
    const p = sessionProvider({ frames } as unknown as YouTubeAgentProvider, store);
    const first = retrieveVisual(p, 'frames', id);
    await entered.promise;
    const second = retrieveVisual(p, 'frames', 'lmnopqrstuv');
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(frames).toHaveBeenCalledTimes(1);
    } finally { held.release(); await Promise.allSettled([first, second]); }
    expect(frames).toHaveBeenCalledTimes(2);
  }));

test('same-video storyboard and frame requests stay ordered without blocking another video', async () =>
  within('same-video-visual-order', async (store) => {
    const held = visualGate(), started = visualGate();
    const frames = vi.fn(async ({ videoId }: { videoId: string }) => ({ cacheStatus: 'miss', value: oneFrame(videoId) }));
    const p = sessionProvider({
      storyboard: async (videoId: string) => { started.release(); await held.promise; return { cacheStatus: 'miss', value: oneSheet(videoId) }; },
      frames,
    } as unknown as YouTubeAgentProvider, store);
    const first = retrieveVisual(p, 'storyboard', id);
    await started.promise;
    const sameVideo = retrieveVisual(p, 'frames', id);
    const otherVideo = retrieveVisual(p, 'frames', 'lmnopqrstuv');
    try {
      await otherVideo;
      expect(frames.mock.calls.map(([request]) => request.videoId)).toEqual(['lmnopqrstuv']);
    } finally { held.release(); await Promise.allSettled([first, sameVideo, otherVideo]); }
    expect(frames.mock.calls.map(([request]) => request.videoId)).toEqual(['lmnopqrstuv', id]);
  }));

test.each([false, true])('overlapping same-video frame requests reuse one extraction with refresh=%s', async refresh =>
  within(`parallel-frame-reuse-${refresh}`, async (store) => {
    const held = visualGate(), started = visualGate();
    const frames = vi.fn(async ({ videoId }: { videoId: string }) => {
      started.release();
      await held.promise;
      return { cacheStatus: 'miss', value: oneFrame(videoId) };
    });
    const p = sessionProvider({ frames } as unknown as YouTubeAgentProvider, store, refresh);
    const first = retrieveVisual(p, 'frames', id, new AbortController().signal);
    await started.promise;
    const second = retrieveVisual(p, 'frames', id, new AbortController().signal);
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(frames).toHaveBeenCalledOnce();
    expect(b.assetVersions).toEqual(a.assetVersions);
    expect(b.sessionReused).toBe(true);
  }));

test('session deletion invalidates active and queued visual requests without republishing assets', async () =>
  within('parallel-visual-deletion', async (store, reopen) => {
    const held = visualGate(), bothStarted = visualGate();
    let calls = 0;
    const upstream = vi.fn(async (videoId: string) => {
      if (++calls === 2) bothStarted.release();
      await held.promise;
      return { cacheStatus: 'miss', value: oneSheet(videoId) };
    });
    const p = sessionProvider({ storyboard: upstream } as unknown as YouTubeAgentProvider, store);
    const pending = [id, 'lmnopqrstuv', 'wxyzABCDEFG'].map(videoId => retrieveVisual(p, 'storyboard', videoId));
    const settled = Promise.allSettled(pending);
    await bothStarted.promise;
    try { await store.delete(); } finally { held.release(); }
    const results = await settled;
    expect(upstream).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason.message).toContain('Session assets changed');
    }
    expect(reopen().brief().assets).toHaveLength(0);
    expect((await env.RESEARCH.list({ prefix: 'test-session/parallel-visual-deletion/' })).objects).toHaveLength(0);
  }));

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
function within(
  name: string,
  fn: (store: SessionEvidenceStore, reopen: () => SessionEvidenceStore, sql: SqlStorage) => Promise<void>,
) {
  return runInDurableObject(env.AGENT_RUNTIME.getByName(name), async (_instance, state) => {
    const reopen = () => new SessionEvidenceStore(state.storage.sql, env.RESEARCH, `test-session/${name}/`);
    await fn(reopen(), reopen, state.storage.sql);
  });
}
function provider(fetch = vi.fn(async () => ({ value: transcript(), cacheStatus: 'miss' as const }))) {
  return { transcript: fetch } as unknown as YouTubeAgentProvider;
}
function context(store: SessionEvidenceStore, p: YouTubeAgentProvider): AgentToolContext {
  const packets: EvidencePacket[] = [];
  return {
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    provider: p,
    session: store,
    getEvidence: () => packets,
    transcriptPolicy: { mode: 'complete_transcript' },
    executeEvidenceTool: async (execution) => {
      const packet = await versionEvidencePacket(await execution.execute());
      store.savePacket(packet);
      packets.push(packet);
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
    // A later run that receives the saved transcript pays its cached table price;
    // the run ledger deduplicates repeated reads inside that run.
    expect(second.usage[0]).toMatchObject({ operation: 'transcript', credits: 1, reuse: 'session' });
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
    expect(fetch.mock.calls[1]).toEqual([id, undefined, { refresh: true }, undefined]);
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
    const retrieved = await executeGetVideoTranscript({ videoId: id }, ctx, 'retrieve');
    expect(ctx.transcriptPolicy.analyze).not.toHaveBeenCalled();
    await expect(executeAnalyzeVideoTranscript({ assetVersion: retrieved.assetVersions![0]!, focus: 'Opening' }, ctx, 'analysis')).rejects.toThrow('analysis failed');
    expect(await store.evidence()).toHaveLength(1);
    const result = await store.readEvidence(store.brief().assets[0]!.version);
    expect(result.packets[0]!.excerpts[0]!.text).toBe('A clear opening sentence.');
    expect(await store.evidence()).toHaveLength(2);
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
    remember(store,
      'run1',
      [
        { topic: 'opening', kind: 'finding', text: 'Opening finding', evidenceIds: [packet.excerpts[0]!.id] },
        { topic: 'invalid', kind: 'finding', text: 'Unsupported', evidenceIds: ['invented'] },
        { topic: 'intent', kind: 'context', text: 'Compare speakers', evidenceIds: [] },
      ],
      [packet],
    );
    remember(store,
      'run2',
      [{ topic: 'intent', kind: 'context', text: 'Compare interviewers', evidenceIds: [] }],
      [packet],
    );
    expect(store.brief().memories).toHaveLength(2);
    expect(store.brief().memories.find((memory) => memory.topic === 'intent')!.text).toBe('Compare interviewers');
    await store.delete(packet.assetVersions![0]);
    expect(store.brief().memories.map((memory) => memory.topic)).toEqual(['intent']);
    expect(await store.evidence()).toEqual([]);
    expect(await store.read(packet.assetVersions![0]!)).toBeNull();
    remember(store,
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
  within('storyboards', async (store, reopen) => {
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
      { sheetIndexes: [0, 1], maxSheets: 2 },
      { sheetIndexes: [2], maxSheets: 1 },
    ]);
    await expect(sessionProvider(p, store).storyboard!(id, undefined, { sheetIndexes: [3] })).rejects.toThrow(
      'Invalid storyboard selection',
    );
    expect(storyboard).toHaveBeenCalledTimes(2);
    expect(store.brief().assets.filter((asset) => asset.kind === 'storyboard_sheet')).toHaveLength(3);
    const restored = reopen();
    const ctx = context(restored, p);
    ctx.analyzeStoryboard = vi.fn(async () => ({findings:[{observation:'A chart is shown.',frameIndexes:[2]}],warnings:[]}));
    const versions = restored.brief().assets.filter(asset => asset.kind === 'storyboard_sheet').map(asset => asset.version);
    const result = await executeAnalyzeVideoStoryboard({assetVersions:versions,focus:'Describe the chart.'},ctx,'analyze-sheets');
    expect(storyboard).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual([]);
    expect(result.excerpts[0]!.startMs).toBe(10000);
    expect(ctx.analyzeStoryboard).toHaveBeenCalledOnce();
    await restored.delete(versions[0]);
    await expect(executeAnalyzeVideoStoryboard({assetVersions:versions,focus:'Read the title.'},ctx,'deleted')).rejects.toThrow('unavailable or deleted');
    expect(storyboard).toHaveBeenCalledTimes(2);
    expect(ctx.analyzeStoryboard).toHaveBeenCalledOnce();

  }));

test('forgetting memory during a run prevents that run from restoring its stale snapshot', async () =>
  within('memory-forget-race', async (store) => {
    remember(store, 'before', [{ kind: 'context', topic: 'intent', text: 'Old preference', evidenceIds: [] }], []);
    store.beginRun('active');
    store.deleteMemory('context:intent');
    remember(store, 'active', [{ kind: 'context', topic: 'intent', text: 'Old preference', evidenceIds: [] }], []);
    expect(store.brief().memories).toEqual([]);
    store.beginRun('next');
    remember(store,
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

test('Session API searches older messages and lists all user turns across reconstruction', async () =>
  within('session-history-search', async (store, reopen) => {
    for (let i = 0; i < 45; i++)
      store.search.upsertHistory({
        id: `user-${i}`,
        role: 'user',
        text: i === 0 ? 'Compare the enterprise pricing.' : `Follow-up ${i}`,
        ordinal: i * 2,
        parentId: null,
        createdAt: i,
      });
    store.search.upsertHistory({
      id: 'assistant',
      role: 'assistant',
      text: 'The enterprise pricing is discussed.',
      ordinal: 1,
      parentId: 'user-0',
      createdAt: 1,
    });
    const resumed = reopen();
    expect((await resumed.search.searchHistory('enterprise pricing')).map((message) => message.id)).toEqual(
      expect.arrayContaining(['user-0', 'assistant']),
    );
    const all = [];
    let offset: number | undefined = 0;
    do {
      const page = resumed.search.readHistory(offset, 'user');
      all.push(...page.messages);
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(all).toHaveLength(45);
    expect(all[0]!.text).toBe('Compare the enterprise pricing.');
    expect(all.at(-1)!.text).toBe('Follow-up 44');
    resumed.search.upsertHistory({
      id: 'user-0',
      role: 'user',
      text: 'Compare the team plan.',
      ordinal: 0,
      parentId: null,
      createdAt: 0,
    });
    resumed.search.removeHistory(['assistant']);
    expect(await resumed.search.searchHistory('enterprise pricing')).toEqual([]);
    expect((await resumed.search.searchHistory('team plan'))[0]?.id).toBe('user-0');
    resumed.search.clearHistory();
    expect(reopen().search.readHistory().messages).toEqual([]);
    expect(await reopen().search.searchHistory('team plan')).toEqual([]);
  }));

test('indexes full transcripts before analysis and searches terms across assets with valid citations', async () =>
  within('fulltext-transcripts', async (store, reopen) => {
    const p = provider();
    vi.mocked(p.transcript).mockResolvedValueOnce({
      value: transcript('Pricing for the enterprise plan is discussed.'),
      cacheStatus: 'miss',
    });
    const first = await sessionProvider(p, store).transcript(id);
    vi.mocked(p.transcript).mockResolvedValueOnce({
      value: { ...transcript('Enterprise customers negotiate pricing.'), videoId: 'zyxwvutsrqp' },
      cacheStatus: 'miss',
    });
    await sessionProvider(p, store).transcript('zyxwvutsrqp');
    // Neither transcript needs an analyst or a pre-existing evidence packet.
    expect(await store.evidence()).toEqual([]);
    const result = await reopen().search.searchEvidence(reopen(), 'enterprise pricing');
    expect(result.packets).toHaveLength(2);
    for (const packet of result.packets) {
      expect(packet.excerpts).toHaveLength(1);
      expect(await store.evidenceForCitations([packet.excerpts[0]!.id])).toHaveLength(1);
    }
    expect(p.transcript).toHaveBeenCalledTimes(2);
    await store.delete(first.assetVersions![0]);
    expect((await reopen().search.searchEvidence(reopen(), 'enterprise pricing')).packets).toHaveLength(1);
    expect((await store.search.searchEvidence(store, '" OR * ()')).packets).toEqual([]);
    await store.delete();
    expect((await reopen().search.searchEvidence(reopen(), 'enterprise')).packets).toEqual([]);
  }));

test('searchable context uses Session tools, follows memory corrections and removes deleted findings', async () =>
  within('context-search', async (store) => {
    const packet = await executeGetVideoTranscript(
      { videoId: id },
      context(store, sessionProvider(provider(), store)),
      'initial',
    );
    remember(store,
      'first',
      [
        {
          kind: 'finding',
          topic: 'opening',
          text: 'The opening is a clear sentence.',
          evidenceIds: [packet.excerpts[0]!.id],
        },
        { kind: 'context', topic: 'focus', text: 'Focus on enterprise pricing.', evidenceIds: [] },
      ],
      [packet],
    );
    const received: EvidencePacket[] = [];
    const tools = await store.searchTools((packets) => { received.push(...packets); }, new AbortController().signal);
    expect(Object.keys(tools).sort()).toEqual(['read_session_history', 'search_context']);
    const options = { toolCallId: 'search', messages: [], context: {} };
    const run = async (label: string, query: string) =>
      JSON.parse(String(await tools.search_context!.execute!({ label, query }, options)));
    expect((await run('memory', 'enterprise pricing'))[0].topic).toBe('focus');
    remember(store,
      'second',
      [{ kind: 'context', topic: 'focus', text: 'Focus on team pricing.', evidenceIds: [] }],
      [],
    );
    expect(await run('memory', 'enterprise')).toEqual([]);
    expect((await run('memory', 'team pricing'))[0].text).toBe('Focus on team pricing.');
    const found = await run('evidence', 'clear sentence');
    expect(found.packets.length).toBeGreaterThan(0);
    expect(received.length).toBe(found.packets.length);
    await store.delete(packet.assetVersions![0]);
    expect(await run('memory', 'opening')).toEqual([]);
    expect((await run('evidence', 'clear')).packets).toEqual([]);
    store.deleteMemory('context:focus');
    expect(await run('memory', 'team pricing')).toEqual([]);
  }));

test('searches visual observations with immutable citations and labels superseded transcript versions', async () =>
  within('visual-search-versions', async (store) => {
    const p = provider();
    const raw = await sessionProvider(p, store).transcript(id);
    const version = raw.assetVersions![0]!;
    const packet = await versionEvidencePacket({
      packetId: 'visual',
      kind: 'youtube_frames',
      assetVersions: [version],
      sources: [{ id: 'v', provider: 'youtube', kind: 'video', videoId: id }],
      excerpts: [{ id: 'old', sourceId: 'v', text: 'A red bicycle appears at the entrance.', startMs: 4200 }],
      artifacts: [],
      warnings: [],
      usage: [],
    });
    store.savePacket(packet);
    const found = await store.search.searchEvidence(store, 'bicycle red');
    expect(found.packets[0]?.excerpts[0]?.id).toBe(packet.excerpts[0]!.id);
    vi.mocked(p.transcript).mockResolvedValueOnce({
      value: transcript('The revised introduction.'),
      cacheStatus: 'miss',
    });
    await sessionProvider(p, store, true).transcript(id);
    const historical = await store.search.searchEvidence(store, 'clear opening');
    expect(historical.packets[0]?.warnings).toContainEqual(
      expect.objectContaining({ code: 'SUPERSEDED_SESSION_EVIDENCE' }),
    );
    await store.delete(version);
    expect((await store.search.searchEvidence(store, 'bicycle')).packets).toEqual([]);
  }));

test('search indexes remain isolated between session Durable Objects', async () => {
  await within('search-owner-one', async (store) => {
    store.search.upsertHistory({
      id: 'private-user',
      role: 'user',
      text: 'Private pricing correction.',
      ordinal: 0,
      parentId: null,
      createdAt: 0,
    });
    await sessionProvider(provider(), store).transcript(id);
    remember(store,
      'one',
      [{ kind: 'context', topic: 'private', text: 'Private account context.', evidenceIds: [] }],
      [],
    );
  });
  await within('search-owner-two', async (store) => {
    expect(await store.search.searchHistory('Private')).toEqual([]);
    expect(store.search.searchMemory('private')).toEqual([]);
    expect((await store.search.searchEvidence(store, 'clear')).packets).toEqual([]);
  });
});

test.each([true, false])(
  'real Session search tools supply grounded evidence to the shared finalizer (resume=%s)',
  async (resume) =>
    within(`model-search-${resume}`, async (store) => {
      const { MockLanguageModelV4 } = await import('ai/test');
      const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
      const p = provider();
      const raw = await sessionProvider(p, store).transcript(id);
      const excerptId = `evidence:${raw.assetVersions![0]}:segment:0`;
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      };
      let coreCalls = 0,
        finalizerCalls = 0;
      const core = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [
            {
              type: 'tool-call',
              toolCallId: `core-${coreCalls}`,
              toolName: coreCalls++ === 0 ? 'search_context' : 'finalize_answer',
              input: JSON.stringify(
                coreCalls === 1
                  ? { label: 'evidence', query: 'clear opening' }
                  : {
                      intent: 'inspect_video',
                      confidence: 'high',
                      warnings: [],
                      artifacts: [],
                      blocks: [{ text: 'A clear opening sentence.', evidenceIds: [excerptId] }],
                    },
              ),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        }),
      });
      const finalizer = new MockLanguageModelV4({
        doGenerate: async () => {
          const search = finalizerCalls++ === 0;
          return {
            content: search
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'lookup',
                    toolName: 'search_context',
                    input: JSON.stringify({ label: 'evidence', query: 'clear opening' }),
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      confidence: 'high',
                      warnings: [],
                      blocks: [{ text: 'A clear opening sentence.', evidenceIds: [excerptId] }],
                    }),
                  },
                ],
            finishReason: { unified: search ? 'tool-calls' : 'stop', raw: 'stop' },
            usage,
            warnings: [],
          };
        },
      });
      const ctx = context(store, sessionProvider(p, store));
      ctx.session = store;
      ctx.finalize = vi.fn(async (_tool, input) =>
        buildAgentTurnResult(
          {
            runId: ctx.runId,
            conversationId: crypto.randomUUID(),
            userMessageId: crypto.randomUUID(),
            agentMessageId: crypto.randomUUID(),
          },
          { userId: 'test', creditsRemaining: 100 },
          input,
          await store.evidenceForCitations([excerptId]),
          0,
        ),
      );
      await runResearchAgentWithModel({
        model: core,
        finalizationModel: finalizer,
        message: 'What is the opening sentence?',
        decision: { route: 'inspect_video', videoId: id, useStoryboard: false, researchVideoCount: 1 },
        context: ctx,
        toolNames: ['finalize_answer'],
        ...(resume ? { finalizationDeadlineAt: Date.now() + 30000 } : {}),
      });
      expect(coreCalls).toBe(resume ? 0 : 2);
      expect(finalizerCalls).toBe(3);
      expect(ctx.finalize).toHaveBeenCalledTimes(1);
      expect((await vi.mocked(ctx.finalize).mock.results[0]!.value).citations[0]?.id).toBe(excerptId);
      expect(p.transcript).toHaveBeenCalledTimes(1);
    }),
);

test('lazy transcript index backfill survives reconstruction and cannot restore an asset deleted during indexing', async () =>
  within('index-backfill-race', async (store, reopen, sql) => {
    const raw = await sessionProvider(provider(), store).transcript(id);
    const version = raw.assetVersions![0]!;
    sql.exec('DELETE FROM session_context_fts');
    sql.exec('DELETE FROM session_search_assets');
    expect((await reopen().search.searchEvidence(reopen(), 'clear opening')).packets).toHaveLength(1);
    sql.exec('DELETE FROM session_context_fts');
    sql.exec('DELETE FROM session_search_assets');
    let release!: (value: unknown) => void;
    vi.spyOn(store, 'read').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const search = store.search.searchEvidence(store, 'clear');
    const rejection = expect(search).rejects.toThrow('changed during indexing');
    await store.delete(version);
    release(transcript());
    await rejection;
    expect(sql.exec('SELECT * FROM session_context_fts').toArray()).toEqual([]);
    expect(sql.exec('SELECT * FROM session_search_assets').toArray()).toEqual([]);
  }));

test('a new frame question reanalyzes the saved image without extracting or charging again',async()=>
  within('frame-followup-trace',async(store,reopen)=>{
    const {executeGetVideoFrames}=await import('../src/agents/providers/youtube/tools/get-video-frames');
    const {toolTrace}=await import('../src/agents/runtime/run-progress');
    const fetchFrames=vi.fn(async()=>({cacheStatus:'miss' as const,value:{videoId:id,
      frames:[{timestampMs:135000,width:640,height:360,mimeType:'image/jpeg' as const,imageBase64:'/9j/2Q=='}],failures:[],meta:{partial:false,warnings:[]}}}));
    const p={frames:fetchFrames} as unknown as YouTubeAgentProvider;
    const analyze=vi.fn(async()=>({findings:[{observation:'The person looks serious.',timestampsMs:[135000]}],warnings:[]}));
    const first=context(store,sessionProvider(p,store));first.analyzeFrames=analyze;
    const raw=await executeGetVideoFrames({videoId:id,timestampsMs:[135000]},first,'first');
    expect(analyze).not.toHaveBeenCalled();
    expect(raw.excerpts).toEqual([]);
    expect(raw.usage[0]!.credits).toBe(2);
    await executeAnalyzeVideoFrames({assetVersions:raw.assetVersions!,focus:'Describe the scene.'},first,'analysis');
    const restored=reopen();const second=context(restored,sessionProvider(p,restored));second.analyzeFrames=analyze;
    const result=await executeAnalyzeVideoFrames({assetVersions:raw.assetVersions!,focus:'Describe the facial expression.'},second,'followup');
    expect(fetchFrames).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual([]);
    expect(restored.brief().assets).toHaveLength(1);
    const trace=toolTrace({tool_call_id:'followup',tool_name:'analyze_video_frames',operation:'frames',semantic_key:'frame-analysis:{}',status:'completed',created_at:1,updated_at:2,result_json:JSON.stringify(result)},true);
    expect(trace.output?.sessionReused).toBe(true);
  }));


test('loads full saved comparison transcripts once and preserves citations across paged reads and deletion', async () =>
  within('comparison-transcript', async (store, reopen) => {
    const value=transcript();
    value.segments=Array.from({length:70},(_,index)=>({text:`Complete sentence number ${index}.`,startMs:index*1000,endMs:(index+1)*1000,durationMs:1000}));
    value.text=value.segments.map(segment=>segment.text).join(' ');
    const p=provider(vi.fn(async()=>({value,cacheStatus:'miss' as const})));
    await sessionProvider(p,store).transcript(id);
    const version=store.brief().assets[0]!.version;
    const full=await store.readTranscriptEvidence(version);
    const page=await reopen().readEvidence(version);
    expect(full.packets[0]!.excerpts).toHaveLength(70);
    expect(full.nextOffset).toBeUndefined();
    expect(page.packets[0]!.excerpts).toHaveLength(30);
    expect(page.nextOffset).toBe(30);
    expect(full.packets[0]!.excerpts[0]).toEqual(page.packets[0]!.excerpts[0]);
    expect(p.transcript).toHaveBeenCalledOnce();
    const citation=full.packets[0]!.excerpts[69]!.id;
    const result=buildAgentTurnResult({runId:crypto.randomUUID(),conversationId:crypto.randomUUID(),userMessageId:crypto.randomUUID(),agentMessageId:crypto.randomUUID()},
      {userId:'user',creditsRemaining:100},{intent:'inspect_video',confidence:'high',answer:`The final passage. [cite:${citation}]`,citations:[],artifacts:[],warnings:[]},
      await reopen().evidenceForCitations([citation]),0);
    expect(result.citations[0]!.excerpt).toBe('Complete sentence number 69.');
    await store.delete(version);
    await expect(reopen().readTranscriptEvidence(version)).rejects.toThrow('unavailable');
    expect(await reopen().evidenceForCitations([citation])).toEqual([]);
  }));

test('timestamp reads reuse the exact saved version beyond the full-read page limit', async () =>
  within('transcript-time-context', async (store, reopen) => {
    const value = transcript();
    value.segments = Array.from({ length: 5100 }, (_, index) => ({ text: `Caption ${index}`, startMs: index * 1000, endMs: index * 1000 + 1500, durationMs: 1500 }));
    value.segments[5050]!.text = '  Exact caption\n' + 'x'.repeat(2100);
    const p = provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const })));
    await sessionProvider(p, store).transcript(id);
    const version = store.brief().assets[0]!.version;
    const read = await reopen().readTranscriptContext(version, 5050.2);
    expect(read.packets[0]!.excerpts).toHaveLength(22);
    expect(read.packets[0]!.excerpts.find(excerpt => excerpt.id.endsWith(':segment:5050'))).toMatchObject({ text: value.segments[5050]!.text, startMs: 5050000, endMs: 5051500 });
    expect(read.nextOffset).toBeUndefined();
    expect(p.transcript).toHaveBeenCalledOnce();
    const restored = reopen();
    const search = await restored.search.searchEvidence(restored, 'Exact caption');
    expect(search.packets.some(packet => packet.excerpts.some(excerpt => excerpt.id.endsWith(':segment:5050') && excerpt.text === value.segments[5050]!.text))).toBe(true);
    await store.delete(version);
    await expect(reopen().readTranscriptContext(version, 5050.2)).rejects.toThrow('unavailable');
  }));


test('forwards transcript diagnostics through session retrieval even when fetching fails', async () =>
  within('transcript-diagnostic-failure', async store => {
    const diagnostic = { ...extractionFixture, kind: 'transcript' as const, outcome: 'failed' as const };
    const fetchTranscript: YouTubeAgentProvider['transcript'] = async (_id, _language, _options, sink) => {
      sink?.(diagnostic);
      throw new Error('YouTube returned an unusable caption URL.');
    };
    const p = { transcript: fetchTranscript } as unknown as YouTubeAgentProvider;
    const ctx = context(store, sessionProvider(p, store));
    ctx.onExtractionDiagnostic = vi.fn();
    await expect(executeGetVideoTranscript({ videoId: id }, ctx, 'failed-transcript')).rejects.toThrow('TRANSCRIPT_FETCH_FAILED');
    expect(ctx.onExtractionDiagnostic).toHaveBeenCalledWith({ ...diagnostic, toolCallId: 'failed-transcript' });
    expect(store.brief().assets).toHaveLength(0);
  }));


test('current comments bypass session reuse while saved transcripts and old comment versions remain readable', async () =>
  within('dynamic-refresh', async (store, reopen) => {
    const p: YouTubeAgentProvider = provider();
    const comments = (text: string) => ({ videoId: id, replyContinuations: [],
      comments: [{ id: text, text, author: { name: 'Viewer', thumbnails: [] }, isPinned: false, isHearted: false, replies: [] }],
      meta: transcript().meta });
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: comments('old') }));
    const original = sessionProvider(p, store);
    const savedTranscript = await original.transcript(id);
    const savedComments = await original.comments(id);
    vi.mocked(p.comments).mockResolvedValueOnce({ cacheStatus: 'miss', value: comments('new') });
    const current = createCapabilityProvider(sessionProvider(p, reopen()), {
      route: 'inspect_video', videoId: id, refreshDynamicData: true,
    });
    const updated = await current.comments(id);
    expect(updated.value.comments[0]?.text).toBe('new');
    expect(p.comments).toHaveBeenLastCalledWith(id, { refresh: true });
    const reused = await current.transcript(id);
    expect(reused.assetVersions).toEqual(savedTranscript.assetVersions);
    expect(p.transcript).toHaveBeenCalledOnce();
    expect(reopen().brief().assets.map(asset => asset.version)).toEqual(expect.arrayContaining([
      ...savedComments.assetVersions!, ...updated.assetVersions!, ...savedTranscript.assetVersions!,
    ]));
  }));

test('long transcript pages remain readable after reopening without provider refetch', async () =>
  within('long-transcript-pages', async (store, reopen) => {
    const value = transcript();
    value.segments = Array.from({length:6001}, (_,i)=>({text:`Caption ${i}`,startMs:i*1000,endMs:(i+1)*1000,durationMs:1000}));
    value.text = value.segments.map(segment=>segment.text).join(' ');
    const fetch = vi.fn(async()=>({value,cacheStatus:'miss' as const}));
    const p = provider(fetch);
    const first = await executeGetVideoTranscript({videoId:id},context(store,sessionProvider(p,store)),'first-page');
    expect(first.excerpts).toHaveLength(5000);
    const resumed = reopen();
    const last = await executeGetVideoTranscript({videoId:id,offset:5000},context(resumed,sessionProvider(p,resumed)),'last-page');
    expect(last.excerpts).toHaveLength(1001);
    expect(last.excerpts.at(-1)).toMatchObject({text:'Caption 6000',startMs:6000000});
    expect(last.continuation).toBeUndefined();
    expect(last.assetVersions).toEqual(first.assetVersions);
    expect(fetch).toHaveBeenCalledOnce();
    const page = await resumed.readEvidence(first.assetVersions![0]!,5000);
    expect(page.packets[0]!.excerpts[0]!.text).toBe('Caption 5000');
  }));

test.each([false, true])('frame pins overlap safely, including session deletion=%s', async deleted =>
  within(`frame-batch-${deleted}`, async (store, reopen) => {
    const times = [1000, 2000, 3000, 4000, 5000, 6000];
    const p = { frames: vi.fn(async () => ({ cacheStatus: 'miss' as const, value: {
      videoId: id, frames: times.map(timestampMs => ({ timestampMs, width: 640, height: 360,
        mimeType: 'image/jpeg' as const, imageBase64: '/9j/2Q==' })), failures: [], meta: { partial: false, warnings: [] },
    } })) } as unknown as YouTubeAgentProvider;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstBatch = new Promise<void>(resolve => { started = resolve; });
    let active = 0, peak = 0, calls = 0;
    const retrieve = store.retrieve.bind(store);
    const spy = vi.spyOn(store, 'retrieve').mockImplementation((key, kind, videoId, fresh, load, describe, accept, signal) =>
      retrieve(key, kind, videoId, fresh, async () => {
        active++; calls++; peak = Math.max(peak, active);
        if (calls === 6) started();
        await gate;
        try { return await load(); } finally { active--; }
      }, describe, accept, signal));
    try {
      const pending = sessionProvider(p, store).frames!({ videoId: id, timestampsMs: times, maxWidth: 640 });
      const outcome = deleted ? expect(pending).rejects.toThrow('Session assets changed') : pending;
      await firstBatch;
      if (deleted) await store.delete();
      release();
      await outcome;
      expect(peak).toBe(6);
      expect(active).toBe(0);
      expect(calls).toBe(6);
      expect(reopen().brief().assets).toHaveLength(deleted ? 0 : 6);
      if (!deleted) {
        const reused = await sessionProvider(p, reopen()).frames!({ videoId: id, timestampsMs: times, maxWidth: 640 });
        expect(reused.value.frames.map(frame => frame.timestampMs)).toEqual(times);
        expect(p.frames).toHaveBeenCalledOnce();
        expect(reused.frameTimingsMs).toMatchObject({ retrieval: 0, sessionPin: 0 });
      }
    } finally { release(); spy.mockRestore(); }
  }));

function longTranscript(endMs = 21_521_000): Transcript {
  const value = transcript('A six hour broadcast.');
  value.segments = [{ startMs: 0, endMs: 5_000, durationMs: 5_000, text: 'Opening.' }, { startMs: endMs - 5_000, endMs, durationMs: 5_000, text: 'Closing.' }];
  return value;
}

test('an over-limit transcript is rejected before it becomes a session asset', async () =>
  runInDurableObject(env.AGENT_RUNTIME.getByName('too-long-fetch'), async (_instance, state) => {
    const store = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-session/too-long-fetch/', undefined, undefined, undefined, 7_200);
    const p = provider(vi.fn(async () => ({ value: longTranscript(), cacheStatus: 'miss' as const })));
    await expect(sessionProvider(p, store).transcript(id)).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    expect(store.brief().assets).toEqual([]);
  }));

test('a long transcript saved before the limit existed is never loaded again', async () =>
  runInDurableObject(env.AGENT_RUNTIME.getByName('too-long-saved'), async (_instance, state) => {
    const prefix = 'test-session/too-long-saved/';
    // Saved by a store without the limit, as in sessions created before this change.
    const unlimited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix);
    const p = provider(vi.fn(async () => ({ value: longTranscript(), cacheStatus: 'miss' as const })));
    const saved = await sessionProvider(p, unlimited).transcript(id);
    const version = saved.assetVersions![0]!;

    const limited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix, undefined, undefined, undefined, 7_200);
    const read = vi.spyOn(limited, 'read');
    await expect(limited.readEvidence(version)).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    await expect(limited.readTranscriptEvidence(version)).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    await expect(limited.readAsset(version)).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    await limited.ensureSearchIndexed();
    // Reuse through the provider is rejected too, without another fetch.
    await expect(sessionProvider(p, limited).transcript(id)).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    expect(p.transcript).toHaveBeenCalledTimes(1);
    // None of the guarded paths, provider reuse included, read the stored blob.
    expect(read).not.toHaveBeenCalled();
  }));

test('transcripts within the limit are saved and read normally', async () =>
  runInDurableObject(env.AGENT_RUNTIME.getByName('within-limit'), async (_instance, state) => {
    const store = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-session/within-limit/', undefined, undefined, undefined, 7_200);
    const result = await sessionProvider(provider(), store).transcript(id);
    const evidence = await store.readEvidence(result.assetVersions![0]!);
    expect(evidence.packets[0]!.excerpts.length).toBeGreaterThan(0);
  }));

test('evidence search skips a long transcript indexed before the limit and keeps other matches', async () =>
  runInDurableObject(env.AGENT_RUNTIME.getByName('too-long-indexed'), async (_instance, state) => {
    const prefix = 'test-session/too-long-indexed/';
    const unlimited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix);
    const longId = 'longvideo01';
    const shortId = 'shortvideo1';
    const long = { ...longTranscript(), videoId: longId };
    long.segments = long.segments.map(segment => ({ ...segment, text: 'Gold medal ceremony.' }));
    const short = { ...transcript('Gold medal ceremony recap.'), videoId: shortId };
    const fetch = vi.fn(async (videoId: string) => ({ value: videoId === longId ? long : short, cacheStatus: 'miss' as const }));
    await sessionProvider(provider(fetch as never), unlimited).transcript(longId);
    await sessionProvider(provider(fetch as never), unlimited).transcript(shortId);
    // Indexed while no limit existed, as in sessions saved before this change.
    await unlimited.ensureSearchIndexed();

    const limited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix, undefined, undefined, undefined, 7_200);
    const found = await limited.search.searchEvidence(limited, 'gold medal');
    expect(found.packets.length).toBeGreaterThan(0);
    expect(found.packets.flatMap(packet => packet.sources.map(source => source.videoId))).toEqual(expect.arrayContaining([shortId]));
    expect(found.packets.flatMap(packet => packet.sources.map(source => source.videoId))).not.toContain(longId);
  }));

test('long transcript matches cannot crowd short-video matches out of the top 20', async () =>
  runInDurableObject(env.AGENT_RUNTIME.getByName('too-long-crowding'), async (_instance, state) => {
    const prefix = 'test-session/too-long-crowding/';
    const unlimited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix);
    const longId = 'longvideo02';
    const shortId = 'shortvideo2';
    // 100 short, separate passages across six hours: each becomes its own matching index row.
    const long: Transcript = { ...transcript('Gold medal.'), videoId: longId,
      segments: Array.from({ length: 100 }, (_, i) => ({ startMs: i * 215_000, endMs: i * 215_000 + 4_000, durationMs: 4_000, text: 'Gold medal.' })) };
    const short = { ...transcript('Gold medal ceremony recap and team highlights.'), videoId: shortId };
    const fetch = vi.fn(async (videoId: string) => ({ value: videoId === longId ? long : short, cacheStatus: 'miss' as const }));
    await sessionProvider(provider(fetch as never), unlimited).transcript(longId);
    await sessionProvider(provider(fetch as never), unlimited).transcript(shortId);
    await unlimited.ensureSearchIndexed();
    const videos = (packets: EvidencePacket[]) => packets.flatMap(packet => packet.sources.map(source => source.videoId));

    // Precondition: without the limit, the long transcript fills every one of the 20 slots.
    const crowded = await unlimited.search.searchEvidence(unlimited, 'gold medal');
    expect(crowded.packets.flatMap(packet => packet.excerpts).length).toBeGreaterThanOrEqual(20);
    expect(videos(crowded.packets)).not.toContain(shortId);

    const limited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix, undefined, undefined, undefined, 7_200);
    const found = await limited.search.searchEvidence(limited, 'gold medal');
    expect(videos(found.packets)).toContain(shortId);
    expect(videos(found.packets)).not.toContain(longId);
  }));

test('single-sheet storyboard reuses the processor middle sheet across restored sessions', async () =>
  within('storyboard-single-middle', async (store, reopen) => {
    const value = { videoId: id, frameCount: 6, intervalMs: 5000,
      manifest: { totalSheets: 3, framesPerSheet: 2, tileWidth: 100, tileHeight: 100,
        columns: 2, rows: 1, lastSampleMs: 25000 },
      selection: { mode: 'spread' as const },
      sheets: [{ firstFrameIndex: 2, frameCount: 2, tileWidth: 100, tileHeight: 100,
        columns: 2, rows: 1, intervalMs: 5000, imageBase64: '/9j/2Q==' }],
      meta: { partial: false, warnings: [] } };
    const storyboard = vi.fn(async () => ({ cacheStatus: 'miss' as const, value }));
    const p = { storyboard } as unknown as YouTubeAgentProvider;
    const { captureVisualWork } = await import('../src/lib/visual-diagnostics');
    const cold = await captureVisualWork('tool', 'storyboard', () => sessionProvider(p, store).storyboard!(id, undefined, { maxSheets: 1 }));
    const warm = await captureVisualWork('tool', 'storyboard', () => sessionProvider(p, reopen()).storyboard!(id, undefined, { maxSheets: 1 }));
    expect(cold.value.value.sheets).toEqual(value.sheets);
    expect(warm.value.value.sheets).toEqual(value.sheets);
    expect(warm.value.sessionReused).toBe(true);
    expect(storyboard).toHaveBeenCalledOnce();
    for (const { diagnostics } of [cold, warm]) {
      for (const span of diagnostics.spans) {
        const parent = diagnostics.spans.find(candidate => candidate.id === span.parentId);
        if (parent) expect(parent.stage).not.toBe(span.stage);
      }
    }
  }));

test('retains disjoint transcript packets, findings and backed memory for one asset', async () =>
  within('distinct-transcript-packets', async (store, reopen) => {
    const value = transcript();
    value.segments = Array.from({ length: 6 }, (_, index) => ({ text: `Caption ${index}`, startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    const p = sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store);
    const ctx = context(store, p);
    const first = await executeGetVideoTranscript({ videoId: id }, ctx, 'first-time', { timestampSeconds: 0.2, before: 0, after: 0 });
    const second = await executeGetVideoTranscript({ videoId: id }, ctx, 'second-time', { timestampSeconds: 5.2, before: 0, after: 0 });
    for (const [index, packet] of [first, second].entries()) {
      store.savePacket({ ...packet, packetId: `analysis:${index}`, artifacts: [{ type: 'youtube_transcript_analysis', data: {
        findings: [{ claim: `Finding ${index}`, excerptIds: [packet.excerpts[0]!.id] }],
      } }] });
    }
    const restored = reopen();
    expect(await restored.evidence()).toHaveLength(4);
    for (const [index, packet] of [first, second].entries()) {
      const saved = await restored.evidenceForCitations([packet.excerpts[0]!.id]);
      expect(saved).toHaveLength(2);
      expect(saved.flatMap(item => item.artifacts).some(artifact =>
        JSON.stringify(artifact.data).includes(`Finding ${index}`))).toBe(true);
    }
    const result = remember(restored, 'memory-run', [first, second].map((packet, index) => ({
      kind: 'finding', topic: `topic-${index}`, text: `Finding ${index}`, evidenceIds: [packet.excerpts[0]!.id],
    })));
    expect(result.applied).toBe(2);
    expect(reopen().brief().memories).toHaveLength(2);
    // Retrying the same packet remains an upsert, not an additional copy.
    restored.savePacket(first);
    expect(await reopen().evidence()).toHaveLength(4);
  }));

test('a narrow lookup does not replace a previously saved full transcript packet', async () =>
  within('full-then-narrow-transcript', async (store, reopen) => {
    const value = transcript();
    value.segments = Array.from({ length: 6 }, (_, index) => ({ text: `Caption ${index}`, startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    const ctx = context(store, sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store));
    const full = await executeGetVideoTranscript({ videoId: id }, ctx, 'full');
    const narrow = await executeGetVideoTranscript({ videoId: id }, ctx, 'narrow', { timestampSeconds: 5.2, before: 0, after: 0 });
    const restored = reopen();
    expect(await restored.evidence()).toHaveLength(2);
    expect((await restored.evidenceForCitations([full.excerpts[0]!.id]))[0]!.excerpts).toHaveLength(1);
    expect((await restored.evidence()).find(packet => packet.packetId === full.packetId)!.excerpts).toHaveLength(6);
    expect(narrow.excerpts[0]!.id).toBe(full.excerpts[5]!.id);
    expect(await restored.evidenceForCitations([narrow.excerpts[0]!.id])).toHaveLength(2);
  }));

test('resolves original segments and backed memory without lookup packets', async () =>
  within('canonical-segment-resolution', async (store, reopen, sql) => {
    const value = transcript('  Original\ncaption text.  ');
    value.segments.push({ text: '', startMs: 5600, endMs: 6000, durationMs: 400 });
    const p = sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store);
    await p.transcript(id);
    const version = store.brief().assets[0]!.version;
    const citation = `evidence:${version}:segment:0`;
    expect(sql.exec('SELECT * FROM session_packets').toArray()).toHaveLength(0);
    const resolved = await reopen().evidenceForCitations([citation]);
    expect(resolved[0]!.excerpts).toEqual([{ id: citation, sourceId: `youtube:${id}:transcript`,
      text: value.segments[0]!.text, startMs: 0, endMs: 5600 }]);
    expect(await reopen().evidenceForCitations([`evidence:${version}:segment:1`, `evidence:${version}:segment:99`])).toEqual([]);
    expect(remember(reopen(), 'direct-memory', [{ kind: 'finding', topic: 'original', text: 'Original finding', evidenceIds: [citation] }]).applied).toBe(1);
    const lookup = await executeGetVideoTranscript({ videoId: id }, context(store, p), 'lookup', { timestampSeconds: 1 });
    const record = JSON.parse(sql.exec<{ packet_json: string }>('SELECT packet_json FROM session_packets').one().packet_json);
    expect(record.excerpts).toEqual([{ id: citation, sourceId: lookup.excerpts[0]!.sourceId }]);
    expect(JSON.stringify(record)).not.toContain('Original\\ncaption');
    // The transcript remains sufficient after every lookup record is removed.
    sql.exec('DELETE FROM session_packets');
    expect((await reopen().evidenceForCitations([citation]))[0]!.excerpts[0]!.text).toBe(value.segments[0]!.text);
    await store.delete(version);
    expect(await reopen().evidenceForCitations([citation])).toEqual([]);
    expect(reopen().brief().memories).toEqual([]);
  }));

test('direct segment citations stay pinned to their transcript version after refresh', async () =>
  within('direct-segment-version-isolation', async (store, reopen) => {
    const fetch = vi.fn().mockResolvedValueOnce({ value: transcript('Original version'), cacheStatus: 'miss' })
      .mockResolvedValueOnce({ value: transcript('Refreshed version'), cacheStatus: 'miss' });
    const p = sessionProvider(provider(fetch), store);
    const first = await p.transcript(id);
    const second = await p.transcript(id, undefined, { refresh: true });
    const firstId = `evidence:${first.assetVersions![0]}:segment:0`;
    const secondId = `evidence:${second.assetVersions![0]}:segment:0`;
    expect(firstId).not.toBe(secondId);
    const packets = await reopen().evidenceForCitations([firstId, secondId]);
    expect(packets.flatMap(packet => packet.excerpts).map(excerpt => excerpt.text)).toEqual(['Original version', 'Refreshed version']);
    expect(packets[0]!.warnings.some(warning => warning.code === 'SUPERSEDED_SESSION_EVIDENCE')).toBe(true);
    expect(await reopen().evidence()).toEqual([]);
  }));

test.each([false, true])('repeated cross-run reads preserve lower-ranked search matches (legacy rows: %s)', async legacyRows =>
  within(`search-distinct-captions-${legacyRows}`, async (store, reopen, sql) => {
    const value = transcript();
    value.segments = Array.from({ length: 6 }, (_, index) => ({
      text: index === 0 ? 'needle' : index === 5 ? 'needle appears later in this longer explanation about components and state' : `Unrelated caption ${index}`,
      startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000,
    }));
    const p = provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const })));
    for (let run = 0; run < 25; run++) {
      const current = reopen();
      const packet = await executeGetVideoTranscript({ videoId: id }, context(current, sessionProvider(p, current)), 'lookup',
        { timestampSeconds: 0.2, before: 0, after: 0 });
      if (legacyRows) {
        // Rows written by the earlier packet-per-call indexing implementation.
        sql.exec('INSERT INTO session_context_fts (id,owner,scope,content,metadata) VALUES (?, ?, ?, ?, ?)',
          packet.excerpts[0]!.id, `packet:${packet.packetId}`, 'evidence', packet.excerpts[0]!.text, JSON.stringify({ packetId: packet.packetId }));
      }
    }
    const current = reopen();
    await executeGetVideoTranscript({ videoId: id }, context(current, sessionProvider(p, current)), 'later',
      { timestampSeconds: 5.2, before: 0, after: 0 });
    const restored = reopen();
    const found = await restored.search.searchEvidence(restored, 'needle');
    expect(found.packets.flatMap(packet => packet.excerpts).map(excerpt => excerpt.startMs).sort((a, b) => a! - b!)).toEqual([0, 5000]);
    expect(sql.exec("SELECT * FROM session_packets WHERE packet_id LIKE 'packet:%'").toArray()).toHaveLength(26);
    expect(p.transcript).toHaveBeenCalledOnce();
    if (!legacyRows) expect(sql.exec("SELECT * FROM session_context_fts WHERE owner LIKE 'packet:%'").toArray()).toEqual([]);
  }));

test('citation resolution is a passive read and does not rewrite segment references', async () =>
  within('passive-citation-read', async (store, _reopen, sql) => {
    await sessionProvider(provider(), store).transcript(id);
    const version = store.brief().assets[0]!.version;
    sql.exec('CREATE TABLE reference_writes (value INTEGER)');
    sql.exec('CREATE TRIGGER watch_reference_insert AFTER INSERT ON session_segment_refs BEGIN INSERT INTO reference_writes VALUES (1); END');
    sql.exec('CREATE TRIGGER watch_reference_update AFTER UPDATE ON session_segment_refs BEGIN INSERT INTO reference_writes VALUES (1); END');
    const requested = vi.fn(async () => {});
    const passive = new SessionEvidenceStore(sql, env.RESEARCH, 'test-session/passive-citation-read/', requested);
    const citation = `evidence:${version}:segment:0`;
    expect((await passive.evidenceForCitations([citation]))[0]!.excerpts[0]!.text).toBe('A clear opening sentence.');
    await passive.evidenceForCitations([citation]);
    expect(requested).not.toHaveBeenCalled();
    expect(sql.exec('SELECT * FROM reference_writes').toArray()).toEqual([]);
    await passive.read(version);
    expect(requested).toHaveBeenCalledOnce();
    expect(sql.exec('SELECT * FROM reference_writes').toArray()).toEqual([]);
  }));

test('targeted citation lookup and memory validation ignore unrelated packet payloads', async () =>
  within('targeted-citation-query', async (store, reopen, sql) => {
    await sessionProvider(provider(), store).transcript(id);
    const version = store.brief().assets[0]!.version;
    const citation = `evidence:${version}:segment:0`;
    // A legacy record with no excerpts must not be loaded into the requested packet set.
    sql.exec('INSERT INTO session_packets VALUES (?, ?, ?)', 'unrelated', JSON.stringify({ packetId: 'unrelated', excerpts: [] }), JSON.stringify([version]));
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text.includes('unrelated')) throw new Error('Unrelated packet was deserialized');
      return parse(text, reviver);
    });
    try {
      const result = await reopen().evidenceForCitations([citation]);
      expect(result).toHaveLength(1);
      expect(result[0]!.excerpts.map(excerpt => excerpt.id)).toEqual([citation]);
      expect(remember(reopen(), 'memory', [{ kind: 'finding', topic: 'caption', text: 'A finding', evidenceIds: [citation] }]).applied).toBe(1);
      expect(remember(reopen(), 'invalid-memory', [{ kind: 'finding', topic: 'invalid', text: 'Invalid', evidenceIds: [`evidence:${version}:segment:999999`] }]).applied).toBe(0);
    } finally { spy.mockRestore(); }
  }));


test.each([false, true])('concurrent passive and requested reads share one storage fetch (active first: %s)', async activeFirst =>
  within(`shared-caption-read-${activeFirst}`, async (store, _reopen, sql) => {
    await sessionProvider(provider(), store).transcript(id);
    const version = store.brief().assets[0]!.version;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = vi.fn(async (...args: Parameters<R2Bucket['get']>) => { await gate; return env.RESEARCH.get(...args); });
    const requested = vi.fn(async () => {});
    const reader = new SessionEvidenceStore(sql, { get } as unknown as R2Bucket, `test-session/shared-caption-read-${activeFirst}/`, requested);
    const first = reader.read(version, activeFirst);
    const second = reader.read(version, !activeFirst);
    expect(get).toHaveBeenCalledOnce();
    expect(requested).not.toHaveBeenCalled();
    release();
    const values = await Promise.all([first, second]);
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).not.toBeNull();
    expect(requested).toHaveBeenCalledExactlyOnceWith(id);
    expect(get).toHaveBeenCalledOnce();
  }));

test.each([false, true])('oversized caption chunks cannot crowd searchable captions (legacy: %s)', async legacy =>
  within(`oversized-search-${legacy}`, async (store, reopen, sql) => {
    const value = transcript();
    value.segments = [
      { text: 'needle '.repeat(10000), startMs: 0, endMs: 1000, durationMs: 1000 },
      { text: 'A later needle passage with useful context.', startMs: 1000, endMs: 2000, durationMs: 1000 },
    ];
    const result = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const version = result.assetVersions![0]!;
    if (legacy) {
      sql.exec('DELETE FROM session_context_fts');
      for (let index = 0; index < 35; index++) sql.exec('INSERT INTO session_context_fts (id,owner,scope,content,metadata) VALUES (?, ?, ?, ?, ?)',
        `evidence:${version}:${index}`, `asset:${version}`, 'evidence', 'needle', JSON.stringify({ version, offset: index }));
      // Simulate a session created before the canonical-segment index format.
      sql.exec('DELETE FROM session_search_format');
    }
    const current = reopen();
    const found = await current.search.searchEvidence(current, 'needle');
    expect(found.packets.flatMap(packet => packet.excerpts).map(excerpt => excerpt.text)).toEqual([value.segments[1]!.text]);
    expect(found.packets[0]!.excerpts[0]!.id).toBe(`evidence:${version}:segment:1`);
    expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM session_context_fts WHERE owner=?', `asset:${version}`).one().count).toBe(1);
    expect((await reopen().search.searchEvidence(reopen(), 'needle')).packets).toHaveLength(1);
  }));

test('empty timestamp lookups provide persisted citable status, not invented speech or duration', async () =>
  within('empty-time-status', async (store, reopen) => {
    const value = transcript('Last spoken words.');
    const result = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const version = result.assetVersions![0]!;
    const packet = (await store.readTranscriptContext(version, 2700)).packets[0]!;
    expect(packet.excerpts).toHaveLength(1);
    expect(packet.excerpts[0]!.startMs).toBeUndefined();
    expect(packet.excerpts[0]!.text).toContain('Transcript lookup status');
    const restored = await reopen().evidenceForCitations([packet.excerpts[0]!.id]);
    const answer = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
      { userId: 'user', creditsRemaining: 1 }, { intent: 'inspect_video', confidence: 'high', warnings: [], artifacts: [], citations: [],
        answer: `The transcript has no captions near 45:00. [cite:${packet.excerpts[0]!.id}]` }, restored, 0);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]!.startMs).toBeUndefined();
  }));

test.each([false, true])('multi-word search spans captions and window boundaries (format 2 upgrade: %s)', async upgrade =>
  within(`multi-caption-search-${upgrade}`, async (store, reopen, sql) => {
    const value = transcript();
    value.segments = Array.from({ length: 15 }, (_, index) => ({
      text: index === 9 ? 'useEffect' : index === 10 ? 'returns a cleanup' : index === 11 ? 'function on unmount' : `Caption ${index}`,
      startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000,
    }));
    const result = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const version = result.assetVersions![0]!;
    // Window support can be spread over independently saved lookup packets.
    await store.readTranscriptContext(version, 9.2, 0, 0);
    await store.readTranscriptContext(version, 10.2, 0, 0);
    if (upgrade) {
      sql.exec("DELETE FROM session_context_fts WHERE json_extract(metadata,'$.segmentIds') IS NOT NULL");
      sql.exec('DELETE FROM session_search_format');
      sql.exec('INSERT INTO session_search_format VALUES (2)');
    }
    const current = reopen();
    const read = vi.spyOn(current, 'read');
    await current.ensureSearchIndexed('useEffect cleanup function');
    expect(read).not.toHaveBeenCalled();
    const found = await current.search.searchEvidence(current, 'useEffect cleanup function');
    expect(read).toHaveBeenCalledTimes(1);
    const excerpts = found.packets.flatMap(packet => packet.excerpts);
    for (const index of [9, 10, 11]) expect(excerpts).toContainEqual(expect.objectContaining({
      id: `evidence:${version}:segment:${index}`, text: value.segments[index]!.text, startMs: index * 1000,
    }));
    expect(new Set(excerpts.map(excerpt => excerpt.id)).size).toBe(excerpts.length);
    // The matching window spans ten captions; only the run covering the terms is returned.
    expect(excerpts).toHaveLength(3);
    expect(found.pendingTranscripts).toBe(0);
  }));

test('window trimming keeps captions the index tokenizes differently', async () =>
  within('search-trim-underscore', async (store) => {
    const value = transcript();
    value.segments = ['foo_bar', 'foo'].map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    // SQLite treats `_` as a separator, so foo_bar alone matches both terms.
    const texts = (await store.search.searchEvidence(store, 'foo bar')).packets.flatMap(packet => packet.excerpts.map(excerpt => excerpt.text));
    expect(texts).toContain('foo_bar');
  }));

test('overlapping windows cannot crowd distinct matches out of the result limit', async () =>
  within('search-window-crowding', async (store) => {
    const add = async (videoId: string, texts: string[]) => {
      const value = { ...transcript(), videoId };
      value.segments = texts.map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
      await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(videoId);
    };
    // Thirteen cross-caption matches, each inside two overlapping windows: 26 FTS rows, 13 distinct results.
    await add('crowdvidA01', Array.from({ length: 130 }, (_, index) => index % 10 === 2 ? 'alpha' : index % 10 === 3 ? 'beta' : `filler ${index}`));
    // One lower-ranked match in another video.
    await add('crowdvidB01', Array.from({ length: 10 }, (_, index) => index === 0 ? 'alpha' : index === 9 ? 'beta' : `padding words ${index}`));
    const read = vi.spyOn(store, 'read');
    const found = await store.search.searchEvidence(store, 'alpha beta');
    // Candidates span several resolution batches. Two transcripts fit within the
    // bounded read cache, so neither is read twice.
    const reads = read.mock.calls.map(([version]) => version);
    expect(reads.length).toBe(new Set(reads).size);
    expect(new Set(found.packets.flatMap(packet => packet.sources.map(source => source.videoId)))).toEqual(new Set(['crowdvidA01', 'crowdvidB01']));
    const excerpts = found.packets.flatMap(packet => packet.excerpts);
    expect(new Set(excerpts.map(excerpt => excerpt.id)).size).toBe(excerpts.length);
  }));

test('unreadable transcripts rotate behind healthy index work', async () =>
  within('search-index-failure-rotation', async (store, _reopen, sql) => {
    const versions: string[] = [];
    for (let index = 0; index < 6; index++) {
      const videoId = `rotatevid${String(index).padStart(2, '0')}`;
      const value = { ...transcript('needle cleanup function'), videoId };
      const result = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(videoId);
      versions.push(result.assetVersions![0]!);
    }
    sql.exec("DELETE FROM session_context_fts WHERE owner LIKE 'asset:%'");
    sql.exec('DELETE FROM session_search_assets');
    const current = new SessionEvidenceStore(sql, env.RESEARCH, 'test-session/search-index-failure-rotation/');
    const broken = new Set(versions.slice(0, 4));
    const original = current.read.bind(current);
    const read = vi.spyOn(current, 'read').mockImplementation(async (version, markRequested) =>
      version === versions[0] ? Promise.reject(new Error('R2 unavailable')) : broken.has(version) ? null : original(version, markRequested));
    // The four unreadable versions fill the first batch. They are reported as
    // unavailable, separately from work a later search can still complete.
    expect(await current.ensureSearchIndexed('needle')).toEqual({ pendingTranscripts: 2, unavailableTranscripts: 4 });
    expect(new Set(read.mock.calls.map(([version]) => version))).toEqual(broken);
    expect(sql.exec('SELECT version FROM session_search_index_failures').toArray()).toHaveLength(4);
    // Recorded failures move behind untried versions, so healthy work still completes.
    read.mockClear();
    expect(await current.ensureSearchIndexed('needle')).toEqual({ pendingTranscripts: 0, unavailableTranscripts: 4 });
    expect(read.mock.calls.map(([version]) => version).slice(0, 2).sort()).toEqual(versions.slice(4).sort());
    const indexed = new Set(sql.exec<{ version: string }>('SELECT version FROM session_search_assets').toArray().map(row => row.version));
    for (const version of versions.slice(4)) expect(indexed.has(version)).toBe(true);
    expect((await current.search.searchEvidence(current, 'needle cleanup')).packets.length).toBeGreaterThan(0);
    // A later successful read clears the failure record.
    read.mockRestore();
    await current.ensureSearchIndexed('needle');
    expect(sql.exec('SELECT version FROM session_search_index_failures').toArray()).toHaveLength(0);
  }));

test('legacy search upgrades only matching assets in bounded passive batches', async () =>
  within('bounded-search-upgrade', async (store, _reopen, sql) => {
    const versions: string[] = [];
    for (let index = 0; index < 10; index++) {
      const videoId = `searchvid${String(index).padStart(2, '0')}`;
      const value = { ...transcript(index < 9 ? 'needle cleanup function' : 'unrelated lecture'), videoId };
      const result = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(videoId);
      versions.push(result.assetVersions![0]!);
    }
    sql.exec('DELETE FROM session_context_fts');
    sql.exec('DELETE FROM session_search_format');
    for (const [index, version] of versions.entries()) sql.exec(
      'INSERT INTO session_context_fts (id,owner,scope,content,metadata) VALUES (?,?,?,?,?)',
      `evidence:${version}:0`, `asset:${version}`, 'evidence', index < 9 ? 'needle cleanup function' : 'unrelated lecture', JSON.stringify({ version, offset: 0 }));
    const requested = vi.fn(async () => {});
    const current = new SessionEvidenceStore(sql, env.RESEARCH, 'test-session/bounded-search-upgrade/', requested);
    // Construction must retain existing indexes and their markers.
    expect(sql.exec('SELECT * FROM session_context_fts').toArray()).toHaveLength(10);
    const read = vi.spyOn(current, 'read');
    expect(await current.ensureSearchIndexed('needle cleanup')).toEqual({ pendingTranscripts: 5 });
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.every(([, requested]) => requested === false)).toBe(true);
    expect(read.mock.calls.some(([version]) => version === versions[9])).toBe(false);
    expect(requested).not.toHaveBeenCalled();
    expect(await current.ensureSearchIndexed('needle cleanup')).toEqual({ pendingTranscripts: 1 });
    expect(await current.ensureSearchIndexed('needle cleanup')).toEqual({ pendingTranscripts: 0 });
    const found = await current.search.searchEvidence(current, 'needle cleanup function');
    expect(found.packets).toHaveLength(9);
    expect(requested).not.toHaveBeenCalled();
    expect(current.search.legacyCandidates('unrelated')).toEqual(new Set([versions[9]]));
  }));

test('search windows do not bridge omitted oversized captions', async () =>
  within('search-window-omission', async (store) => {
    const value = transcript();
    value.segments = ['useEffect', 'x'.repeat(16001), 'cleanup function'].map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000,
    }));
    await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    expect((await store.search.searchEvidence(store, 'useEffect cleanup function')).packets).toEqual([]);
    expect((await store.search.searchEvidence(store, 'cleanup function')).packets[0]!.excerpts[0]!.text).toBe('cleanup function');
  }));

test.each([18, 20, 25])('search refills through tail overlap and stops at twenty matches (%s videos)', async count =>
  within(`search-tail-crowding-${count}`, async store => {
    const expected: string[] = [];
    for (let index = 0; index < count; index++) {
      const videoId = `tailvid${String(index).padStart(4, '0')}`;
      expected.push(videoId);
      const value = { ...transcript(), videoId };
      value.segments = (index < count - 1 ? Array.from({ length: 10 }, (_, i) => i === 8 ? 'alpha beta' : 'filler') : ['alpha beta ' + 'filler '.repeat(300)])
        .map((text, i) => ({ text, startMs: i * 1000, endMs: (i + 1) * 1000, durationMs: 1000 }));
      await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(videoId);
    }
    const found = await store.search.searchEvidence(store, 'alpha beta');
    const videos = [...new Set(found.packets.flatMap(p => p.sources.map(s => s.videoId)))];
    expect(videos).toHaveLength(Math.min(count, 20));
    if (count <= 20) expect(videos.sort()).toEqual(expected.sort());
    const excerpts = found.packets.flatMap(packet => packet.excerpts);
    expect(new Set(excerpts.map(excerpt => excerpt.id)).size).toBe(excerpts.length);
    expect(found.pendingTranscripts).toBe(0);
  }));

test.each([false, true])('search continues past unavailable candidates until exhaustion (healthy match: %s)', async healthy =>
  within(`search-unavailable-pages-${healthy}`, async (store, _reopen, sql) => {
    const value = transcript();
    value.segments = Array.from({ length: 45 }, (_, index) => ({ text: 'needle', startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    const saved = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const key = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', saved.assetVersions![0]!).one().blob_key;
    await env.RESEARCH.delete(key);
    if (healthy) {
      const later = { ...transcript('needle ' + 'padding '.repeat(100)), videoId: 'healthyvid1' };
      await sessionProvider(provider(vi.fn(async () => ({ value: later, cacheStatus: 'miss' as const }))), store).transcript(later.videoId);
    }
    const found = await store.search.searchEvidence(store, 'needle');
    expect(found.packets).toHaveLength(healthy ? 1 : 0);
    if (healthy) expect(found.packets[0]!.sources[0]!.videoId).toBe('healthyvid1');
  }));

test('deletion during a later search page discards earlier results', async () =>
  within('search-page-deletion', async store => {
    const value = transcript();
    value.segments = Array.from({ length: 100 }, (_, index) => ({ text: index % 10 === 8 ? 'alpha beta' : 'filler', startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const resolve = store.evidenceForCitations.bind(store);
    let calls = 0;
    vi.spyOn(store, 'evidenceForCitations').mockImplementation(async ids => {
      const packets = await resolve(ids);
      if (++calls === 2) await store.delete();
      return packets;
    });
    const found = await store.search.searchEvidence(store, 'alpha beta');
    expect(calls).toBe(2);
    expect(found.packets).toEqual([]);
  }));

test('an unreadable transcript filling the candidate limit cannot hide healthy matches', async () =>
  within('search-unreadable-candidate-limit', async (store, _reopen, sql) => {
    const value = transcript();
    // 250 short top-ranked caption matches, more than one bounded query returns.
    value.segments = Array.from({ length: 250 }, (_, index) => ({ text: 'needle', startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    const saved = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const broken = saved.assetVersions![0]!;
    const key = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', broken).one().blob_key;
    await env.RESEARCH.delete(key);
    const later = { ...transcript('needle ' + 'padding '.repeat(100)), videoId: 'healthyvid2' };
    await sessionProvider(provider(vi.fn(async () => ({ value: later, cacheStatus: 'miss' as const }))), store).transcript(later.videoId);
    const read = vi.spyOn(store, 'read');
    const query = vi.spyOn(store.search as unknown as { matches: (...args: unknown[]) => unknown }, 'matches');
    const found = await store.search.searchEvidence(store, 'needle');
    expect(found.packets.map(packet => packet.sources[0]!.videoId)).toEqual(['healthyvid2']);
    // The missing blob is reported as a coverage gap, not silently omitted.
    expect(found.unavailableTranscripts).toBe(1);
    // The missing blob is read once, then excluded; one re-query reaches the healthy match.
    expect(read.mock.calls.filter(([version]) => version === broken)).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(2);
  }));

test('search stops when aborted between resolution batches', async () =>
  within('search-abort', async store => {
    const value = transcript();
    value.segments = Array.from({ length: 100 }, (_, index) => ({ text: index % 10 === 8 ? 'alpha beta' : 'filler', startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
    await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(store.search.searchEvidence(store, 'alpha beta', controller.signal)).rejects.toThrow('cancelled');
  }));

test('quoted underscore phrase remains in returned evidence', async () =>
  within('review-phrase-4132261', async store => {
    const value = transcript();
    value.segments = ['foo x bar extra', 'foo_bar'].map((text, i) => ({ text, startMs: i * 1000, endMs: (i + 1) * 1000, durationMs: 1000 }));
    await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(id);
    const found = await store.search.searchEvidence(store, 'foo_bar extra');
    expect(found.packets.flatMap(p => p.excerpts.map(e => e.text))).toEqual(expect.arrayContaining(['foo x bar extra', 'foo_bar']));
  }));


test.each([{ missingCount: 4, healthy: true }, { missingCount: 6, healthy: false }])('search exhausts unavailable sources without rereading them: %j', async ({ missingCount, healthy }) =>
  within(`search-missing-exhaustion-${missingCount}-${healthy}`, async (store, _reopen, sql) => {
    for (let i = 0; i < missingCount; i++) {
      const value = { ...transcript(), videoId: `missingvid${i}` };
      value.segments = Array.from({ length: 250 }, (_, index) => ({ text: 'needle', startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
      const saved = await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(value.videoId);
      const key = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', saved.assetVersions![0]!).one().blob_key;
      await env.RESEARCH.delete(key);
    }
    if (healthy) {
      const value = { ...transcript('needle ' + 'padding '.repeat(100)), videoId: 'healthyvid3' };
      await sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(value.videoId);
    }
    const read = vi.spyOn(store, 'read');
    const found = await store.search.searchEvidence(store, 'needle');
    expect(found.packets.flatMap(p => p.sources.map(s => s.videoId))).toEqual(healthy ? ['healthyvid3'] : []);
    expect(found.unavailableTranscripts).toBe(missingCount);
    expect(read).toHaveBeenCalledTimes(missingCount + Number(healthy));
    expect(new Set(read.mock.calls.map(([version]) => version)).size).toBe(read.mock.calls.length);
  }));

test('index repair and search resolution share the transcript read cache', async () =>
  within('search-repair-shared-read', async (store, _reopen, sql) => {
    await sessionProvider(provider(), store).transcript(id);
    sql.exec("DELETE FROM session_context_fts WHERE owner LIKE 'asset:%'");
    sql.exec('DELETE FROM session_search_assets');
    const read = vi.spyOn(store, 'read');
    expect((await store.search.searchEvidence(store, 'clear opening')).packets).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![1]).toBe(false);
  }));

test('search advances beyond a full page of stale candidates without an unreadable transcript', async () =>
  within('search-stale-candidate-page', async (store, _reopen, sql) => {
    await sessionProvider(provider(vi.fn(async () => ({ value: transcript('needle ' + 'padding '.repeat(100)), cacheStatus: 'miss' as const }))), store).transcript(id);
    // Old unresolved packet references have no transcript owner to exclude.
    for (let index = 0; index < 230; index++) sql.exec(
      'INSERT INTO session_context_fts (id,owner,scope,content,metadata) VALUES (?,?,?,?,?)',
      `stale:${index}`, `packet:stale:${index}`, 'evidence', 'needle', JSON.stringify({ packetId: `stale:${index}` }));
    const found = await store.search.searchEvidence(store, 'needle');
    expect(found.packets).toHaveLength(1);
    expect(found.packets[0]!.sources[0]!.videoId).toBe(id);
  }));

async function saveCaptions(store: SessionEvidenceStore, videoId: string, texts: string[]) {
  const value = { ...transcript(), videoId };
  value.segments = texts.map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000 }));
  return sessionProvider(provider(vi.fn(async () => ({ value, cacheStatus: 'miss' as const }))), store).transcript(videoId);
}
const returnedTexts = (found: { packets: EvidencePacket[] }) => found.packets.flatMap(packet => packet.excerpts.map(excerpt => excerpt.text));

test('window trimming follows the index tokenizer for Unicode punctuation', async () =>
  within('search-trim-unicode-punctuation', async store => {
    const texts = Array.from({ length: 12 }, (_, index) => `it’s filler number ${index} — “quoted”`);
    texts[5] = 'don’t forget useEffect';
    texts[6] = 'its cleanup — function runs';
    await saveCaptions(store, id, texts);
    // Curly quotes and dashes appear in every caption; trimming must still apply.
    expect(returnedTexts(await store.search.searchEvidence(store, 'useEffect cleanup'))).toEqual([texts[5], texts[6]]);
  }));

test('Hindi words match whole and windows trim to the matching captions', async () =>
  within('search-trim-hindi', async store => {
    const texts = Array.from({ length: 12 }, (_, index) => `यह भराव वाक्य ${index} है`);
    texts[5] = 'आज हम रिएक्ट';
    texts[6] = 'सीखेंगे दोस्तों';
    await saveCaptions(store, id, texts);
    // Vowel signs are part of the word, so a single Hindi word is searchable.
    expect(returnedTexts(await store.search.searchEvidence(store, 'रिएक्ट'))).toEqual([texts[5]]);
    expect(returnedTexts(await store.search.searchEvidence(store, 'रिएक्ट सीखेंगे'))).toEqual([texts[5], texts[6]]);
  }));

test.each([
  ['phrase alone', 'foo_bar'],
  ['phrase with another term', 'call foo_bar'],
])('a phrase crossing a caption boundary keeps both captions (%s)', async (_name, query) =>
  within(`search-trim-cross-phrase-${query.length}`, async store => {
    const texts = Array.from({ length: 12 }, (_, index) => `filler ${index}`);
    texts[2] = 'foo alone';
    texts[4] = 'bar alone';
    texts[6] = 'we call foo';
    texts[7] = 'bar here';
    await saveCaptions(store, id, texts);
    // Only the adjacent pair contains the phrase "foo bar"; the separate words do not.
    expect(returnedTexts(await store.search.searchEvidence(store, query))).toEqual([texts[6], texts[7]]);
  }));

test('a failed transcript read is remembered across cache evictions', async () =>
  within('search-failure-across-evictions', async (store, _reopen, sql) => {
    const saved = await saveCaptions(store, 'brokenvid01', Array.from({ length: 250 }, () => 'needle'));
    const broken = saved.assetVersions![0]!;
    await env.RESEARCH.delete(sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', broken).one().blob_key);
    const healthy: string[] = [];
    for (let index = 0; index < 6; index++) {
      const videoId = `healthyev${String(index).padStart(2, '0')}`;
      healthy.push(videoId);
      await saveCaptions(store, videoId, ['needle ' + 'padding '.repeat(20 + index)]);
    }
    const read = vi.spyOn(store, 'read');
    const found = await store.search.searchEvidence(store, 'needle');
    // Six healthy transcripts exceed the four-transcript cache, yet the broken
    // blob is requested once for the whole search.
    expect(read.mock.calls.filter(([version]) => version === broken)).toHaveLength(1);
    expect(new Set(found.packets.flatMap(packet => packet.sources.map(source => source.videoId)))).toEqual(new Set(healthy));
    expect(found.unavailableTranscripts).toBe(1);
  }));
