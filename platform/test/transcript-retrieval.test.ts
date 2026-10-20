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
    // The observation finishes after the complete transcript has been returned.
    await vi.waitFor(() => expect(events).toHaveLength(1));
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
    // A point cites the caption where it starts first, then its context captions.
    expect(data.chapters[0]!.points[0]!.excerptIds).toEqual(packet.excerpts.slice(0, 3).map(excerpt => excerpt.id));
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

describe('review fixes: optional retrieval never blocks the complete transcript', () => {
  const stalledFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })));

  it('falls back before the research deadline when the question embedding stalls', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    const fetch = stalledFetch();
    const started = Date.now();
    // 12 seconds stay reserved for the complete transcript, leaving half a second for retrieval.
    const plan = await retrieval().access.resolve({ videoId: VIDEO, segments, reference, signal: new AbortController().signal, deadlineAt: Date.now() + 12_500 });
    expect(plan).toMatchObject({ mode: 'complete_transcript', reason: 'retrieval_timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetch).toHaveBeenCalled();
  });

  it('returns the complete transcript at once in shadow mode, whatever retrieval is doing', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    stalledFetch();
    const started = Date.now();
    const packet = await executeGetVideoTranscript({ videoId: VIDEO }, toolContext(retrieval({ mode: 'shadow' }).access), 'call-1');
    expect(packet.excerpts).toHaveLength(400);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still propagates run cancellation', async () => {
    storage.read.mockResolvedValue({ index, chapters });
    stalledFetch();
    const controller = new AbortController();
    const pending = retrieval().access.resolve({ videoId: VIDEO, segments, reference, signal: controller.signal, deadlineAt: Date.now() + 60_000 });
    setTimeout(() => controller.abort(new Error('Cancelled by user')), 20);
    await expect(pending).rejects.toThrow('Cancelled by user');
  });

  it('bounds the whole chapter preload, version lookup included, and honors cancellation', async () => {
    vi.useFakeTimers();
    try {
      catalog.currentReference.mockReturnValue(new Promise(() => {}));
      const pending = preloadVideoChapters({ env: {} as Env, videoIds: [VIDEO], chapterMinutes: 3.5 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await pending).videoChapters).toEqual([]);
      const controller = new AbortController();
      const cancelled = preloadVideoChapters({ env: {} as Env, videoIds: [VIDEO], chapterMinutes: 3.5, signal: controller.signal });
      controller.abort(new Error('Cancelled by user'));
      await expect(cancelled).rejects.toThrow('Cancelled by user');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review fixes: whole-video evidence', () => {
  function longVideo(minutes: number, chapterCount: number) {
    const captions = Array.from({ length: minutes * 20 }, (_, index) => ({ startMs: index * 3_000, endMs: index * 3_000 + 3_000, durationMs: 3_000,
      text: `Caption ${String(index).padStart(5, '0')} explains one more step of the tutorial in plain spoken words here.` }));
    const size = Math.floor(captions.length / chapterCount);
    const plan = { mode: 'chapter_extraction' as const, scope: 'whole_video' as const, failedChapters: [],
      chapters: Array.from({ length: chapterCount }, (_, index) => ({ index, title: `Chapter ${index}`, first: index * size,
        last: index === chapterCount - 1 ? captions.length - 1 : (index + 1) * size - 1,
        points: [0, 1, 2, 3].map(offset => ({ point: `Chapter ${index} teaches point ${offset} with a full sentence of explanation.`, caption: index * size + offset * 10 })) })) };
    return { captions, plan };
  }

  // Review reproductions: 80.5 minutes with 23 chapters (276 excerpts), React with 27 chapters (324), and 119 minutes with 34.
  it.each([[81, 23, 276], [80, 27, 324], [119, 34, 408]])('keeps every chapter citable when %i minutes and %i chapters exceed the finalizer budget', async (minutes, chapterCount, excerpts) => {
    const { indexedTranscriptEvidence } = await import('../src/agents/providers/youtube/tools/get-video-transcript');
    const { captions, plan } = longVideo(minutes, chapterCount);
    const evidence = indexedTranscriptEvidence(VIDEO, captions, `youtube:${VIDEO}:transcript`, plan);
    const packet = { packetId: 'p', kind: 'youtube_transcript', sources: [{ id: `youtube:${VIDEO}:transcript`, provider: 'youtube', kind: 'transcript', videoId: VIDEO }],
      ...evidence, usage: [] } as never;
    expect(evidence.excerpts.length).toBe(excerpts);
    const prepared = finalizationEvidenceForModel([packet], 60_000);
    const shown = prepared.evidence[0]!;
    const ids = new Set(shown.excerpts!.map(excerpt => excerpt.id));
    const points = shown.transcriptRetrieval!.chapters!.flatMap(chapter => chapter.points);
    expect(shown.transcriptRetrieval!.chapters).toHaveLength(chapterCount);
    expect(shown.transcriptRetrieval!.chapters!.every(chapter => chapter.points.length > 0)).toBe(true);
    expect(points.length).toBeGreaterThanOrEqual(chapterCount);
    expect(points.every(point => point.excerptIds.length > 0 && point.excerptIds.every(id => ids.has(id)))).toBe(true);
    expect(shown.warnings.map(warning => warning.code)).toContain('TRANSCRIPT_CONTEXT_TRUNCATED');
    expect(JSON.stringify(prepared.evidence).length).toBeLessThanOrEqual(60_000);
  });

  it('marks a chapter whose nonempty answer cites only captions outside it as not covered, after one repair', async () => {
    const calls: string[] = [];
    const extract = createChapterExtractor(new MockLanguageModelV4({ doGenerate: async options => {
      const prompt = JSON.stringify(options.prompt);
      calls.push(prompt.includes('[200]') ? 'second' : 'first');
      const caption = prompt.includes('[200]') ? 99 : 10;
      return { content: [{ type: 'text', text: JSON.stringify({ points: [{ point: 'A point.', caption }] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } }), undefined, 'test');
    const result = await extract({ question: 'Summarize.', segments, chapters: chapters.chapters, concurrency: 2, signal: new AbortController().signal });
    expect(result.failedChapters).toEqual([1]);
    expect(calls.filter(call => call === 'second')).toHaveLength(2);
    expect(calls.filter(call => call === 'first')).toHaveLength(1);
  });

  it('keeps an intentionally empty section as covered, without a repair', async () => {
    const extract = createChapterExtractor(new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ points: [] }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) }), undefined, 'test');
    const result = await extract({ question: 'Summarize.', segments, chapters: chapters.chapters.slice(0, 1), concurrency: 1, signal: new AbortController().signal });
    expect(result).toMatchObject({ failedChapters: [], chapters: [{ points: [] }] });
  });

  it('records usage for a completed call whose output fails the schema', async () => {
    const recordUsage = vi.fn();
    const extract = createChapterExtractor(new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ points: [{ point: 'Bad caption type.', caption: 'ten' }] }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) }),
      { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage }, 'test');
    const result = await extract({ question: 'Summarize.', segments, chapters: chapters.chapters.slice(0, 1), concurrency: 1, signal: new AbortController().signal });
    expect(result.failedChapters).toEqual([0]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ category: 'chapter_extraction', usage: { inputTokens: 100, outputTokens: 20 } });
  });
});

describe('review fixes: minimum fit, warning bounds and cancellation', () => {
  async function chapterPacket(chapterCount: number, captionText: (index: number) => string, pointText: string, failedFrom = Infinity) {
    const { indexedTranscriptEvidence } = await import('../src/agents/providers/youtube/tools/get-video-transcript');
    const perChapter = 20;
    const captions = Array.from({ length: chapterCount * perChapter }, (_, index) => ({ startMs: index * 3_000, endMs: index * 3_000 + 3_000, durationMs: 3_000, text: captionText(index) }));
    const plan = { mode: 'chapter_extraction' as const, scope: 'whole_video' as const,
      failedChapters: Array.from({ length: Math.max(0, chapterCount - failedFrom) }, (_, offset) => failedFrom + offset),
      chapters: Array.from({ length: chapterCount }, (_, index) => ({ index, title: `Chapter ${index}`, first: index * perChapter, last: index * perChapter + perChapter - 1,
        ...(index >= failedFrom ? { failed: true as const, points: [] } : { points: [{ point: pointText, caption: index * perChapter }] }) })) };
    const evidence = indexedTranscriptEvidence(VIDEO, captions, `youtube:${VIDEO}:transcript`, plan);
    const { evidencePacketSchema } = await import('../src/agents/contracts');
    return evidencePacketSchema.parse({ packetId: 'p', kind: 'youtube_transcript',
      sources: [{ id: `youtube:${VIDEO}:transcript`, provider: 'youtube', kind: 'transcript', videoId: VIDEO }], ...evidence, usage: [] });
  }
  const expectAlignedWithin = (prepared: ReturnType<typeof finalizationEvidenceForModel>, budget: number) => {
    const shown = prepared.evidence[0]!;
    const ids = new Set(shown.excerpts!.map(excerpt => excerpt.id));
    expect(shown.transcriptRetrieval!.chapters!.flatMap(chapter => chapter.points).every(point => point.excerptIds.length > 0 && point.excerptIds.every(id => ids.has(id)))).toBe(true);
    expect(JSON.stringify(prepared.evidence).length).toBeLessThanOrEqual(budget);
  };
  const expectAligned = (prepared: ReturnType<typeof finalizationEvidenceForModel>) => {
    const shown = prepared.evidence[0]!;
    const ids = new Set(shown.excerpts!.map(excerpt => excerpt.id));
    const points = shown.transcriptRetrieval!.chapters!.flatMap(chapter => chapter.points);
    expect(points.length).toBeGreaterThan(0);
    expect(points.every(point => point.excerptIds.length > 0 && point.excerptIds.every(id => ids.has(id)))).toBe(true);
    expect(shown.warnings.map(warning => warning.code)).toContain('TRANSCRIPT_CONTEXT_TRUNCATED');
    expect(JSON.stringify(prepared.evidence).length).toBeLessThanOrEqual(60_000);
    return points.length;
  };

  it('keeps chapters spread across the video, each aligned, when one point per chapter does not fit', async () => {
    // Review reproductions: 34 chapters with 1,800-character captions, and 120 chapters with 300-character captions.
    const long = await chapterPacket(34, index => `${index} ${'long caption words '.repeat(95)}`.slice(0, 1_800), 'p'.repeat(100));
    const kept = expectAligned(finalizationEvidenceForModel([long], 60_000));
    expect(kept).toBeLessThan(34);
    const dense = await chapterPacket(120, index => `${index} ${'dense caption text '.repeat(16)}`.slice(0, 300), 'q'.repeat(120));
    const shown = finalizationEvidenceForModel([dense], 60_000);
    expectAligned(shown);
    expect(shown.evidence[0]!.warnings.find(warning => warning.code === 'TRANSCRIPT_CONTEXT_TRUNCATED')!.message).toMatch(/Omitted chapters: "Chapter /);
  });

  it('finds the largest spread that fits even when a smaller count picks a longer chapter', async () => {
    // Five chapters: a count of 4 picks {0, 1, 2, 3} and 2 picks {0, 2}, but 3 picks {0, 1, 3}. With
    // chapter 2 long, {0, 1, 3} fits at budgets where {0, 2} does not. A search that tries 2 first and
    // assumes sizes grow with the count would then keep one chapter there.
    const caption = (index: number) => index === 40 ? `${index} ${'long '.repeat(400)}`.slice(0, 1_990) : `${index} short caption.`;
    const packet = await chapterPacket(5, caption, 'A point about this chapter.');
    for (let budget = 500; budget <= 8_000; budget += 25) {
      const prepared = finalizationEvidenceForModel([packet], budget);
      if (!prepared.evidence.length) continue;
      expectAlignedWithin(prepared, budget);
      if (prepared.evidence[0]!.transcriptRetrieval!.chapters!.map(chapter => chapter.index).join(',') !== '0,1,3') continue;
      // Three chapters are kept as soon as they fit, not only once the longer {0, 2} would also fit.
      expect(budget - JSON.stringify(prepared.evidence).length).toBeLessThan(100);
      return;
    }
    throw new Error('No budget kept chapters 0, 1 and 3.');
  });

  it('omits a chapter packet that cannot fit one aligned point, instead of keeping unsupported points', async () => {
    const packet = await chapterPacket(10, index => `${index} ${'caption '.repeat(200)}`.slice(0, 1_500), 'r'.repeat(100));
    const prepared = finalizationEvidenceForModel([packet], 1_200);
    expect(prepared.evidence).toEqual([]);
    expect(prepared.missingInputs).toContainEqual(expect.objectContaining({ reason: 'prompt_evidence_cut', packetId: 'p' }));
  });

  it('returns partial evidence with one bounded warning when more than 50 chapters fail', async () => {
    const packet = await chapterPacket(68, index => `Caption ${index}.`, 'One point.', 1);
    const partial = packet.warnings.filter(warning => warning.code === 'PARTIAL_EVIDENCE');
    expect(partial).toHaveLength(1);
    expect(partial[0]!.message).toMatch(/^67 chapters could not be read: "Chapter 1" \(1:00 to 2:00\);.* and 37 more\. Those parts of the video are not covered\.$/);
    expect(partial[0]!.message.length).toBeLessThanOrEqual(1_000);
    expect((packet.artifacts[0]!.data as { failedChapters: number[] }).failedChapters).toHaveLength(67);
  });

  it('leaves no unhandled rejection when a shadow run is cancelled during retrieval', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      storage.read.mockReturnValue(new Promise((_, reject) => setTimeout(() => reject(new Error('Agent run finished.')), 10)));
      const controller = new AbortController();
      controller.abort(new Error('Agent run finished.'));
      const plan = await retrieval({ mode: 'shadow' }).access.resolve({ videoId: VIDEO, segments, reference, signal: controller.signal, deadlineAt: Date.now() + 60_000 });
      expect(plan).toMatchObject({ mode: 'complete_transcript', reason: 'shadow' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
