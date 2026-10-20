// Offline phase of the transcript retrieval evaluation (see scripts/eval-transcript-retrieval.ts for the agent phases).
// Runs the platform's own index build, packer, routing and chapter extraction with real provider calls:
//   AGENT_INDEX_EVAL=1 FIREWORKS_API_KEY=... [JEV_API_KEY=...] AGENT_INDEX_TRANSCRIPTS=<dir of {segments} JSON named by video ID> \
//     npx vitest run test/transcript-retrieval.eval.test.ts
// The transcripts must be the ones the fixture caption IDs refer to (video-index data/transcripts).
// Writes offline.json and offline.md to AGENT_INDEX_EVAL_OUT (default ../.scratch/transcript-retrieval-eval).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentModel, createClassifierFallbackModel } from '../src/agents/model';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';
import { createChapterExtractor } from '../src/agents/providers/youtube/chapter-extractor';
import { buildChapters } from '../src/lib/video-index/chapters';
import { embeddingQuery, embedTexts } from '../src/lib/video-index/embeddings';
import { routeTranscriptScopeWithJev } from '../src/lib/video-index/jev';
import { bestChapter, rankPassages, selectEvidence } from '../src/lib/video-index/pack';
import { buildPassages, passageText, type IndexedCaption } from '../src/lib/video-index/passages';

interface Fact { id: string; claim: string; evidence: number[][]; optional?: boolean }
interface Question { id: string; set: 'test4' | 'react' | 'summary'; videoId: string; kind: string; wholeVideo: boolean; question: string; facts: Fact[] }
interface Fixtures { videos: Record<string, { title: string; captions: number; durationMs: number; creatorChapters?: { title: string; startMs: number }[] }>; questions: Question[] }

const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 ?? '';
const transcriptsDir = process.env.AGENT_INDEX_TRANSCRIPTS ?? '';
const enabled = process.env.AGENT_INDEX_EVAL === '1' && !!apiKey && !!transcriptsDir;
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../benchmarks/transcript-retrieval/questions.json'), 'utf8')) as Fixtures;
const out = resolve(process.env.AGENT_INDEX_EVAL_OUT ?? resolve(import.meta.dirname, '../../.scratch/transcript-retrieval-eval'));
const save = (name: string, value: unknown) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 1), { mode: 0o600 });
};
const scored = (question: Question) => question.facts.filter(fact => !fact.optional);
const targeted = (question: Question) => !question.wholeVideo && question.kind !== 'abstention';

describe.skipIf(!enabled)('transcript retrieval offline evaluation', () => {
  it('records index build, fact locations, routing and extraction coverage', { timeout: 1_800_000 }, async () => {
    const report = await offline(transcriptsDir);
    expect(report.retrieval.length).toBeGreaterThan(0);
  });
});

async function offline(transcripts: string) {
  const budget = Number(process.env.AGENT_INDEX_EVAL_BUDGET ?? 2_000);
  const env = { FIREWORKS_API_KEY: apiKey, AGENT_GLM_PROVIDER: 'fireworks', AI_GATEWAY_ID: '' } as unknown as Env;
  const report: Record<string, unknown> = { created: new Date().toISOString(), budget };
  const rows: Record<string, unknown>[] = [];
  const videos: Record<string, unknown> = {};
  const routing: Record<string, unknown>[] = [];
  const extraction: Record<string, unknown>[] = [];

  for (const videoId of Object.keys(fixtures.videos)) {
    const segments = (JSON.parse(readFileSync(resolve(transcripts, `${videoId}.json`), 'utf8')) as { segments: IndexedCaption[] }).segments;
    if (segments.length !== fixtures.videos[videoId]!.captions) throw new Error(`${videoId}: transcript differs from the fixture's caption numbering.`);
    // Index time: passages, embeddings, chapters and chapter vectors, as the background build does.
    let started = Date.now();
    const passages = buildPassages(segments);
    const passageVectors = await embedTexts(apiKey, passages.map(passage => passageText(segments, passage)));
    const step1Ms = Date.now() - started;
    started = Date.now();
    const built = await buildChapters({ model: createAgentModel(env, `eval:${videoId}`, 'low', { model_role: 'chapter_builder' }),
      segments, title: fixtures.videos[videoId]!.title });
    const chapterVectors = await embedTexts(apiKey, built.chapters.map(chapter => `${chapter.title}: ${chapter.summary}`));
    const step2Ms = Date.now() - started;
    videos[videoId] = { captions: segments.length, passages: passages.length, step1Ms, embedMs: passageVectors.ms, embedTokens: passageVectors.tokens,
      chapters: built.chapters.length, target: built.target, capped: built.capped, step2Ms, chapterMs: built.ms,
      chapterInput: built.usage?.inputTokens, chapterOutput: built.usage?.outputTokens,
      chapterList: built.chapters.map(chapter => ({ title: chapter.title, startMs: segments[chapter.first]!.startMs })) };
    console.log(videoId, JSON.stringify({ passages: passages.length, step1Ms, chapters: built.chapters.length, step2Ms }));

    const questions = fixtures.questions.filter(question => question.videoId === videoId);
    const queries = await embedTexts(apiKey, questions.map(question => embeddingQuery(question.question)));
    const titles = built.chapters.map(chapter => chapter.title);
    for (const [index, question] of questions.entries()) {
      // Routing: the platform classifier with chapter titles, and Jev when a key is set.
      const classifierModel = createAgentModel(env, `eval:${question.id}`, 'low', { model_role: 'classifier' });
      let classifierScope: string | undefined;
      try {
        const decision = await classifyCapabilityWithModel({ message: `${question.question}\n\nhttps://youtu.be/${videoId}`, model: classifierModel,
          fallbackModel: createClassifierFallbackModel(env, `eval:${question.id}`), signal: new AbortController().signal,
          requestTranscriptScope: true, videoChapters: [{ videoId, titles }] });
        classifierScope = decision.route === 'inspect_video' ? decision.transcriptScope ?? 'topic' : `route:${decision.route}`;
      } catch (error) { classifierScope = `error:${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`; }
      const jev = process.env.JEV_API_KEY ? await routeTranscriptScopeWithJev({ apiKey: process.env.JEV_API_KEY, question: question.question, chapterTitles: titles }) : undefined;
      routing.push({ id: question.id, expectedWhole: question.wholeVideo, classifier: classifierScope, jev: jev?.scope, jevMs: jev?.ms });

      // Targeted retrieval arms at the same budget.
      const query = queries.vectors[index]!;
      const ranked = rankPassages(passages, passageVectors.vectors, query);
      const chapter = built.chapters[bestChapter(chapterVectors.vectors, query)!.index]!;
      const arms: Record<string, ReturnType<typeof selectEvidence>> = {
        topic: selectEvidence({ segments, ranked, budget }),
        one_part: selectEvidence({ segments, ranked, budget, chapter, chapters: built.chapters }),
      };
      const routedScope = (scope: string | undefined) => scope === 'one_part' ? arms.one_part! : arms.topic!;
      arms.routed_classifier = routedScope(classifierScope);
      if (jev) arms.routed_jev = routedScope(jev.scope);
      for (const [arm, packed] of Object.entries(arms)) {
        const got = new Set(packed.captions);
        const located = scored(question).filter(fact => fact.evidence.some(([a, b]) => [...got].some(id => id >= a! && id <= b!))).length;
        rows.push({ id: question.id, set: question.set, kind: question.kind, arm, located, facts: scored(question).length,
          evidenceTokens: packed.evidenceTokens, passages: packed.passages.length, chapter: arm.includes('one_part') ? chapter.title : undefined });
      }
    }

    // Whole-video extraction over the built chapters.
    for (const question of questions.filter(item => item.wholeVideo)) {
      const extractor = createChapterExtractor(createAgentModel(env, `eval:${question.id}`, 'low', { model_role: 'chapter_extractor' }), undefined, `eval:${question.id}`);
      const result = await extractor({ question: question.question, segments, chapters: built.chapters, concurrency: 8, signal: new AbortController().signal });
      const points = result.chapters.flatMap(item => item.points.map(point => ({ chapter: item.title, ...point, startMs: segments[point.caption]!.startMs })));
      const creator = fixtures.videos[videoId]!.creatorChapters;
      const recall = creator ? creatorChapterRecall(creator, points.map(point => point.startMs), segments.at(-1)!.endMs) : undefined;
      const items = question.facts.filter(fact => fact.evidence.length);
      const locatedItems = items.filter(fact => points.some(point => fact.evidence.some(([a, b]) => point.caption >= a! - 3 && point.caption <= b! + 3))).length;
      extraction.push({ id: question.id, chapters: built.chapters.length, points: points.length, failedChapters: result.failedChapters, wallMs: result.wallMs,
        creatorChapterRecall: recall, factLocationsNearPoints: items.length ? `${locatedItems}/${items.length}` : undefined });
      save(`points-${question.id}.json`, points);
    }
  }

  report.videos = videos;
  report.routing = routing;
  report.extraction = extraction;
  report.retrieval = rows;
  save('offline.json', report);
  const lines = ['# Offline transcript retrieval evaluation', '', `Created ${report.created}. Budget ${budget} estimated tokens.`, '', '## Index build', '',
    '| Video | Captions | Passages | Step 1 ms | Chapters (K) | Step 2 ms |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(videos).map(([id, v]: [string, any]) => `| ${id} | ${v.captions} | ${v.passages} | ${v.step1Ms} | ${v.chapters} (${v.target}) | ${v.step2Ms} |`),
    '', '## Fact locations in selected evidence', '', '| Set | Arm | Located | Mean evidence tokens |', '| --- | --- | ---: | ---: |'];
  for (const set of ['test4', 'react'] as const) {
    for (const arm of [...new Set(rows.map(row => row.arm as string))]) {
      const group = rows.filter(row => row.set === set && row.arm === arm && targeted(fixtures.questions.find(q => q.id === row.id)!));
      if (!group.length) continue;
      lines.push(`| ${set} targeted | ${arm} | ${group.reduce((s, r) => s + (r.located as number), 0)}/${group.reduce((s, r) => s + (r.facts as number), 0)} | ${Math.round(group.reduce((s, r) => s + (r.evidenceTokens as number), 0) / group.length)} |`);
    }
  }
  const whole = (scope: unknown) => scope === 'whole_video';
  lines.push('', '## Whole-video routing', '', `Classifier: ${routing.filter(r => whole(r.classifier) === r.expectedWhole).length}/${routing.length} correct`,
    ...(process.env.JEV_API_KEY ? [`Jev: ${routing.filter(r => whole(r.jev) === r.expectedWhole).length}/${routing.length} correct`] : []),
    '', '| Question | Whole video | Classifier | Jev |', '| --- | --- | --- | --- |',
    ...routing.map(r => `| ${r.id} | ${r.expectedWhole ? 'yes' : 'no'} | ${r.classifier} | ${r.jev ?? ''} |`),
    '', '## Whole-video extraction', '', '| Question | Chapters | Points | Failed | Wall ms | Creator chapter recall | Fact locations near points |', '| --- | ---: | ---: | --- | ---: | ---: | ---: |',
    ...extraction.map((e: any) => `| ${e.id} | ${e.chapters} | ${e.points} | ${e.failedChapters.join(',') || 'none'} | ${e.wallMs} | ${e.creatorChapterRecall?.toFixed(2) ?? ''} | ${e.factLocationsNearPoints ?? ''} |`));
  save('offline.md', lines.join('\n'));
  console.log(lines.join('\n'));
  return { retrieval: rows };
}

/** Share of creator chapters that contain at least one extracted point. */
function creatorChapterRecall(chapters: { startMs: number }[], pointStarts: number[], endMs: number): number {
  const covered = chapters.filter((chapter, index) => {
    const end = chapters[index + 1]?.startMs ?? endMs + 1;
    return pointStarts.some(start => start >= chapter.startMs && start < end);
  }).length;
  return covered / chapters.length;
}

