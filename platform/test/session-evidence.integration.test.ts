import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { executeAnalyzeVideoFrames } from '../src/agents/providers/youtube/tools/analyze-video-frames';
import { executeAnalyzeVideoStoryboard } from '../src/agents/providers/youtube/tools/analyze-video-storyboard';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
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
      { metadataOnly: true },
      { sheetIndexes: [0, 1], maxSheets: 2 },
      { sheetIndexes: [2], maxSheets: 1 },
    ]);
    await expect(sessionProvider(p, store).storyboard!(id, undefined, { sheetIndexes: [3] })).rejects.toThrow(
      'Invalid storyboard selection',
    );
    expect(storyboard).toHaveBeenCalledTimes(3);
    expect(store.brief().assets.filter((asset) => asset.kind === 'storyboard_sheet')).toHaveLength(3);
    const restored = reopen();
    const ctx = context(restored, p);
    ctx.analyzeStoryboard = vi.fn(async () => ({findings:[{observation:'A chart is shown.',frameIndexes:[2]}],warnings:[]}));
    const versions = restored.brief().assets.filter(asset => asset.kind === 'storyboard_sheet').map(asset => asset.version);
    const result = await executeAnalyzeVideoStoryboard({assetVersions:versions,focus:'Describe the chart.'},ctx,'analyze-sheets');
    expect(storyboard).toHaveBeenCalledTimes(3);
    expect(result.usage).toEqual([]);
    expect(result.excerpts[0]!.startMs).toBe(10000);
    expect(ctx.analyzeStoryboard).toHaveBeenCalledOnce();
    await restored.delete(versions[0]);
    await expect(executeAnalyzeVideoStoryboard({assetVersions:versions,focus:'Read the title.'},ctx,'deleted')).rejects.toThrow('unavailable or deleted');
    expect(storyboard).toHaveBeenCalledTimes(3);
    expect(ctx.analyzeStoryboard).toHaveBeenCalledOnce();

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
    store.remember(
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
    const tools = await store.searchTools((packets) => received.push(...packets), new AbortController().signal);
    expect(Object.keys(tools).sort()).toEqual(['read_session_history', 'search_context']);
    const options = { toolCallId: 'search', messages: [], context: {} };
    const run = async (label: string, query: string) =>
      JSON.parse(String(await tools.search_context!.execute!({ label, query }, options)));
    expect((await run('memory', 'enterprise pricing'))[0].topic).toBe('focus');
    store.remember(
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
    store.remember(
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
          store.evidenceForCitations([excerptId]),
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
      reopen().evidenceForCitations([citation]),0);
    expect(result.citations[0]!.excerpt).toBe('Complete sentence number 69.');
    await store.delete(version);
    await expect(reopen().readTranscriptEvidence(version)).rejects.toThrow('unavailable');
    expect(reopen().evidenceForCitations([citation])).toEqual([]);
  }));
