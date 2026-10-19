/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VideoCatalog } from '../src/lib/video-catalog';
import { buildChapterIndex, buildPassageIndex } from '../src/lib/video-index/build';
import { readTranscriptIndex, transcriptVersionFromReference } from '../src/lib/video-index/storage';

const bindings = env as Env & { TEST_VIDEO_MIGRATIONS: D1Migration[] };
beforeAll(() => applyD1Migrations(bindings.VIDEO_CATALOG, bindings.TEST_VIDEO_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

const testEnv = { ...bindings, FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function transcript(count: number, label = 'caption') {
  return { segments: Array.from({ length: count }, (_, index) => ({
    text: `This is ${label} ${index} with several spoken words${index % 6 === 5 ? '.' : ''}`,
    startMs: index * 3_000, endMs: index * 3_000 + 3_000, durationMs: 3_000,
  })) };
}

function mockEmbeddings() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const inputs = JSON.parse(String(init!.body)).input as string[];
    return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, index + 1, 0.5, 0.25] })),
      usage: { total_tokens: inputs.length } }));
  });
}

function chapterModel(fail = false) {
  return new MockLanguageModelV4({ doGenerate: async () => {
    if (fail) throw new Error('chapter provider down');
    return { content: [{ type: 'text', text: JSON.stringify({ chapters: [
      { start: 0, title: 'Opening', summary: 'The opening.' },
      { start: 20, title: 'Second part', summary: 'The rest.' },
    ] }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
}

async function publishTranscript(store: VideoCatalog, videoId: string, value: unknown) {
  const reference = await store.save({ videoId, kind: 'transcript', variant: '{"language":"default","granularity":"word"}' }, value, Date.now(), 60_000, true);
  return transcriptVersionFromReference(reference)!;
}

describe('transcript index in the shared catalog', () => {
  it('saves step 1 before step 2, so passage search is ready even when chapters fail', async () => {
    const store = new VideoCatalog(bindings.VIDEO_CATALOG, bindings.VIDEO_ASSETS);
    const version = await publishTranscript(store, 'indexstep01', transcript(200));
    expect(await store.currentReference({ videoId: 'indexstep01', kind: 'transcript', variant: version.variant }))
      .toMatchObject({ contentHash: version.contentHash });
    const fetch = mockEmbeddings();
    const params = { ...version, source: 'publish' as const, chapterMinutes: 3.5, maxVideoSeconds: 7_200 };
    expect(await buildPassageIndex(testEnv, params, store)).toMatchObject({ status: 'built' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(buildChapterIndex(testEnv, { ...params, model: chapterModel(true) }, store)).rejects.toThrow();
    const ready = await readTranscriptIndex(testEnv, version, 3.5, store);
    expect(ready.index?.passages.length).toBeGreaterThan(5);
    expect(ready.index?.vectors[0]).toBeInstanceOf(Float32Array);
    expect(ready.index?.captionCount).toBe(200);
    expect(ready.chapters).toBeUndefined();
    // The payload holds caption indexes and vectors, never transcript text.
    const objects = await bindings.VIDEO_ASSETS.list({ prefix: 'youtube/videos/indexstep01/transcript_index/' });
    expect(objects.objects).toHaveLength(1);
    expect(await (await bindings.VIDEO_ASSETS.get(objects.objects[0]!.key))!.text()).not.toContain('spoken words');

    // A retry builds only the missing kind.
    expect(await buildPassageIndex(testEnv, params, store)).toEqual({ status: 'exists' });
    expect(await buildChapterIndex(testEnv, { ...params, model: chapterModel() }, store)).toMatchObject({ status: 'built', count: 2 });
    // Six captions make one sentence here, so sentence 20 starts at caption 120.
    const complete = await readTranscriptIndex(testEnv, version, 3.5, store);
    expect(complete.chapters?.chapters.map(chapter => [chapter.title, chapter.first, chapter.last])).toEqual([['Opening', 0, 119], ['Second part', 120, 199]]);
  });

  it('pins an index to its exact transcript version; a refreshed transcript gets its own', async () => {
    const store = new VideoCatalog(bindings.VIDEO_CATALOG, bindings.VIDEO_ASSETS);
    const original = await publishTranscript(store, 'indexpin001', transcript(120));
    mockEmbeddings();
    await buildPassageIndex(testEnv, { ...original, source: 'publish', chapterMinutes: 3.5, maxVideoSeconds: 7_200 }, store);
    const refreshed = await publishTranscript(store, 'indexpin001', transcript(120, 'corrected caption'));
    expect(refreshed.contentHash).not.toBe(original.contentHash);
    expect(await readTranscriptIndex(testEnv, refreshed, 3.5, store)).toEqual({});
    expect((await readTranscriptIndex(testEnv, original, 3.5, store)).index).toBeDefined();
    // A refresh never removes the old version's index row or object.
    const rows = await bindings.VIDEO_CATALOG.prepare(`SELECT COUNT(*) AS count FROM video_asset_versions WHERE video_id=? AND kind='transcript_index'`)
      .bind('indexpin001').first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it('skips transcripts past the agent video length limit', async () => {
    const store = new VideoCatalog(bindings.VIDEO_CATALOG, bindings.VIDEO_ASSETS);
    const version = await publishTranscript(store, 'indexlong01', transcript(200));
    const fetch = mockEmbeddings();
    expect(await buildPassageIndex(testEnv, { ...version, source: 'publish', chapterMinutes: 3.5, maxVideoSeconds: 60 }, store))
      .toEqual({ status: 'skipped', reason: 'VIDEO_TOO_LONG' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readTranscriptIndex(testEnv, version, 3.5, store)).toEqual({});
  });
});
