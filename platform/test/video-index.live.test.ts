// Opt-in live check of the index-time and question-time provider calls on one short transcript.
// Usage (add --silent=false to see timings): AGENT_INDEX_LIVE=1 FIREWORKS_API_KEY=... AGENT_INDEX_TRANSCRIPT=/path/to/transcript.json [JEV_API_KEY=...] \
//   npx vitest run test/video-index.live.test.ts
// The transcript file is {"segments":[{"text","startMs","endMs"}]}; transcripts stay out of git.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAgentModel } from '../src/agents/model';
import { createChapterExtractor } from '../src/agents/providers/youtube/chapter-extractor';
import { buildChapters } from '../src/lib/video-index/chapters';
import { EMBEDDING_DIMENSIONS, embeddingQuery, embedTexts } from '../src/lib/video-index/embeddings';
import { routeTranscriptScopeWithJev } from '../src/lib/video-index/jev';
import { bestChapter, rankPassages, selectEvidence } from '../src/lib/video-index/pack';
import { buildPassages, passageText, type IndexedCaption } from '../src/lib/video-index/passages';

const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 ?? '';
const env = { FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' } as unknown as Env;
const enabled = process.env.AGENT_INDEX_LIVE === '1' && !!apiKey && !!process.env.AGENT_INDEX_TRANSCRIPT;

describe.skipIf(!enabled)('video index live providers', () => {
  const segments = enabled ? (JSON.parse(readFileSync(process.env.AGENT_INDEX_TRANSCRIPT!, 'utf8')) as { segments: IndexedCaption[] }).segments : [];

  it('builds passages, embeddings and chapters, then retrieves and extracts with real models', { timeout: 120_000 }, async () => {
    const passages = buildPassages(segments);
    const embedded = await embedTexts(apiKey, passages.map(passage => passageText(segments, passage)));
    expect(embedded.vectors).toHaveLength(passages.length);
    expect(embedded.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);

    const built = await buildChapters({ model: createAgentModel(env, 'live-index', 'low', { model_role: 'chapter_builder' }), segments });
    expect(built.chapters.length).toBeGreaterThanOrEqual(2);
    expect(built.chapters[0]!.first).toBe(0);
    expect(built.chapters.at(-1)!.last).toBe(segments.length - 1);
    built.chapters.forEach((chapter, index) => index && expect(chapter.first).toBe(built.chapters[index - 1]!.last + 1));
    const chapterVectors = await embedTexts(apiKey, built.chapters.map(chapter => `${chapter.title}: ${chapter.summary}`));

    const question = 'What is the main example explained in this video?';
    const [query] = (await embedTexts(apiKey, [embeddingQuery(question)])).vectors;
    const ranked = rankPassages(passages, embedded.vectors, query!);
    const chapter = built.chapters[bestChapter(chapterVectors.vectors, query!)!.index]!;
    const selected = selectEvidence({ segments, ranked, budget: 2_000, chapter, chapters: built.chapters });
    expect(selected.evidenceTokens).toBeLessThanOrEqual(2_000);
    expect(selected.captions.length).toBeGreaterThan(0);

    const extracted = await createChapterExtractor(createAgentModel(env, 'live-index', 'low', { model_role: 'chapter_extractor' }), undefined, 'live')({
      question: 'Summarize the video.', segments, chapters: built.chapters, concurrency: 8, signal: new AbortController().signal });
    expect(extracted.failedChapters).toEqual([]);
    expect(extracted.chapters.filter(item => item.points.length).length).toBeGreaterThanOrEqual(Math.ceil(built.chapters.length / 2));

    const routed = process.env.JEV_API_KEY ? await routeTranscriptScopeWithJev({ apiKey: process.env.JEV_API_KEY, question: 'Summarize the video.',
      chapterTitles: built.chapters.map(item => item.title) }) : undefined;
    if (process.env.JEV_API_KEY) expect(routed?.scope).toBe('whole_video');
    // Shapes and timings only; no transcript or model text is printed.
    console.log(JSON.stringify({ captions: segments.length, passages: passages.length, embedMs: embedded.ms, embedTokens: embedded.tokens,
      chapters: built.chapters.length, target: built.target, chapterMs: built.ms, chapterInput: built.usage?.inputTokens,
      chapterOutput: built.usage?.outputTokens, evidenceTokens: selected.evidenceTokens, extractionMs: extracted.wallMs,
      points: extracted.chapters.reduce((sum, item) => sum + item.points.length, 0), jevMs: routed?.ms, jevScope: routed?.scope }));
  });
});
