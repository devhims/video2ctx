import type { Transcript } from 'all-things-youtube';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChapterExtractor } from '../src/agents/providers/youtube/chapter-extractor';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import { chapterPointCoverage, evidencePacketForModel, finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';
import { createTranscriptRetrieval, preloadVideoChapters, type TranscriptRetrievalOptions } from '../src/agents/runtime/transcript-retrieval';
import { buildPassages } from '../src/lib/video-index/passages';
import { normalize } from '../src/lib/video-index/vectors';

const storage = vi.hoisted(() => ({ read: vi.fn() }));
const build = vi.hoisted(() => ({ start: vi.fn(async () => 'started') }));
vi.mock('../src/lib/video-index/storage', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/video-index/storage')>(), readTranscriptIndex: storage.read,
}));
const catalog = vi.hoisted(() => ({ currentReference: vi.fn() }));
vi.mock('../src/lib/video-catalog', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/video-catalog')>(), videoCatalog: () => catalog,
}));
vi.mock('../src/lib/video-index/build', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/video-index/build')>(), startTranscriptIndexBuild: build.start,
}));

const VIDEO = 'abcdefghijk';
const HASH = 'b'.repeat(64);
const reference = { videoId: VIDEO, kind: 'transcript', variant: '{"language":"default","granularity":"word"}', contentHash: HASH };
const segments = Array.from({ length: 400 }, (_, index) => ({
  startMs: index * 3_000, endMs: index * 3_000 + 3_000, durationMs: 3_000,
  text: `This is caption ${index} with several spoken words${index % 6 === 5 ? '.' : ''}`,
}));
const transcript: Transcript = {
  videoId: VIDEO, segments, text: '',
  track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
  meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-19T00:00:00Z', partial: false, warnings: [] },
};
const passages = buildPassages(segments);
const unit = (index: number) => normalize(Array.from({ length: 8 }, (_, i) => i === index % 8 ? 1 : 0.01));
const index = { captionCount: 400, dims: 8, passages, vectors: passages.map((_, i) => unit(i)) };
const chapters = { captionCount: 400, dims: 8, vectors: [unit(5), unit(6)], chapters: [
  { index: 0, first: 0, last: 199, title: 'Opening demo', summary: 'The opening demo.' },
  { index: 1, first: 200, last: 399, title: 'Pricing and availability', summary: 'Plans and dates.' },
] };
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };

function embedQueryAs(vector: Float32Array) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    data: [{ index: 0, embedding: [...vector] }], usage: { total_tokens: 12 } })));
}

function extractor(points: (first: number) => { point: string; caption: number }[] = first => [{ point: `Point at ${first}.`, caption: first + 3 }]) {
  return createChapterExtractor(new MockLanguageModelV4({ doGenerate: async options => {
    const user = JSON.stringify(options.prompt);
    const first = Number(/\[(\d+)\]/.exec(user)![1]);
    return { content: [{ type: 'text', text: JSON.stringify({ points: points(first) }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } }), undefined, 'test');
}

function retrieval(overrides: Partial<TranscriptRetrievalOptions> = {}) {
  const events: [string, Record<string, unknown>][] = [];
  const access = createTranscriptRetrieval({
    env: { FIREWORKS_API_KEY: 'fw', AGENT_TRANSCRIPT_RETRIEVAL: 'index' } as unknown as Env,
    mode: 'index', runId: 'run-1', question: 'What happened in the opening demo?', router: 'classifier',
    evidenceTokens: 2_000, chapterMinutes: 3.5, extractionConcurrency: 8, extractChapters: extractor(),
    onEvent: (type, payload) => events.push([type, payload]), ...overrides,
  });
  return { access, events };
}

function toolContext(policyRetrieval: ReturnType<typeof retrieval>['access'] | undefined, catalogVersions = [reference]) {
  return {
    runId: 'run-1',
    signal: new AbortController().signal,
    provider: { transcript: vi.fn(async () => ({ cacheStatus: 'hit' as const, value: transcript, assetVersions: ['c'.repeat(64)], catalogVersions })) },
    transcriptSelection: { allowReplacement: false, attempted: new Set(), unavailable: new Set(), regionRestricted: new Set() },
    transcriptPolicy: { mode: 'complete_transcript', retrieval: policyRetrieval },
    executeEvidenceTool: async (execution: { execute: () => Promise<unknown> }) => execution.execute(),
    finalize: vi.fn(),
  } as unknown as AgentToolContext;
}

beforeEach(() => {
  storage.read.mockReset();
  build.start.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('transcript retrieval plan', () => {
  it('uses today\'s path and starts the build when no index is ready', async () => {
    storage.read.mockResolvedValue({});
    const { access, events } = retrieval();
    const plan = await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(plan).toEqual({ mode: 'complete_transcript', reason: 'index_not_ready' });
    expect(build.start).toHaveBeenCalledWith(expect.anything(), { videoId: VIDEO, variant: reference.variant, contentHash: HASH }, 'question');
    expect(events[0]).toEqual(['transcript.retrieval', expect.objectContaining({ mode: 'complete_transcript', fallbackReason: 'index_not_ready', runId: 'run-1' })]);
  });

  it('defaults a missing scope to topic: plain passage search within the budget', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    embedQueryAs(unit(3));
    const { access, events } = retrieval();
    const plan = await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(plan).toMatchObject({ mode: 'passage_retrieval', scope: 'topic' });
    if (plan.mode !== 'passage_retrieval') throw new Error('unexpected plan');
    expect(plan.chapter).toBeUndefined();
    expect(plan.evidenceTokens).toBeLessThanOrEqual(2_000);
    expect(events.at(-1)![1]).toMatchObject({ mode: 'passage_retrieval', scope: 'topic', scopeSource: 'default' });
    // The index stays ready, so the build is not started again.
    expect(build.start).not.toHaveBeenCalled();
  });

  it('adds the best-matching chapter for one_part questions', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    embedQueryAs(unit(6));
    const { access } = retrieval({ scope: 'one_part' });
    const plan = await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(plan).toMatchObject({ mode: 'passage_retrieval', scope: 'one_part', chapter: { index: 1, title: 'Pricing and availability' } });
  });

  it('falls back to plain search for one_part when chapters are not ready, and starts the build', async () => {
    storage.read.mockResolvedValue({ index });
    embedQueryAs(unit(6));
    const { access } = retrieval({ scope: 'one_part' });
    const plan = await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(plan).toMatchObject({ mode: 'passage_retrieval', scope: 'one_part' });
    expect('chapter' in plan && plan.chapter).toBeFalsy();
    expect(build.start).toHaveBeenCalledTimes(1);
  });

  it('extracts chapter points for whole-video questions, and uses today\'s path without chapters', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    const { access, events } = retrieval({ scope: 'whole_video' });
    const plan = await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(plan).toMatchObject({ mode: 'chapter_extraction', failedChapters: [] });
    if (plan.mode !== 'chapter_extraction') throw new Error('unexpected plan');
    expect(plan.chapters.map(chapter => chapter.points)).toEqual([[{ point: 'Point at 0.', caption: 3 }], [{ point: 'Point at 200.', caption: 203 }]]);
    expect(events.map(([type]) => type)).toEqual(['transcript.extraction', 'transcript.retrieval']);
    storage.read.mockResolvedValue({ index });
    const without = retrieval({ scope: 'whole_video' });
    expect(await without.access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal }))
      .toMatchObject({ mode: 'complete_transcript', reason: 'chapters_not_ready' });
  });

  it('logs the selection but keeps today\'s path in shadow mode', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    embedQueryAs(unit(3));
    const { access, events } = retrieval({ mode: 'shadow' });
    const plan = await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(plan).toMatchObject({ mode: 'complete_transcript', reason: 'shadow' });
    expect(events[0]![1]).toMatchObject({ fallbackReason: 'shadow', retrieval: 'shadow' });
    expect((events[0]![1].passages as number[]).length).toBeGreaterThan(0);
  });

  it('never uses an index whose caption count differs from the session transcript', async () => {
    storage.read.mockResolvedValue({ index: { ...index, captionCount: 399 }, chapters });
    const { access } = retrieval();
    expect(await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal }))
      .toMatchObject({ mode: 'complete_transcript', reason: 'caption_count_mismatch' });
  });

  it('falls back when the question cannot be embedded, or without a catalog version', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
    expect(await retrieval().access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal }))
      .toMatchObject({ mode: 'complete_transcript', reason: 'embedding_failed' });
    expect(await retrieval().access.resolve({ videoId: VIDEO, segments, reference: undefined, signal: new AbortController().signal }))
      .toMatchObject({ mode: 'complete_transcript', reason: 'no_catalog_version' });
  });

  it('decides once per transcript version per run', async () => {
    storage.read.mockResolvedValue({});
    const { access } = retrieval();
    await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    storage.read.mockResolvedValue({ index, chapters });
    expect(await access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal }))
      .toMatchObject({ mode: 'complete_transcript', reason: 'index_not_ready' });
    expect(storage.read).toHaveBeenCalledTimes(1);
  });

  it('routes with Jev when configured, keeping the classifier scope if Jev fails', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('typesafe')
      ? new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { route: { choice: 'whole_video' } } }))
      : new Response('down', { status: 500 }));
    const jev = retrieval({ router: 'jev', scope: 'topic',
      env: { FIREWORKS_API_KEY: 'fw', JEV_API_KEY: 'jev', AGENT_TRANSCRIPT_RETRIEVAL: 'index' } as unknown as Env });
    expect(await jev.access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal }))
      .toMatchObject({ mode: 'chapter_extraction' });
    expect(jev.events.at(-1)![1]).toMatchObject({ scopeSource: 'jev' });
  });
});

describe('preloading chapter titles for the classifier', () => {
  it('reads the saved transcript\'s index once and reuses it for the run', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    const session = {
      brief: () => ({ assets: [{ version: 'v1', kind: 'transcript' as const, videoId: VIDEO, collectedAt: 1, current: true, details: {} }], memories: [] }),
      transcriptCatalogReference: (version: string) => version === 'v1' ? reference : undefined,
    };
    const env = { FIREWORKS_API_KEY: 'fw' } as unknown as Env;
    const preload = await preloadVideoChapters({ env, session, videoIds: [VIDEO], chapterMinutes: 3.5 });
    expect(preload.videoChapters).toEqual([{ videoId: VIDEO, titles: ['Opening demo', 'Pricing and availability'] }]);
    embedQueryAs(unit(3));
    await retrieval({ preloaded: preload.preloaded }).access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal });
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect((await preloadVideoChapters({ env, session, videoIds: [VIDEO, 'zyxwvutsrqp'], chapterMinutes: 3.5 })).videoChapters).toEqual([]);
  });

  it('uses the catalog\'s current transcript version for a first question about a video', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    catalog.currentReference.mockResolvedValue(reference);
    const preload = await preloadVideoChapters({ env: {} as Env, videoIds: [VIDEO], chapterMinutes: 3.5 });
    expect(catalog.currentReference).toHaveBeenCalledWith({ videoId: VIDEO, kind: 'transcript', variant: '{"language":"default","granularity":"word"}' });
    expect(preload.videoChapters[0]!.titles).toEqual(['Opening demo', 'Pricing and availability']);
    catalog.currentReference.mockResolvedValue(null);
    expect((await preloadVideoChapters({ env: {} as Env, videoIds: [VIDEO], chapterMinutes: 3.5 })).videoChapters).toEqual([]);
  });

  it('does not hold classification for a slow read, and research reuses it', async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: unknown) => void = () => {};
      storage.read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const session = {
        brief: () => ({ assets: [{ version: 'v1', kind: 'transcript' as const, videoId: VIDEO, collectedAt: 1, current: true, details: {} }], memories: [] }),
        transcriptCatalogReference: () => reference,
      };
      const pending = preloadVideoChapters({ env: {} as Env, session, videoIds: [VIDEO], chapterMinutes: 3.5 });
      await vi.advanceTimersByTimeAsync(1_500);
      const preload = await pending;
      expect(preload.videoChapters).toEqual([]);
      finish({ index, chapters });
      expect(await preload.preloaded.get(HASH)).toMatchObject({ chapters: { captionCount: 400 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('get_video_transcript with an index', () => {
  it('returns only the selected caption excerpts, with the complete transcript\'s IDs', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    embedQueryAs(unit(3));
    const packet = await executeGetVideoTranscript({ videoId: VIDEO }, toolContext(retrieval().access), 'call-1');
    expect(packet.excerpts.length).toBeGreaterThan(10);
    expect(packet.excerpts.length).toBeLessThan(400);
    expect(packet.excerpts[0]!.id).toMatch(new RegExp(`^transcript:${VIDEO}:\\d+:\\d+:0$`));
    expect(packet.artifacts[0]).toMatchObject({ type: 'youtube_transcript_retrieval', data: { mode: 'passage_retrieval', scope: 'topic', segmentCount: 400 } });
    expect(packet.continuation).toBeUndefined();
    expect(packet.usage).toHaveLength(1);
    const model = evidencePacketForModel(packet);
    expect(model.excerpts).toHaveLength(packet.excerpts.length);
    expect(model.transcriptRetrieval).toMatchObject({ mode: 'passage_retrieval', note: expect.stringContaining('not the whole transcript') });
  });

  it('returns the complete transcript when retrieval falls back', async () => {
    storage.read.mockResolvedValue({});
    const packet = await executeGetVideoTranscript({ videoId: VIDEO }, toolContext(retrieval().access), 'call-1');
    expect(packet.excerpts).toHaveLength(400);
    expect(packet.artifacts[0]!.type).toBe('youtube_complete_transcript');
  });

  it('prefers the session\'s pinned catalog reference', async () => {
    storage.read.mockResolvedValue({});
    const context = toolContext(retrieval().access, []);
    (context as { session?: unknown }).session = { transcriptCatalogReference: () => reference };
    await executeGetVideoTranscript({ videoId: VIDEO }, context, 'call-1');
    expect(storage.read).toHaveBeenCalledWith(expect.anything(), { videoId: VIDEO, variant: reference.variant, contentHash: HASH }, 3.5);
  });

  it('turns chapter points into caption excerpts the finalizer can cite', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    const packet = await executeGetVideoTranscript({ videoId: VIDEO }, toolContext(retrieval({ scope: 'whole_video' }).access), 'call-1');
    expect(packet.excerpts.map(excerpt => excerpt.text)).toEqual([
      'This is caption 3 with several spoken words', 'This is caption 4 with several spoken words', 'This is caption 5 with several spoken words.',
      'This is caption 203 with several spoken words.', 'This is caption 204 with several spoken words', 'This is caption 205 with several spoken words',
    ]);
    const data = packet.artifacts[0]!.data as { chapters: { points: { excerptIds: string[] }[] }[] };
    expect(data.chapters[0]!.points[0]!.excerptIds).toEqual([packet.excerpts[0]!.id]);
    expect(chapterPointCoverage([packet])).toHaveLength(2);
    const prepared = finalizationEvidenceForModel([packet], 60_000);
    expect(prepared.missingInputs).toEqual([]);
    const shown = prepared.evidence[0]!.transcriptRetrieval!.chapters![0]!.points[0]!.excerptIds[0]!;
    expect(shown).toMatch(/^ref_\d+$/);
    expect(prepared.fullIds.get(shown)).toBe(packet.excerpts[0]!.id);
  });

  it('reports a chapter whose extraction failed as partial evidence', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    const failing = createChapterExtractor(new MockLanguageModelV4({ doGenerate: async options => {
      if (JSON.stringify(options.prompt).includes('[200]')) throw new Error('provider down');
      return { content: [{ type: 'text', text: JSON.stringify({ points: [{ point: 'Opening point.', caption: 10 }, { point: 'Outside.', caption: 250 }] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } }), undefined, 'test');
    const packet = await executeGetVideoTranscript({ videoId: VIDEO }, toolContext(retrieval({ scope: 'whole_video', extractChapters: failing }).access), 'call-1');
    expect(packet.warnings).toEqual([expect.objectContaining({ code: 'PARTIAL_EVIDENCE', message: expect.stringContaining('"Pricing and availability" (10:00 to 20:00)') })]);
    const data = packet.artifacts[0]!.data as { chapters: { points: unknown[]; failed?: boolean }[]; failedChapters: number[] };
    // A point citing a caption outside its chapter is dropped.
    expect(data.chapters[0]!.points).toHaveLength(1);
    expect(data.failedChapters).toEqual([1]);
  });
});
