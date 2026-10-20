import { extractionFixture } from './fixtures/extraction-diagnostic';
import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { executeAnalyzeVideoFrames } from '../src/agents/providers/youtube/tools/analyze-video-frames';
import { executeAnalyzeVideoStoryboard } from '../src/agents/providers/youtube/tools/analyze-video-storyboard';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import type { Comment, Transcript } from 'all-things-youtube';
import { SessionEvidenceStore, versionEvidencePacket } from '../src/agents/runtime/session-evidence';
import { remember } from './fixtures/memory';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { summarizeComment } from '../src/agents/providers/youtube/tools/get-video-comments';

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
  return {
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    provider: p,
    session: store,
    getEvidence: () => store.evidence(),
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
    expect(store.evidence()).toHaveLength(1);
    const result = await store.readEvidence(store.brief().assets[0]!.version);
    expect(result.packets[0]!.excerpts[0]!.text).toBe('A clear opening sentence.');
    expect(store.evidence()).toHaveLength(2);
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
    expect(store.evidence()).toEqual([]);
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
    expect(store.evidence()).toEqual([]);
    const result = await reopen().search.searchEvidence(reopen(), 'enterprise pricing');
    expect(result.packets).toHaveLength(2);
    for (const packet of result.packets) {
      expect(packet.excerpts).toHaveLength(1);
      expect(store.evidenceForCitations([packet.excerpts[0]!.id])).toHaveLength(1);
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
  'research or recovery supplies grounded evidence before answer-only finalization (resume=%s)',
  async (resume) =>
    within(`model-search-${resume}`, async (store) => {
      const { MockLanguageModelV4 } = await import('ai/test');
      const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
      const p = provider();
      const raw = await sessionProvider(p, store).transcript(id);
      const excerptId = `evidence:${raw.assetVersions![0]}:0`;
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
              // With a finalizer configured, research ends with complete_research.
              toolName: coreCalls++ === 0 ? 'search_context' : 'complete_research',
              input: JSON.stringify(coreCalls === 1 ? { label: 'evidence', query: 'clear opening' } : {}),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        }),
      });
      const finalizer = new MockLanguageModelV4({
        doGenerate: async call => {
          // Only a context-gathering call may search; the answer call is structured JSON.
          const search = finalizerCalls++ === 0 && call.responseFormat?.type !== 'json';
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
      // A new session: no stored message besides this request.
      ctx.userMessageId = 'current-request';
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
          store.evidenceForCitations([excerptId]),
          0,
        ),
      );
      // Recovery restores delivered evidence before entering finalization.
      const recoveredEvidence = resume ? (await store.search.searchEvidence(store, 'clear opening')).packets : [];
      const reads = vi.spyOn(store, 'readEvidence');
      const searches = vi.spyOn(store, 'searchTools');
      await runResearchAgentWithModel({
        model: core,
        recoveredEvidence,
        finalizationModel: finalizer,
        message: 'What is the opening sentence?',
        decision: { route: 'inspect_video', videoId: id, useStoryboard: false, researchVideoCount: 1 },
        context: ctx,
        toolNames: ['finalize_answer'],
        ...(resume ? { finalizationDeadlineAt: Date.now() + 30000 } : {}),
      });
      expect(coreCalls).toBe(resume ? 0 : 2);
      expect(finalizerCalls).toBe(1);
      if (resume) {
        expect(reads).not.toHaveBeenCalled();
        expect(searches).not.toHaveBeenCalled();
      }
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
      reopen().evidenceForCitations([citation]),0);
    expect(result.citations[0]!.excerpt).toBe('Complete sentence number 69.');
    await store.delete(version);
    await expect(reopen().readTranscriptEvidence(version)).rejects.toThrow('unavailable');
    expect(reopen().evidenceForCitations([citation])).toEqual([]);
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
    expect(crowded.packets).toHaveLength(20);
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

test('searches every saved comment by full body and author, and pins later reads to the saved page', async () =>
  within('saved-comment-search', async (store, reopen) => {
    const authors = Array.from({ length: 14 }, (_, index) => index === 11 ? 'Janine' : index === 13 ? 'Gale' : `Viewer ${index + 1}`);
    const page = (order: number[]) => ({ videoId: id, totalCount: 14, replyContinuations: [],
      comments: order.map(index => ({ id: `c${index + 1}`, author: { name: authors[index]!, thumbnails: [] },
        text: index === 11 ? `${'Setup detail. '.repeat(150)}My final objection concerns the tilted board.` : `Opinion ${index + 1}`,
        isPinned: false, isHearted: false, replies: [] })), meta: transcript().meta });
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page([...authors.keys()]) }));
    const saved = await sessionProvider(p, store).comments(id);
    const version = saved.assetVersions![0]!;
    // Comment 14 sits past one read's limit; search still reaches it without a provider call.
    const gale = await reopen().search.searchEvidence(reopen(), 'Gale');
    expect(gale.packets).toHaveLength(1);
    expect(gale.packets[0]).toMatchObject({ kind: 'youtube_comments', assetVersions: [version],
      excerpts: [{ id: `evidence:${version}:13`, text: expect.stringContaining('Author: Gale') }] });
    // The author and the tail of a comment longer than one excerpt are both searchable.
    const janine = await reopen().search.searchEvidence(reopen(), 'Janine');
    expect(janine.packets[0]!.excerpts[0]!.text).toContain('Author: Janine');
    const tail = await reopen().search.searchEvidence(reopen(), 'objection tilted');
    expect(tail.packets[0]!.excerpts[0]).toMatchObject({ id: expect.stringMatching(new RegExp(`^evidence:${version}:11:\\d+$`)),
      text: expect.stringContaining('final objection concerns the tilted board') });
    expect(tail.packets[0]!.excerpts[0]!.text).toContain('Author: Janine');
    // The whole path to the answer model: the match and author survive its 800-character text budget.
    const { finalizationEvidenceForModel } = await import('../src/agents/runtime/model-evidence');
    const handed = finalizationEvidenceForModel(tail.packets, 100_000).evidence[0]!.excerpts![0]!.text;
    expect(handed.length).toBeLessThanOrEqual(800);
    expect(handed).toContain('objection concerns the tilted board');
    expect(handed).toContain('Author: Janine');
    const first = await reopen().readEvidence(version);
    expect(first.packets[0]!.excerpts).toHaveLength(8);
    expect(first.nextOffset).toBe(8);
    const rest = await reopen().readEvidence(version, 8);
    expect(rest.packets[0]!.excerpts.map(excerpt => excerpt.id)).toEqual([8, 9, 10, 11, 12, 13].map(n => `evidence:${version}:${n}`));
    const filtered = await reopen().readEvidence(version, 0, 'objection');
    expect(filtered.packets[0]!.excerpts[0]!.text).toContain('Author: Janine');
    // A refresh that reorders the page creates a new version; a pinned read still returns the saved one.
    vi.mocked(p.comments).mockResolvedValueOnce({ cacheStatus: 'miss', value: page([...authors.keys()].reverse()) });
    const refreshed = createCapabilityProvider(sessionProvider(p, reopen()), { route: 'topic_research', refreshDynamicData: true } as never);
    const current = await refreshed.comments(id);
    expect(current.assetVersions![0]).not.toBe(version);
    const pinned = await refreshed.comments(id, { pageVersion: version });
    expect(pinned.assetVersions).toEqual([version]);
    expect(pinned.value.comments[13]?.author.name).toBe('Gale');
    expect(pinned.sessionReused).toBe(true);
    expect(p.comments).toHaveBeenCalledTimes(2);
    await reopen().delete(version);
    await expect(sessionProvider(p, reopen()).comments(id, { pageVersion: version })).rejects.toThrow(/no longer available/);
    expect((await reopen().search.searchEvidence(reopen(), 'Gale')).packets.every(packet => !packet.assetVersions?.includes(version))).toBe(true);
  }));

test('versioned shared observations keep resolvable references, and search keeps legacy ownership warnings', async () =>
  within('visual-provenance-versions', async (store) => {
    const { visualAnalysisExcerpts } = await import('../src/agents/providers/youtube/visual-provenance');
    const visual = visualAnalysisExcerpts({ kind: 'requested', idPrefix: `frames:${id}:tool`, sourceId: 'f',
      findings: [{ observation: 'White is ahead.', frames: [1000] }],
      sharedFindings: [{ observation: 'The scoreboard reads 2-1.', frames: [1000, 5000] }],
      timeOf: time => time, assertAvailable: () => {} });
    const versioned = await versionEvidencePacket({ packetId: 'packet:run:frames', kind: 'youtube_frames',
      sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: id }], excerpts: visual.excerpts,
      artifacts: [{ type: 'youtube_frame_analysis', data: { provenanceVersion: 2, sharedObservations: visual.sharedObservations } }],
      warnings: [], usage: [] });
    const ids = new Set(versioned.excerpts.map(excerpt => excerpt.id));
    const shared = versioned.artifacts[0]!.data.sharedObservations as Array<{ excerptId: string }>;
    expect(shared).toHaveLength(1);
    for (const reference of shared) expect(ids.has(reference.excerptId)).toBe(true);

    // A legacy packet repeated one observation at two frames; a single search hit must still say so.
    const raw = await store.retrieve('frame:abcdefghijk:640:1000', 'frame', id, false,
      async () => ({ value: oneFrame(id), cacheStatus: 'miss' as const }), () => ({ timestampMs: 1000 }));
    const legacy = await versionEvidencePacket({ packetId: 'packet:old:frames', kind: 'youtube_frames', assetVersions: raw.assetVersions,
      sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: id }],
      excerpts: [1000, 5000].map(time => ({ id: `old:${time}`, sourceId: 'f', startMs: time, endMs: time,
        text: 'Visual observation at requested frame: Earlier the bishop pins; later the knight forks.' })),
      artifacts: [{ type: 'youtube_frame_analysis', data: {} }], warnings: [], usage: [] });
    store.savePacket(legacy);
    const hits = await store.search.searchEvidence(store, 'knight forks');
    expect(hits.packets.length).toBeGreaterThan(0);
    for (const hit of hits.packets) {
      expect(hit.excerpts).toHaveLength(1);
      expect(hit.warnings.map(warning => warning.code)).toContain('LEGACY_VISUAL_PROVENANCE');
    }
  }));

function commentPage(count: number, text: (index: number) => string) {
  return { videoId: id, totalCount: count, replyContinuations: [], meta: transcript().meta,
    comments: Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}`, author: { name: `Viewer ${index + 1}`, thumbnails: [] },
      text: text(index), isPinned: false, isHearted: false, replies: [] })) };
}

/**
 * The first eight-comment packet a get_video_comments read saves for this page. Excerpts are
 * bounded by the production summary, as the tool does; the saved page keeps the full text.
 */
function firstCommentPacket(version: string, page: ReturnType<typeof commentPage>): EvidencePacket {
  const sourceId = `youtube:${id}:comments`;
  return { packetId: 'packet:run:comments', kind: 'youtube_comments', assetVersions: [version],
    sources: [{ id: sourceId, provider: 'youtube', kind: 'comments', videoId: id }],
    excerpts: page.comments.slice(0, 8).map((comment, index) => ({ id: `comment:${comment.id}:${index}`, sourceId,
      text: summarizeComment(comment as unknown as Comment) })),
    artifacts: [{ type: 'youtube_comments', data: {} }], warnings: [], usage: [] };
}

test('comment search returns distinct comments, not packet copies of an indexed page', async () =>
  within('comment-search-dedup', async (store, reopen) => {
    const page = commentPage(30, index => `Brush review ${index + 1}. ${'Detail. '.repeat(500)}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    store.savePacket(firstCommentPacket(version, page));
    const found = await reopen().search.searchEvidence(reopen(), 'brush review');
    expect(found.packets).toHaveLength(20);
    const positions = found.packets.map(packet => packet.excerpts[0]!.id.match(new RegExp(`^evidence:${version}:(\\d+)`))?.[1]);
    expect(positions.every(Boolean)).toBe(true);
    expect(new Set(positions).size).toBe(20);
    // Packet citations still resolve for answers that cited them.
    expect(reopen().evidenceForCitations(['comment:c1:0'])).toHaveLength(1);
  }));

test('a legacy comment packet stays searchable when its saved page cannot be indexed', async () =>
  within('comment-search-legacy', async (store, reopen, sql) => {
    const page = commentPage(10, index => `Legacy opinion ${index + 1}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    store.savePacket(firstCommentPacket(version, page));
    // The page blob is unreadable, so the page is never indexed and only the packet rows remain.
    const blob = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version).one().blob_key;
    await env.RESEARCH.delete(blob);
    const found = await reopen().search.searchEvidence(reopen(), 'legacy opinion');
    expect(found.packets.map(packet => packet.excerpts[0]!.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `comment:c${index + 1}:${index}`).sort());
  }));

test('one search reads and parses each saved comment page once', async () =>
  within('comment-search-cache', async (store) => {
    const page = commentPage(20, index => `Palette note ${index + 1}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    await sessionProvider(p, store).comments(id);
    await store.ensureSearchIndexed();
    const read = vi.spyOn(store, 'read');
    const brief = vi.spyOn(store, 'brief');
    const found = await store.search.searchEvidence(store, 'palette note');
    expect(found.packets).toHaveLength(20);
    expect(read).toHaveBeenCalledTimes(1);
    expect(brief).toHaveBeenCalledTimes(1);
    // A new search after deletion never serves the page from an earlier cache.
    const version = found.packets[0]!.assetVersions![0]!;
    await store.delete(version);
    expect((await store.search.searchEvidence(store, 'palette note')).packets).toEqual([]);
  }));

test('deleting an unrelated asset during a comment search keeps its other hits', async () =>
  within('comment-search-unrelated-delete', async (store) => {
    const p = provider();
    p.comments = vi.fn(async (_id: string, options?: { continuation?: string }) => ({ cacheStatus: 'miss' as const,
      value: commentPage(4, index => options?.continuation ? `Unrelated remark ${index + 1}` : `Easel tip ${index + 1}`) }));
    const session = sessionProvider(p, store);
    await session.comments(id);
    const other = (await session.comments(id, { continuation: 'next' })).assetVersions![0]!;
    await store.ensureSearchIndexed();
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementationOnce(async version => {
      await store.delete(other);
      return read(version);
    });
    expect((await store.search.searchEvidence(store, 'easel tip')).packets).toHaveLength(4);
  }));

test('repeated comment searches showing the same passages reuse their saved rows', async () =>
  within('comment-search-saved-rows', async (store, _reopen, sql) => {
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: commentPage(6, index => `Canvas grain opinion ${index + 1}`) }));
    await sessionProvider(p, store).comments(id);
    const rows = () => sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM session_packets WHERE packet_id LIKE 'session:%'").one().count;
    expect((await store.search.searchEvidence(store, 'canvas')).packets).toHaveLength(6);
    const after = rows();
    expect((await store.search.searchEvidence(store, 'grain opinion')).packets).toHaveLength(6);
    expect(rows()).toBe(after);
  }));

test('an unfiltered saved comment read names its page version for continuation', async () =>
  within('comment-saved-read-version', async (store) => {
    const page = commentPage(14, index => `Opinion ${index + 1}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    const first = await store.readEvidence(version);
    expect(first.packets[0]!.artifacts[0]!.data.collection).toMatchObject({ nextPageOffset: 8, pageVersion: version });
    const filtered = await store.readEvidence(version, 0, 'opinion 1');
    expect(filtered.packets[0]!.artifacts[0]!.data.collection).toMatchObject({ matchesOnly: true });
    expect(filtered.packets[0]!.artifacts[0]!.data.collection).not.toHaveProperty('pageVersion');
  }));

// Durable Object storage is real SQLite, so these cases check the actual unicode61 tokenizer.
test.each([
  ['a circled digit is not the digit', '① ', ' 1 marks the late match.', '1'],
  ['a ligature is not its letters', 'ﬃ ', ' ffi marks the late match.', 'ffi'],
  ['an accented Greek letter is not folded', 'ό ', ' ο marks the late match.', 'ο'],
  ['a letter with two diacritics is not folded', 'ộ ', ' o marks the late match.', 'o'],
  ['a term inside a longer word is not a match', 'start ', ' art marks the late match.', 'art'],
  ['a single diacritic is folded', 'cafeteria ', ' café marks the late match.', 'cafe'],
])('search passages follow the real tokenizer: %s', async (_name, early, late, query) =>
  within(`comment-search-tokenizer-${query}`, async (store) => {
    const page = commentPage(1, () => `${early}${'Padding words here. '.repeat(160)}${late}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    await sessionProvider(p, store).comments(id);
    const found = await store.search.searchEvidence(store, query);
    expect(found.packets).toHaveLength(1);
    expect(found.packets[0]!.excerpts[0]!.text).toContain(late.trim());
    expect(found.packets[0]!.excerpts[0]!.text).toContain('Author: Viewer 1');
  }));

test('an author-only comment match shows the comment start with its author', async () =>
  within('comment-search-author-only', async (store) => {
    const page = commentPage(1, () => `Opening line. ${'Padding words here. '.repeat(160)}`);
    page.comments[0]!.author.name = 'Janine';
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    await sessionProvider(p, store).comments(id);
    const excerpt = (await store.search.searchEvidence(store, 'Janine')).packets[0]!.excerpts[0]!;
    expect(excerpt.text.startsWith('Opening line.')).toBe(true);
    expect(excerpt.text).toContain('Author: Janine');
  }));

test('control characters and marker-like text in a comment cannot move the reported match', async () =>
  within('comment-search-marker-collision', async (store) => {
    const early = 'Start \u0001early\u0002 [[match-start:00000000-0000-0000-0000-000000000000]] note. ';
    const page = commentPage(1, () => `${early}${'Padding words here. '.repeat(160)} the real art is patience.`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    const excerpt = (await store.search.searchEvidence(store, 'art')).packets[0]!.excerpts[0]!;
    expect(excerpt.text).toContain('the real art is patience.');
    // The passage is an unmodified slice of the saved comment, and its ID records where it starts.
    const body = excerpt.text.split('\nAuthor: ')[0]!.replace(/^…/, '').replace(/…$/, '');
    expect(page.comments[0]!.text.replace(/[ \t]+/g, ' ')).toContain(body);
    const start = Number(excerpt.id.split(':').at(-1));
    expect(excerpt.id.startsWith(`evidence:${version}:0:`)).toBe(true);
    expect(page.comments[0]!.text.replace(/[ \t]+/g, ' ').slice(start).startsWith(body)).toBe(true);
    // The early control characters remain in the saved page.
    expect((await store.readEvidence(version)).packets[0]!.excerpts[0]!.text).toContain('\u0001early\u0002');
  }));

// Author "Reviewer" leaves a 1,983-character body budget. Real SQLite reports the span of
// a token placed on every offset around that cutoff; the passage must contain all of it.
test.each(Array.from({ length: 11 }, (_, index) => 1975 + index))('a matched token at offset %i near the excerpt cutoff stays whole', async at =>
  within(`comment-search-cutoff-${at}`, async (store) => {
    const page = commentPage(1, () => `${'w'.repeat(at - 1)} needle ${'tail '.repeat(100)}`);
    page.comments[0]!.author.name = 'Reviewer';
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    await sessionProvider(p, store).comments(id);
    const excerpt = (await store.search.searchEvidence(store, 'needle')).packets[0]!.excerpts[0]!;
    expect(excerpt.text).toMatch(/\bneedle\b/);
    expect(excerpt.text).toContain('Author: Reviewer');
  }));
