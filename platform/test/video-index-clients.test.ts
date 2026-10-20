import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTranscriptIndexBuild, transcriptIndexInstanceId } from '../src/lib/video-index/build';
import { chapterExtractionConcurrency, chapterMinutes, indexEvidenceTokens, transcriptRetrievalMode, transcriptRouter } from '../src/lib/video-index/config';
import { EMBEDDING_MODEL, embeddingQuery, embedTexts } from '../src/lib/video-index/embeddings';
import { JEV_MODEL, routeTranscriptScopeWithJev } from '../src/lib/video-index/jev';

afterEach(() => vi.restoreAllMocks());

function embeddingResponse(inputs: string[]) {
  return new Response(JSON.stringify({
    data: inputs.map((_, index) => ({ index, embedding: [index + 1, 0, 0, 0] })).reverse(),
    usage: { total_tokens: inputs.length * 10 },
  }), { status: 200 });
}

describe('embedding client', () => {
  it('sends at most 64 inputs per request, concurrently, and normalizes vectors in input order', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      embeddingResponse(JSON.parse(String(init!.body)).input));
    const inputs = Array.from({ length: 130 }, (_, index) => `passage ${index}`);
    const result = await embedTexts('fw-key', inputs);
    expect(fetch).toHaveBeenCalledTimes(3);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies.map(body => body.input.length)).toEqual([64, 64, 2]);
    expect(bodies[0]).toMatchObject({ model: EMBEDDING_MODEL });
    expect(fetch.mock.calls[0]![0]).toBe('https://api.fireworks.ai/inference/v1/embeddings');
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer fw-key');
    expect(result.vectors).toHaveLength(130);
    expect([...result.vectors[0]!]).toEqual([1, 0, 0, 0]);
    expect(result.tokens).toBe(1_300);
  });

  it('retries rate limits and rejects mismatched responses', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      return calls === 1 ? new Response('busy', { status: 429 }) : embeddingResponse(JSON.parse(String(init!.body)).input);
    });
    expect((await embedTexts('fw-key', ['a'])).vectors).toHaveLength(1);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(embedTexts('fw-key', ['a'])).rejects.toThrow('does not match');
    await expect(embedTexts(undefined, ['a'])).rejects.toThrow('not configured');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(embedTexts('fw-key', ['a'])).rejects.toThrow('status 400');
  });

  it('prefixes queries exactly as tested', () => {
    expect(embeddingQuery('Where is state explained?')).toBe(
      'Instruct: Given a question about a video, retrieve relevant transcript topics that answer the question.\nQuery: Where is state explained?');
  });
});

describe('Jev router', () => {
  it('asks one three-way choice with the chapter titles and maps topic_anywhere to topic', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      model: JEV_MODEL, answers: { route: { choice: 'topic_anywhere', probabilities: { topic_anywhere: 0.8 } } },
    })));
    const routed = await routeTranscriptScopeWithJev({ apiKey: 'jev-key', question: 'Where is state explained?', chapterTitles: ['Intro', 'State'] });
    expect(routed).toMatchObject({ scope: 'topic' });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ model: 'jev-1.14.0', state: { question: 'Where is state explained?', chapters: ['Intro', 'State'] } });
    expect(Object.keys(body.questions.route.criteria)).toEqual(['one_part', 'topic_anywhere', 'whole_video']);
  });

  it('returns undefined on any failure so the caller keeps its default', async () => {
    expect(await routeTranscriptScopeWithJev({ apiKey: undefined, question: 'q', chapterTitles: [] })).toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    expect(await routeTranscriptScopeWithJev({ apiKey: 'k', question: 'q', chapterTitles: [] })).toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ model: 'jev-2', answers: { route: { choice: 'whole_video' } } })));
    expect(await routeTranscriptScopeWithJev({ apiKey: 'k', question: 'q', chapterTitles: [] })).toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await routeTranscriptScopeWithJev({ apiKey: 'k', question: 'q', chapterTitles: [] })).toBeUndefined();
  });
});

describe('configuration', () => {
  it('uses bounded values with safe defaults', () => {
    expect(transcriptRetrievalMode({})).toBe('full');
    expect(transcriptRetrievalMode({ AGENT_TRANSCRIPT_RETRIEVAL: 'index' })).toBe('index');
    expect(transcriptRetrievalMode({ AGENT_TRANSCRIPT_RETRIEVAL: 'Index' })).toBe('full');
    expect(indexEvidenceTokens({})).toBe(2_000);
    expect(indexEvidenceTokens({ AGENT_INDEX_EVIDENCE_TOKENS: '99999' })).toBe(8_000);
    expect(indexEvidenceTokens({ AGENT_INDEX_EVIDENCE_TOKENS: '100' })).toBe(500);
    expect(indexEvidenceTokens({ AGENT_INDEX_EVIDENCE_TOKENS: '2000.5' })).toBe(2_000);
    expect(chapterMinutes({ AGENT_CHAPTER_MINUTES: '2.5' })).toBe(2.5);
    expect(chapterMinutes({ AGENT_CHAPTER_MINUTES: '0' })).toBe(1);
    expect(chapterMinutes({ AGENT_CHAPTER_MINUTES: 'x' })).toBe(3.5);
    expect(chapterExtractionConcurrency({ AGENT_CHAPTER_EXTRACTION_CONCURRENCY: '64' })).toBe(32);
    expect(transcriptRouter({ AGENT_TRANSCRIPT_ROUTER: 'jev' })).toBe('jev');
    expect(transcriptRouter({ AGENT_TRANSCRIPT_ROUTER: 'other' })).toBe('classifier');
  });
});

describe('build trigger', () => {
  const version = { videoId: 'abcdefghijk', variant: '{"language":"default","granularity":"word"}', contentHash: 'a'.repeat(64) };
  const env = (workflow: unknown, mode = 'shadow') => ({ AGENT_TRANSCRIPT_RETRIEVAL: mode, TRANSCRIPT_INDEX_WORKFLOW: workflow }) as unknown as Env;

  it('starts one deterministic instance per transcript version', async () => {
    const create = vi.fn(async () => ({}));
    expect(await startTranscriptIndexBuild(env({ create }), version, 'publish')).toBe('started');
    const id = await transcriptIndexInstanceId(version, 3.5);
    expect(id).toMatch(/^transcript-index-[a-f0-9]{64}$/);
    expect(id).toBe(await transcriptIndexInstanceId({ ...version }, 3.5));
    expect(id).not.toBe(await transcriptIndexInstanceId({ ...version, contentHash: 'c'.repeat(64) }, 3.5));
    expect(create).toHaveBeenCalledWith({ id, params: { ...version, source: 'publish', chapterMinutes: 3.5 } });
  });

  it('starts a new instance when the chapter density changes, instead of reusing the completed one', async () => {
    const create = vi.fn(async () => ({}));
    await startTranscriptIndexBuild(env({ create }), version, 'question');
    await startTranscriptIndexBuild({ ...env({ create }), AGENT_CHAPTER_MINUTES: '2' } as unknown as Env, version, 'question');
    const [first, second] = create.mock.calls.map(call => (call as unknown as [{ id: string; params: { chapterMinutes: number } }])[0]);
    expect(first!.id).not.toBe(second!.id);
    expect(second!.params.chapterMinutes).toBe(2);
  });

  it('treats a duplicate start as a no-op and restarts a failed instance', async () => {
    const restart = vi.fn(async () => undefined);
    const statuses = ['running', 'complete', 'errored'];
    const workflow = {
      create: vi.fn(async () => { throw new Error('instance already exists'); }),
      get: vi.fn(async () => ({ status: async () => ({ status: statuses.shift() }), restart })),
    };
    expect(await startTranscriptIndexBuild(env(workflow), version, 'question')).toBe('running');
    expect(await startTranscriptIndexBuild(env(workflow), version, 'question')).toBe('complete');
    expect(await startTranscriptIndexBuild(env(workflow), version, 'question')).toBe('restarted');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('gives up on a stalled workflow service instead of holding the caller', { timeout: 10_000 }, async () => {
    // Real timers: the instance ID is hashed natively, outside fake timers. Create and lookup get 2 seconds each.
    const stalled = { create: vi.fn(() => new Promise(() => {})), get: vi.fn(() => new Promise(() => {})) };
    const started = Date.now();
    expect(await startTranscriptIndexBuild(env(stalled), version, 'publish')).toBe('failed');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does nothing when retrieval is off, and never throws', async () => {
    const create = vi.fn();
    expect(await startTranscriptIndexBuild(env({ create }, 'full'), version, 'publish')).toBe('disabled');
    expect(create).not.toHaveBeenCalled();
    expect(await startTranscriptIndexBuild(env(undefined), version, 'publish')).toBe('unavailable');
    const broken = { create: vi.fn(async () => { throw new Error('down'); }), get: vi.fn(async () => { throw new Error('down'); }) };
    expect(await startTranscriptIndexBuild(env(broken), version, 'publish')).toBe('failed');
  });
});
