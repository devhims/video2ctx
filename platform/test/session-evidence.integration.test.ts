import { unverifiedCaptionPassages } from '../src/agents/research/requested-evidence';
import { pendingOriginalSources, unreadOriginalSources } from '../src/agents/research/skills/verify-saved-evidence';
import { extractionFixture } from './fixtures/extraction-diagnostic';
import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { executeAnalyzeVideoFrames } from '../src/agents/providers/youtube/tools/analyze-video-frames';
import { executeAnalyzeVideoStoryboard } from '../src/agents/providers/youtube/tools/analyze-video-storyboard';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { evidencePacketSchema, type CapabilityRouteDecision, type EvidencePacket } from '../src/agents/contracts';
import type { Comment, CommentsPage, Transcript } from 'all-things-youtube';
import { SessionEvidenceStore, versionEvidencePacket } from '../src/agents/runtime/session-evidence';
import { remember } from './fixtures/memory';
import { createCapabilityProvider, savedOnlyProvider } from '../src/agents/research/capability-provider';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { summarizeComment } from '../src/agents/providers/youtube/tools/get-video-comments';
import { finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';
import { bicycleHistory, gcnCaptions, officialCaptions, gcnAnalysis, officialAnalysis, javascriptComments } from './fixtures/saved-replays';
import { readSavedEvidence, searchSavedEvidence, SAVED_EVIDENCE_READ_LIMIT } from '../src/agents/runtime/saved-evidence-reader';
import { annaId, kelogId, watercolorTranscript, watercolorCorrection, watercolorFollowup } from './fixtures/watercolor-session';

test('saved original comments include positions 13 and 17 and long tails, with bounded pagination', async () =>
  within('original-comments', async (store, reopen) => {
    const value = { videoId: id, replyContinuations: [], meta: transcript().meta,
      comments: Array.from({ length: 20 }, (_, index) => ({ id: `comment-${index + 1}`,
        text: index === 16 ? 'prefix '.repeat(400) + 'JavaScript closure explanation at the tail.' : `Original JavaScript comment ${index + 1}.`,
        author: { name: `Viewer ${index + 1}`, thumbnails: [] }, isPinned: false, isHearted: false, replies: [] })) };
    const saved = await store.retrieve('comments', 'comments', id, false,
      async () => ({ value, cacheStatus: 'miss' }), () => ({}));
    const assetVersion = saved.assetVersions![0]!;
    const restored = reopen();
    const first = await readSavedEvidence(restored, { assetVersion, offset: 12, limit: 1 });
    expect(first.packets[0]!.excerpts[0]!.text).toContain('Original JavaScript comment 13.');
    expect(first.packets[0]!.excerpts[0]!.text).toContain('Comment ID: comment-13');
    expect(first.coverage.nextOffset).toBe(13);
    const tail = await readSavedEvidence(restored, { assetVersion, query: 'closure explanation' });
    expect(tail.packets[0]!.excerpts.map(excerpt => excerpt.text).join(' ')).toContain('JavaScript closure explanation at the tail.');
    expect(tail.packets[0]!.excerpts[0]!.text).toContain('Author: Viewer 17');
    expect(finalizationEvidenceForModel(tail.packets, 40_000).evidence[0]!.excerpts![0]!.text)
      .toBe(tail.packets[0]!.excerpts[0]!.text);
    let offset = 0;
    const texts: string[] = [];
    for (;;) {
      const page = await readSavedEvidence(restored, { assetVersion, offset, limit: 30 });
      expect(JSON.stringify(page.packets[0]!.excerpts).length).toBeLessThan(12_100);
      texts.push(...page.packets[0]!.excerpts.map(excerpt => excerpt.text));
      if (page.coverage.nextOffset === undefined) break;
      expect(page.coverage.nextOffset).toBeGreaterThan(offset);
      offset = page.coverage.nextOffset;
    }
    expect(texts).toHaveLength(21);
    expect(texts.at(-1)).toContain('comment 20.');
    await expect(readSavedEvidence(restored, { assetVersion, startMs: 1 })).rejects.toThrow('Timestamp filters');
    await expect(readSavedEvidence(restored, { assetVersion, limit: 31 })).rejects.toThrow();
    await expect(readSavedEvidence(restored, { assetVersion, query: '!!!' })).rejects.toThrow('at least one word');
  }));

test('saved reads enforce ownership, admission, cancellation and history-only tool scope', async () =>
  within('original-read-boundaries', async (store) => {
    await expect(readSavedEvidence(store, { assetVersion: 'foreign-version' })).rejects.toThrow('unavailable or deleted');
    const saved = await store.retrieve('transcript', 'transcript', id, false,
      async () => ({ value: transcript(), cacheStatus: 'miss' }), () => ({}));
    const input = { assetVersion: saved.assetVersions![0]! };
    const options = { toolCallId: 'read', messages: [], context: {} };
    const admit = vi.fn(() => []);
    const controller = new AbortController();
    const tools = await store.searchTools(admit, controller.signal);
    const execute = tools.search_originals!.execute!;
    expect(await execute(input, options)).toMatchObject({ packets: [], withheld: true });
    expect(admit).toHaveBeenCalledWith(expect.any(Array), 'read_saved_evidence');
    controller.abort();
    await expect(execute(input, options)).rejects.toThrow();
    const history = await store.searchTools(admit, new AbortController().signal, { evidence: false });
    expect(history.search_originals).toBeUndefined();
    const empty = await readSavedEvidence(store, { ...input, query: 'absent phrase' });
    expect(empty.coverage).toMatchObject({ selectedExcerpts: 0, returnedExcerpts: 0 });
    expect(empty.packets[0]!.excerpts).toEqual([]);
  }));

test('long original captions page completely without a non-advancing offset', async () =>
  within('original-oversized-segment', async store => {
    const value = transcript();
    value.segments = [{ ...value.segments[0]!, text: 'x'.repeat(12_001) }];
    const saved = await store.retrieve('transcript', 'transcript', id, false,
      async () => ({ value, cacheStatus: 'miss' }), () => ({}));
    const first = await readSavedEvidence(store, { assetVersion: saved.assetVersions![0]! });
    expect(first.coverage.nextOffset).toBeGreaterThan(0);
    const second = await readSavedEvidence(store, { assetVersion: saved.assetVersions![0]!, offset: first.coverage.nextOffset });
    expect(second.coverage.nextOffset).toBeUndefined();
    expect([...first.packets[0]!.excerpts, ...second.packets[0]!.excerpts].map(excerpt => excerpt.text).join(''))
      .toBe(value.segments[0]!.text);
  }));

test('original reads retain nested replies, fence interrupted reads and bound repeated calls', async () =>
  within('original-read-lifecycle', async (store) => {
    const reply = { id: 'reply-1', text: 'A saved reply explaining closures.', author: { name: 'Reply author', thumbnails: [] },
      isPinned: false, isHearted: false, replies: [] };
    const saved = await store.retrieve('comments', 'comments', id, false,
      async () => ({ value: { videoId: id, replyContinuations: [], meta: transcript().meta,
        comments: [{ ...reply, id: 'parent', text: 'The parent comment.', replies: [reply] }] }, cacheStatus: 'miss' }), () => ({}));
    const input = { assetVersion: saved.assetVersions![0]!, query: 'closures' };
    const result = await readSavedEvidence(store, input);
    expect(result.packets[0]!.excerpts[0]!.text).toContain('Comment ID: reply-1');
    expect(result.packets[0]!.excerpts[0]!.text).toContain('Saved position: 1.1');
    const controller = new AbortController();
    const search = store.searchSavedOriginal.bind(store);
    const write = vi.spyOn(store, 'savePacket');
    const interrupted = vi.spyOn(store, 'searchSavedOriginal').mockImplementation((...args) => {
      const found = search(...args);
      controller.abort();
      return found;
    });
    await expect(readSavedEvidence(store, input, controller.signal)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    interrupted.mockRestore();
    const tools = await store.searchTools(() => undefined, new AbortController().signal);
    for (let index = 0; index < SAVED_EVIDENCE_READ_LIMIT; index++) await tools.search_originals!.execute!(input,
      { toolCallId: `read-${index}`, messages: [], context: {} });
    await expect(tools.search_originals!.execute!(input,
      { toolCallId: 'over-limit', messages: [], context: {} })).rejects.toThrow('read limit');
    await store.delete(input.assetVersion);
    await expect(readSavedEvidence(store, input)).rejects.toThrow('unavailable or deleted');
  }));

test.each([false, true])('exact watercolor follow-up retains original passages after reopening (interrupted: %s)', async interrupted =>
  within(`watercolor-exact-followup-${interrupted}`, async (store, reopen) => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
    const versions = new Map<string, string>();
    for (const videoId of [annaId, kelogId]) {
      const raw = await store.retrieve(`captions:${videoId}`, 'transcript', videoId, false,
        async () => ({ value: watercolorTranscript(videoId), cacheStatus: 'miss' }), value => ({ language: 'en', segments: value.segments.length, endMs: value.segments.at(-1)?.endMs }));
      versions.set(videoId, raw.assetVersions![0]!);
    }
    const restored = reopen();
    const reads = [
      [annaId, { offset: 0, limit: 1 }],
      [kelogId, { offset: 0, limit: 1 }],
      [annaId, { startMs: 349_000, endMs: 398_000, limit: 30 }],
      [annaId, { query: 'gravity', limit: 30 }],
      [annaId, { startMs: 423_000, endMs: 440_000 }],
      [kelogId, { query: 'wet not beady' }],
      [kelogId, { query: 'nearly dry' }],
      [annaId, { query: 'arches cold pressed' }],
      [annaId, { query: 'quinacridone red' }],
      [annaId, { query: 'alizarin crimson' }],
      [annaId, { query: 'one half minutes' }],
      [annaId, { query: 'seven half minute' }],
    ] as const;
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 } };
    let step = 0;
    const core = new MockLanguageModelV4({ doGenerate: async call => {
      expect(call.tools?.map(tool => tool.name)).not.toContain('get_video_transcript');
      const read = reads[step++];
      if (!read && interrupted) throw new Error('Research phase timeout.');
      return { content: [{ type: 'tool-call', toolCallId: `read-${step}`,
        toolName: read ? 'search_originals' : 'complete_research',
        input: JSON.stringify(read ? { assetVersion: versions.get(read[0]), ...read[1] } : {}) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
    } });
    let finalizerCalled = false;
    const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
      finalizerCalled = true;
      const supplied = JSON.stringify(call.prompt);
      for (const phrase of ['use watercolor medium my favorite is', 'of the exercise i tilted my page so the',
        'enough that it still looks wet', 'but not beady once', 'make sure the brush is damp or nearly',
        'dry you can\'t have it soaking wet', 'arches cold pressed', 'quinacridone red', 'alizarin crimson',
        'seven and a half minute mark', 'so one and a half minutes', 'Willow']) expect(supplied).toContain(phrase);
      // A scripted model checks transport only. It does not prove a live model follows the prompt.
      const ref = (videoId: string, time: number) => restored.evidence().flatMap(packet => packet.excerpts)
        .find(excerpt => excerpt.sourceId === `youtube:${videoId}:transcript` && excerpt.startMs === time * 1000)!.id;
      return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [],
        blocks: [
          { text: '1. Willow, kelogsloops: “enough that it still looks wet” and “but not beady”. For lifting: “make sure the brush is damp or nearly” / “dry you can\'t have it soaking wet”.',
            evidenceIds: [ref(kelogId, 297), ref(kelogId, 299), ref(kelogId, 496), ref(kelogId, 498)] },
          { text: '2. Anna: “use watercolor medium”. Smaller areas dry faster. For gravity: “i tilted my page” / “top part was drying much faster”; the bottom stays wet longer.',
            evidenceIds: [ref(annaId, 378), ref(annaId, 352), ref(annaId, 354), ref(annaId, 423), ref(annaId, 426), ref(annaId, 434)] },
          { text: '3. Anna uses Arches cold pressed paper, quinacridone red first and alizarin crimson for veins. The elapsed experiment interval is 7.5 minus 1.5 = 6 minutes, not a video timestamp.',
            evidenceIds: [ref(annaId, 80), ref(annaId, 171), ref(annaId, 304), ref(annaId, 121), ref(annaId, 275)] },
        ] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    const freshFetch = vi.fn(async (): Promise<never> => { throw new Error('Fresh YouTube retrieval prohibited'); });
    const ctx = context(restored, { transcript: freshFetch, video: freshFetch, search: freshFetch } as unknown as YouTubeAgentProvider);
    ctx.finalize = vi.fn(async (_tool, input) => buildAgentTurnResult({ runId: ctx.runId,
      conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
      { userId: 'test', creditsRemaining: 100 }, input, restored.evidence(), 0));
    await runResearchAgentWithModel({ model: core, finalizationModel: finalizer, message: watercolorFollowup,
      conversationHistory: [{ userMessageId: 'correction', agentMessageId: 'previous-answer', user: watercolorCorrection, assistant: 'I cannot supply exact quotations because only analyst findings were supplied.', resourceIds: [annaId, kelogId] }],
      decision: { route: 'topic_research', comparisonVideoIds: [annaId, kelogId], savedOnly: true, skill: 'verify_saved_evidence',
        useStoryboard: false, numberedItemCount: 3 }, context: ctx });
    expect(step).toBe(reads.length + 1);
    expect(finalizerCalled).toBe(true);
    expect(freshFetch).not.toHaveBeenCalled();
    const answer: ReturnType<typeof buildAgentTurnResult> = await vi.mocked(ctx.finalize).mock.results[0]!.value;
    expect(answer.citations).toContainEqual(expect.objectContaining({ videoId: annaId, startMs: 304_000,
      excerpt: 'alizarin crimson and start working on' }));
    const savedAgain = reopen();
    const evidence = savedAgain.evidence().flatMap(packet => packet.excerpts);
    for (const [videoId, text, startMs] of [
      [annaId, 'use watercolor medium my favorite is', 378_000],
      [annaId, 'of the exercise i tilted my page so the', 423_000],
      [kelogId, 'you\'ll want the paper to be just damp', 295_000],
      [kelogId, 'make sure the brush is damp or nearly', 496_000],
      [annaId, 'alizarin crimson and start working on', 304_000],
    ] as const) {
      const excerpt = evidence.find(item => item.text === text)!;
      expect(excerpt).toMatchObject({ sourceId: `youtube:${videoId}:transcript`, startMs });
      expect(savedAgain.evidenceForCitations([excerpt.id])[0]!.excerpts).toContainEqual(excerpt);
    }
  }));

test('watercolor follow-up reads original medium captions with precise citations after reconstruction', async () =>
  within('watercolor-original-captions', async (store, reopen) => {
    const value = { ...transcript(), videoId: 'LxyZ4a_YzSQ', segments: [
      { text: 'section number two if you want to extend', startMs: 374_000, endMs: 376_000 },
      { text: 'the drying time and improve pigment flow', startMs: 376_000, endMs: 378_000 },
      { text: 'use watercolor medium my favorite is', startMs: 378_000, endMs: 381_000 },
      { text: 'synthetic ox gold from the brand core', startMs: 381_000, endMs: 384_000 },
    ] };
    const saved = await store.retrieve('watercolor', 'transcript', value.videoId, false,
      async () => ({ value, cacheStatus: 'miss' }), () => ({ language: 'en', endMs: 384_000 }));
    const restored = reopen();
    const received: EvidencePacket[] = [];
    const tools = await restored.searchTools(packets => { received.push(...packets); }, new AbortController().signal);
    expect(tools.search_originals, 'Exact quotation requests need an original-asset reader').toBeDefined();
    const result = await tools.search_originals!.execute!(
      { assetVersion: saved.assetVersions![0]!, query: 'watercolor medium' },
      { toolCallId: 'watercolor-read', messages: [], context: {} },
    );
    expect(JSON.stringify(result)).toContain('use watercolor medium my favorite is');
    const final = finalizationEvidenceForModel(received, 40_000);
    const quote = final.evidence.flatMap(packet => packet.excerpts ?? [])
      .find(excerpt => excerpt.text === 'use watercolor medium my favorite is');
    expect(quote).toMatchObject({ startMs: 378_000, endMs: 381_000 });
    expect(restored.evidenceForCitations([final.fullIds.get(quote!.id)!])[0]?.excerpts)
      .toContainEqual(expect.objectContaining({ text: quote!.text, startMs: 378_000 }));
  }));

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
/** Simulate an asset saved before the segment index existed. */
function forgetSavedOriginalIndex(sql: SqlStorage, version: string) {
  sql.exec('DELETE FROM session_original_segments WHERE version=?', version);
  sql.exec('DELETE FROM session_original_assets WHERE version=?', version);
}
async function saveComments(store: SessionEvidenceStore, value: unknown, key = 'comments') {
  return (await store.retrieve(key, 'comments', id, false, async () => ({ value, cacheStatus: 'miss' as const }), () => ({}))).assetVersions![0]!;
}
const indexedComment = (text: string) => ({ id: 'one', text, author: { name: 'Alice', thumbnails: [] }, isPinned: false, isHearted: false, replies: [] });

function within(
  name: string,
  fn: (store: SessionEvidenceStore, reopen: () => SessionEvidenceStore, sql: SqlStorage) => Promise<void>,
) {
  return runInDurableObject(env.AGENT_RUNTIME.getByName(name), async (_instance, state) => {
    const reopen = () => new SessionEvidenceStore(state.storage.sql, env.RESEARCH, `test-session/${name}/`);
    await fn(reopen(), reopen, state.storage.sql);
  });
}

test('file cleanup batches deletes, preserves active blobs and retains failed batches for retry', async () =>
  within('cleanup-batches', async (store, reopen, sql) => {
    await store.retrieve('active', 'transcript', id, false,
      async () => ({ value: transcript(), cacheStatus: 'miss' }), () => ({}));
    const active = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets').one().blob_key;
    const keys = Array.from({ length: 205 }, (_, i) => `cleanup-batches/${i}`);
    store.queueCleanup([...keys, active]);
    const remove = env.RESEARCH.delete.bind(env.RESEARCH);
    let requests = 0;
    const deleting = vi.spyOn(env.RESEARCH, 'delete').mockImplementation(async batch => {
      expect(Array.isArray(batch)).toBe(true);
      expect(batch).not.toContain(active);
      if (++requests === 2) throw new Error('temporary R2 failure');
      return remove(batch);
    });
    try {
      await expect(store.cleanup()).rejects.toThrow('temporary R2 failure');
      expect(sql.exec('SELECT * FROM session_blob_deletions').toArray()).toHaveLength(106);
      await reopen().cleanup();
      expect(sql.exec('SELECT blob_key FROM session_blob_deletions').toArray()).toEqual([{ blob_key: active }]);
      expect(deleting.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 100, 5]);
      expect(await env.RESEARCH.get(active)).not.toBeNull();
    } finally { deleting.mockRestore(); }
  }));
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

test('searches saved transcripts across assets before analysis, with valid citations', async () =>
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
    const result = await searchSavedEvidence(reopen(), { query: 'enterprise pricing' });
    expect(result.packets).toHaveLength(2);
    for (const packet of result.packets) {
      expect(packet.excerpts).toHaveLength(1);
      expect(store.evidenceForCitations([packet.excerpts[0]!.id])).toHaveLength(1);
    }
    expect(p.transcript).toHaveBeenCalledTimes(2);
    await store.delete(first.assetVersions![0]);
    expect((await searchSavedEvidence(reopen(), { query: 'enterprise pricing' })).packets).toHaveLength(1);
    // FTS operators are plain words here: "OR" is searched as a word, never as syntax.
    await expect(searchSavedEvidence(store, { query: '" OR * ()' })).resolves.toMatchObject({ packets: [] });
    await store.delete();
    expect((await searchSavedEvidence(reopen(), { query: 'enterprise' })).packets).toEqual([]);
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
    expect(Object.keys(tools).sort()).toEqual(['read_session_history', 'search_context', 'search_originals']);
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
    // Saved captions belong to search_originals; search_context does not return raw copies of them.
    expect((await run('analysis', 'clear sentence')).packets).toEqual([]);
    const originals = await tools.search_originals!.execute!({ query: 'clear sentence' }, options) as { packets: EvidencePacket[] };
    expect(originals.packets).toHaveLength(1);
    expect(received).toHaveLength(1);
    await store.delete(packet.assetVersions![0]);
    expect(await run('memory', 'opening')).toEqual([]);
    expect((await tools.search_originals!.execute!({ query: 'clear' }, options) as { packets: EvidencePacket[] }).packets).toEqual([]);
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
    const historical = await searchSavedEvidence(store, { query: 'clear opening' });
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
    expect((await searchSavedEvidence(store, { query: 'clear' })).packets).toEqual([]);
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
      const excerptId = `saved:${raw.assetVersions![0]}:caption:0`;
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
              toolName: coreCalls++ === 0 ? 'search_originals' : 'complete_research',
              input: JSON.stringify(coreCalls === 1 ? { query: 'clear opening' } : {}),
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
                    input: JSON.stringify({ label: 'analysis', query: 'clear opening' }),
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
      const recoveredEvidence = resume ? (await searchSavedEvidence(store, { query: 'clear opening' })).packets : [];
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

test('a search indexes older originals once, and cannot restore an asset deleted during indexing', async () =>
  within('original-index-backfill-race', async (store, reopen, sql) => {
    const raw = await sessionProvider(provider(), store).transcript(id);
    const version = raw.assetVersions![0]!;
    forgetSavedOriginalIndex(sql, version);
    expect((await searchSavedEvidence(reopen(), { query: 'clear opening' })).packets).toHaveLength(1);
    forgetSavedOriginalIndex(sql, version);
    let release!: (value: unknown) => void;
    vi.spyOn(store, 'read').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const search = searchSavedEvidence(store, { query: 'clear' });
    await store.delete(version);
    release(transcript());
    await expect(search).resolves.toMatchObject({ packets: [], unavailable: [] });
    expect(sql.exec('SELECT COUNT(*) AS count FROM session_original_segments').one().count).toBe(0);
    expect(sql.exec('SELECT COUNT(*) AS count FROM session_original_assets').one().count).toBe(0);
  }));

test('sessions created before the move drop their old caption and comment search rows once', async () =>
  within('original-search-migration', async (store, reopen, sql) => {
    await sessionProvider(provider(), store).transcript(id);
    // Recreate the old layout: asset rows in session_context_fts and its marker table.
    sql.exec('CREATE TABLE session_search_assets (version TEXT PRIMARY KEY)');
    sql.exec("INSERT INTO session_context_fts (id,owner,scope,content,metadata) VALUES ('evidence:old:0','asset:old','evidence','A clear opening sentence.','{}')");
    reopen();
    expect(sql.exec("SELECT COUNT(*) AS count FROM session_context_fts WHERE owner LIKE 'asset:%'").one().count).toBe(0);
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('session_search_assets','session_search_asset_delete')").toArray()).toEqual([]);
    // Asset deletion still works without the old trigger.
    await reopen().delete();
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
    await limited.ensureSavedOriginalsIndexed();
    expect((await searchSavedEvidence(limited, { query: 'gold' })).search).toMatchObject({ overLimitSources: 1 });
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
    await unlimited.ensureSavedOriginalsIndexed();

    const limited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix, undefined, undefined, undefined, 7_200);
    const found = await searchSavedEvidence(limited, { query: 'gold medal' });
    expect(found.packets.length).toBeGreaterThan(0);
    expect(found.packets.flatMap(packet => packet.sources.map(source => source.videoId))).toEqual(expect.arrayContaining([shortId]));
    expect(found.packets.flatMap(packet => packet.sources.map(source => source.videoId))).not.toContain(longId);
  }));

test('long transcript matches cannot crowd short-video matches out of a search', async () =>
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
    const videos = (packets: EvidencePacket[]) => packets.flatMap(packet => packet.sources.map(source => source.videoId));

    // Results are grouped by source, so 100 long-video matches still leave room for the short video.
    const unlimitedFound = await searchSavedEvidence(unlimited, { query: 'gold medal' });
    expect(videos(unlimitedFound.packets)).toEqual(expect.arrayContaining([longId, shortId]));
    expect(unlimitedFound.packets.find(packet => packet.sources[0]!.videoId === longId)!.excerpts.length).toBeLessThanOrEqual(5);

    const limited = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix, undefined, undefined, undefined, 7_200);
    const found = await searchSavedEvidence(limited, { query: 'gold medal' });
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
    const gale = await searchSavedEvidence(reopen(), { query: 'Gale' });
    expect(gale.packets).toHaveLength(1);
    expect(gale.packets[0]).toMatchObject({ kind: 'youtube_comments', assetVersions: [version],
      excerpts: [{ id: `saved:${version}:comment:13:0`, text: expect.stringContaining('Author: Gale') }] });
    // The author and the tail of a comment longer than one excerpt are both searchable.
    const janine = await searchSavedEvidence(reopen(), { query: 'Janine' });
    expect(janine.packets[0]!.excerpts[0]!.text).toContain('Author: Janine');
    const tail = await searchSavedEvidence(reopen(), { query: 'objection tilted' });
    const passage = tail.packets[0]!.excerpts.find(excerpt => excerpt.text.includes('final objection concerns the tilted board'))!;
    expect(passage.id.startsWith(`saved:${version}:comment:11:`)).toBe(true);
    expect(passage.text).toContain('Author: Janine');
    // The whole path to the answer model: saved originals reach it unshortened, with the author.
    const { finalizationEvidenceForModel } = await import('../src/agents/runtime/model-evidence');
    const handed = finalizationEvidenceForModel(tail.packets, 100_000).evidence[0]!.excerpts!.map(excerpt => excerpt.text).join('\n');
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
    expect((await searchSavedEvidence(reopen(), { query: 'Gale' })).packets.every(packet => !packet.assetVersions?.includes(version))).toBe(true);
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

test('search_context skips packet copies of an indexed comment page, which the reader returns once', async () =>
  within('comment-search-dedup', async (store, reopen) => {
    const page = commentPage(30, index => `Brush review ${index + 1}. ${'Detail. '.repeat(500)}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    store.savePacket(firstCommentPacket(version, page));
    expect((await reopen().search.searchEvidence(reopen(), 'brush review')).packets).toEqual([]);
    const found = await searchSavedEvidence(reopen(), { query: 'brush review' });
    expect(found.packets).toHaveLength(1);
    const ids = found.packets[0]!.excerpts.map(excerpt => excerpt.id);
    expect(ids.every(excerptId => excerptId.startsWith(`saved:${version}:comment:`))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(found.packets[0]!.artifacts[0]!.data).toMatchObject({ selectedExcerpts: 90, nextOffset: ids.length });
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
    // A page saved before the index whose blob is now unreadable: only the packet rows remain.
    forgetSavedOriginalIndex(sql, version);
    const blob = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version).one().blob_key;
    await env.RESEARCH.delete(blob);
    const found = await reopen().search.searchEvidence(reopen(), 'legacy opinion');
    expect(found.packets.map(packet => packet.excerpts[0]!.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `comment:c${index + 1}:${index}`).sort());
    await expect(searchSavedEvidence(reopen(), { query: 'legacy opinion' })).resolves.toMatchObject({ packets: [], unavailable: [version] });
  }));

test('an older comment page is read from storage once, then searched in SQLite', async () =>
  within('comment-search-cache', async (store, _reopen, sql) => {
    const page = commentPage(20, index => `Palette note ${index + 1}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    forgetSavedOriginalIndex(sql, version);
    const read = vi.spyOn(store, 'read');
    const found = await searchSavedEvidence(store, { query: 'palette note' });
    expect(found.packets[0]!.artifacts[0]!.data).toMatchObject({ selectedExcerpts: 20 });
    expect((await searchSavedEvidence(store, { query: 'palette' })).packets).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    await store.delete(version);
    expect((await searchSavedEvidence(store, { query: 'palette note' })).packets).toEqual([]);
  }));

/** Runs `during` after a store read has started but before it resolves, as a concurrent request would. */
function interleaveReads(store: SessionEvidenceStore, during: () => Promise<void>, times = 1) {
  const read = store.read.bind(store);
  const spy = vi.spyOn(store, 'read');
  for (let index = 0; index < times; index += 1) spy.mockImplementationOnce(async version => {
    const reading = read(version);
    await during();
    return reading;
  });
}

test.each([1, 4])('a deletion elsewhere during a page read keeps all %i matching comments', async matches =>
  within(`comment-search-inflight-${matches}`, async (store, _reopen, sql) => {
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const,
      value: commentPage(6, index => index < matches ? `Easel tip ${index + 1}` : `Other remark ${index + 1}`) }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    forgetSavedOriginalIndex(sql, version);
    // Deleting a memory advances the store generation, so the in-flight page read is fenced.
    interleaveReads(store, async () => store.deleteMemory('unrelated'));
    expect((await searchSavedEvidence(store, { query: 'easel tip' })).packets[0]!.artifacts[0]!.data).toMatchObject({ selectedExcerpts: matches });
  }));

test('a comment search that keeps being interrupted asks for a retry instead of returning nothing', async () =>
  within('comment-search-inflight-exhausted', async (store, _reopen, sql) => {
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: commentPage(2, index => `Easel tip ${index + 1}`) }));
    forgetSavedOriginalIndex(sql, (await sessionProvider(p, store).comments(id)).assetVersions![0]!);
    interleaveReads(store, async () => store.deleteMemory('unrelated'), 3);
    await expect(searchSavedEvidence(store, { query: 'easel tip' })).rejects.toThrow('Retry the request');
  }));

test('deleting the matched page during its read still returns nothing for it', async () =>
  within('comment-search-inflight-own-delete', async (store, _reopen, sql) => {
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: commentPage(2, index => `Easel tip ${index + 1}`) }));
    const version = (await sessionProvider(p, store).comments(id)).assetVersions![0]!;
    forgetSavedOriginalIndex(sql, version);
    interleaveReads(store, async () => { await store.delete(version); });
    expect((await searchSavedEvidence(store, { query: 'easel tip' })).packets).toEqual([]);
  }));

test('repeating a saved-original search reuses its saved rows', async () =>
  within('comment-search-saved-rows', async (store, _reopen, sql) => {
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: commentPage(6, index => `Canvas grain opinion ${index + 1}`) }));
    await sessionProvider(p, store).comments(id);
    const rows = () => sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM session_packets WHERE packet_id LIKE 'session:%'").one().count;
    expect((await searchSavedEvidence(store, { query: 'canvas grain' })).packets).toHaveLength(1);
    const after = rows();
    expect((await searchSavedEvidence(store, { query: 'canvas grain' })).packets).toHaveLength(1);
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

// Durable Object storage is real SQLite, so these cases check the actual porter/unicode61 tokenizer.
test.each([
  ['a circled digit is not the digit', '① ', ' 1 marks the late match.', '1'],
  ['a ligature is not its letters', 'ﬃ ', ' ffi marks the late match.', 'ffi'],
  ['an accented Greek letter is not folded', 'ό ', ' ο marks the late match.', 'ο'],
  ['a letter with two diacritics is not folded', 'ộ ', ' o marks the late match.', 'o'],
  ['a term inside a longer word is not a match', 'start ', ' art marks the late match.', 'art'],
  ['a single diacritic is folded', 'cafeteria ', ' café marks the late match.', 'cafe'],
])('saved comment search follows the real tokenizer: %s', async (_name, early, late, query) =>
  within(`comment-search-tokenizer-${query}`, async (store) => {
    const page = commentPage(1, () => `${early}${'Padding words here. '.repeat(160)}${late}`);
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    await sessionProvider(p, store).comments(id);
    const found = await searchSavedEvidence(store, { query });
    expect(found.packets).toHaveLength(1);
    expect(found.packets[0]!.excerpts.map(excerpt => excerpt.text).join('')).toContain(late.trim());
    expect(found.packets[0]!.excerpts[0]!.text).toContain('Author: Viewer 1');
  }));

test('an author-only comment match shows the comment start with its author', async () =>
  within('comment-search-author-only', async (store) => {
    const page = commentPage(1, () => `Opening line. ${'Padding words here. '.repeat(160)}`);
    page.comments[0]!.author.name = 'Janine';
    const p = provider();
    p.comments = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: page }));
    await sessionProvider(p, store).comments(id);
    const excerpt = (await searchSavedEvidence(store, { query: 'Janine' })).packets[0]!.excerpts[0]!;
    expect(excerpt.text.startsWith('Opening line.')).toBe(true);
    expect(excerpt.text).toContain('Author: Janine');
  }));

// Real SQLite availability/generation checks, with R2 used only to load analyst inputs.
test.each(['transcript', 'frame', 'storyboard_sheet'] as const)(
  'saved %s analysis reads once and fences deletion, clearing, and same-version restoration', async kind => {
    for (const mutation of ['none', 'delete', 'clear', 'restore'] as const) {
      await within(`analysis-recheck-${kind}-${mutation}`, async store => {
        const value = kind === 'transcript' ? transcript() : kind === 'frame' ? oneFrame(id) : oneSheet(id);
        const retrieve = () => store.retrieve(`recheck:${kind}`, kind, id, false,
          async () => ({ value, cacheStatus: 'miss' as const }),
          () => kind === 'storyboard_sheet' ? { sheetIndex: 0, manifestVersion: 'manifest' } : {});
        const version = (await retrieve()).assetVersions![0]!;
        const ctx = context(store, provider());
        const duringInference = async () => {
          if (mutation === 'none') return;
          await store.delete(mutation === 'clear' ? undefined : version);
          if (mutation === 'restore') expect((await retrieve()).assetVersions).toEqual([version]);
        };
        ctx.analyzeFrames = async () => {
          await duringInference();
          return { findings: [{ observation: 'A chart.', timestampsMs: [1000] }], warnings: [] };
        };
        ctx.analyzeStoryboard = async () => {
          await duringInference();
          return { findings: [{ observation: 'A chart.', frameIndexes: [0] }], warnings: [] };
        };
        ctx.transcriptPolicy = { mode: 'contextual_analysis', researchQuestion: 'Describe the opening.',
          analyze: async () => {
            await duringInference();
            return { summary: 'A clear opening sentence.',
              findings: [{ claim: 'A clear opening sentence.', excerptIds: ['opening'] }],
              excerpts: [{ id: 'opening', text: 'A clear opening sentence.', startMs: 0, endMs: 5600 }],
              coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 0, endMs: 5600 }, warnings: [] };
          } };
        const read = vi.spyOn(store, 'read');
        const pending = kind === 'transcript'
          ? executeAnalyzeVideoTranscript({ assetVersion: version, focus: 'Describe the opening.' }, ctx, 'analysis')
          : kind === 'frame'
            ? executeAnalyzeVideoFrames({ assetVersions: [version], focus: 'Describe the chart.' }, ctx, 'analysis')
            : executeAnalyzeVideoStoryboard({ assetVersions: [version], focus: 'Describe the chart.' }, ctx, 'analysis');
        if (mutation === 'none') {
          await expect(pending).resolves.toMatchObject({ assetVersions: [version] });
          expect(store.evidence()).toHaveLength(1);
        } else {
          await expect(pending).rejects.toThrow('unavailable or deleted');
          expect(store.evidence()).toEqual([]);
        }
        expect(read).toHaveBeenCalledExactlyOnceWith(version);
      });
    }
  },
);


test('failed preview cleanup stays queued across store reconstruction and removes only private objects', async () =>
  within('preview-cleanup-retry', async (store, reopen, sql) => {
    const key = 'agent-frames/cleanup-owner/abandoned.jpg';
    const retained = 'agent-frames/cleanup-owner/published.jpg';
    await env.RESEARCH.put(key, new Uint8Array([255, 216, 255, 217]));
    await env.RESEARCH.put(retained, 'retained');
    store.queueCleanup([key]);
    const failing = new SessionEvidenceStore(sql, { delete: async () => { throw new Error('R2 unavailable'); } } as unknown as R2Bucket, 'test-session/preview-cleanup-retry/');
    await expect(failing.cleanup()).rejects.toThrow('R2 unavailable');
    expect(sql.exec('SELECT * FROM session_blob_deletions').toArray()).toEqual([{ blob_key: key }]);
    await reopen().cleanup();
    expect(await env.RESEARCH.head(key)).toBeNull();
    expect(await env.RESEARCH.head(retained)).not.toBeNull();
    expect(sql.exec('SELECT * FROM session_blob_deletions').toArray()).toEqual([]);
  }));


test('saved read attempts survive reopening, failures and concurrent tool instances', async () =>
  within('original-durable-budget', async (store, reopen) => {
    const raw = await store.retrieve('captions', 'transcript', id, false,
      async () => ({ value: transcript(), cacheStatus: 'miss' }), () => ({}));
    const input = { assetVersion: raw.assetVersions![0]! };
    const options = { toolCallId: 'repeated-call', messages: [], context: {} };
    const make = async (s: SessionEvidenceStore, runId = 'same-run') =>
      (await s.searchTools(() => undefined, new AbortController().signal, { runId })).search_originals!.execute!;
    const first = await make(store);
    await expect(first({ assetVersion: 'missing' }, options)).rejects.toThrow('unavailable');
    for (let index = 0; index < 14; index++) await first(input, options);
    const restored = reopen();
    const second = await make(restored);
    const third = await make(reopen());
    const attempts = await Promise.allSettled([second(input, options), third(input, options)]);
    expect(attempts.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(restored.savedEvidenceReadState('same-run').attempts).toBe(16);
    await expect((await make(reopen()))(input, options)).rejects.toThrow('read limit');
    await expect((await make(reopen(), 'next-run'))(input, options)).resolves.toMatchObject({ remainingReads: 15 });
    await store.delete(input.assetVersion);
    // Deletion must not replenish a run's attempt budget.
    await expect(first(input, options)).rejects.toThrow('read limit');
  }));

test.each(['empty', 'withheld', 'no-match'] as const)('saved %s read has honest completion state across reopening', async mode =>
  within(`original-outcome-${mode}`, async (store, reopen) => {
    const value = transcript();
    if (mode === 'empty') value.segments = [];
    const raw = await store.retrieve('captions', 'transcript', id, false,
      async () => ({ value, cacheStatus: 'miss' }), () => ({}));
    const assetVersion = raw.assetVersions![0]!;
    const decision = { route: 'inspect_video' as const, videoId: id, savedOnly: true, skill: 'verify_saved_evidence' as const, useStoryboard: false };
    const tools = await store.searchTools(packets => mode === 'withheld' ? [] : packets,
      new AbortController().signal, { runId: 'outcome-run' });
    const result = await tools.search_originals!.execute!({ assetVersion, ...(mode === 'no-match' ? { query: 'absentliteralword' } : {}) },
      { toolCallId: 'read', messages: [], context: {} }) as { packets: EvidencePacket[] };
    const restored = reopen();
    const state = restored.savedEvidenceReadState('outcome-run');
    expect(unreadOriginalSources(decision, restored.brief(), result.packets)).toEqual([id]);
    expect(pendingOriginalSources(decision, restored.brief(), result.packets, state)).toEqual(mode === 'no-match' ? [id] : []);
    expect(state.outcomes).toEqual(mode === 'no-match' ? [] : [{ assetVersion, reason: mode }]);
    // Another nonempty original for this video must still be attempted.
    if (mode !== 'no-match') {
      await restored.retrieve('other-captions', 'transcript', id, false,
        async () => ({ value: { ...transcript(), segments: [{ ...transcript().segments[0]!, text: 'A different original source.' }] }, cacheStatus: 'miss' }), () => ({}));
      expect(pendingOriginalSources(decision, restored.brief(), result.packets, state)).toEqual([id]);
    }
    expect(pendingOriginalSources(decision, restored.brief(), [], { attempts: 16, outcomes: [] })).toEqual([]);
    await restored.delete(assetVersion);
    expect(reopen().savedEvidenceReadState('outcome-run').outcomes).toEqual([]);
  }));

test.each(['empty', 'withheld', 'unavailable'] as const)('research can complete with an explicit %s gap after recovery', async reason =>
  within(`original-gap-finalization-${reason}`, async (store, reopen, sql) => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
    const value = transcript();
    if (reason === 'empty') value.segments = [];
    const raw = await store.retrieve('captions', 'transcript', id, false,
      async () => ({ value, cacheStatus: 'miss' }), () => ({}));
    if (reason === 'unavailable') {
      forgetSavedOriginalIndex(sql, raw.assetVersions![0]!);
      vi.spyOn(store, 'read').mockRejectedValueOnce(new SyntaxError('corrupt saved JSON'));
    }
    const runId = crypto.randomUUID();
    const tools = await store.searchTools(packets => reason === 'withheld' ? [] : packets,
      new AbortController().signal, { runId });
    await tools.search_originals!.execute!({ assetVersion: raw.assetVersions![0]! },
      { toolCallId: 'original', messages: [], context: {} });
    const restored = reopen();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const core = new MockLanguageModelV4({ doGenerate: async call => {
      expect(call.tools?.map(tool => tool.name)).toContain('complete_research');
      return { content: [{ type: 'tool-call', toolCallId: 'complete', toolName: 'complete_research', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
    } });
    const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
      const supplied = JSON.stringify(call.prompt);
      expect(supplied).toContain('saved_original_not_read');
      expect(supplied).toContain(reason);
      expect(supplied).not.toContain('Hello world');
      return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'low', warnings: [],
        blocks: [{ text: 'The saved original could not supply the requested quotation.', evidenceIds: [] }] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    const freshFetch = vi.fn(async (): Promise<never> => { throw new Error('Fresh retrieval prohibited'); });
    const ctx = context(restored, { transcript: freshFetch, video: freshFetch, search: freshFetch } as unknown as YouTubeAgentProvider);
    ctx.runId = runId;
    ctx.finalize = vi.fn(async (_tool, input) => buildAgentTurnResult({ runId, conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() }, { userId: 'test', creditsRemaining: 0 }, input, [], 0));
    await runResearchAgentWithModel({ model: core, finalizationModel: finalizer, context: ctx,
      message: 'Quote the saved captions without fresh retrieval.',
      decision: { route: 'inspect_video', videoId: id, savedOnly: true, skill: 'verify_saved_evidence', useStoryboard: false },
      inheritedResolved: true, recoveredEvidence: [],
    });
    expect(core.doGenerateCalls).toHaveLength(1);
    expect(ctx.finalize).toHaveBeenCalledOnce();
    expect(freshFetch).not.toHaveBeenCalled();
  }));


test.each(['missing', 'json', 'shape', 'duration'] as const)('permanently unavailable %s original releases the gate across recovery', async mode =>
  within(`original-unavailable-${mode}`, async (store, reopen, sql) => {
    const raw = await store.retrieve('captions', 'transcript', id, false,
      async () => ({ value: transcript(), cacheStatus: 'miss' }), () => ({ endMs: 5600 }));
    const assetVersion = raw.assetVersions![0]!;
    const key = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', assetVersion).one().blob_key;
    if (mode !== 'duration') forgetSavedOriginalIndex(sql, assetVersion);
    if (mode === 'missing') await env.RESEARCH.delete(key);
    if (mode === 'json') await env.RESEARCH.put(key, '{invalid json');
    if (mode === 'shape') await env.RESEARCH.put(key, JSON.stringify({ segments: 'broken' }));
    const reading = mode === 'duration'
      ? new SessionEvidenceStore(sql, env.RESEARCH, `test-session/original-unavailable-${mode}/`, undefined, undefined, undefined, 1)
      : store;
    const tools = await reading.searchTools(packets => packets, new AbortController().signal, { runId: 'unavailable-run' });
    await expect(tools.search_originals!.execute!({ assetVersion }, { toolCallId: 'read', messages: [], context: {} }))
      .resolves.toMatchObject({ packets: [], unavailable: true, remainingReads: 15 });
    const restored = reopen();
    const state = restored.savedEvidenceReadState('unavailable-run');
    expect(state).toEqual({ attempts: 1, outcomes: [{ assetVersion, reason: 'unavailable' }] });
    const decision = { route: 'inspect_video' as const, videoId: id, savedOnly: true, skill: 'verify_saved_evidence' as const, useStoryboard: false };
    expect(pendingOriginalSources(decision, restored.brief(), [], state)).toEqual([]);
    expect(unreadOriginalSources(decision, restored.brief(), [])).toEqual([id]);
  }));


test.each(['transient', 'invalid-query', 'invalid-range', 'cancelled', 'deleted'] as const)(
  '%s read does not become a permanent source failure', async mode =>
  within(`original-nonterminal-${mode}`, async (store, reopen, sql) => {
    const raw = await store.retrieve('captions', 'transcript', id, false,
      async () => ({ value: transcript(), cacheStatus: 'miss' }), () => ({}));
    const assetVersion = raw.assetVersions![0]!;
    const controller = new AbortController();
    forgetSavedOriginalIndex(sql, assetVersion);
    if (mode === 'transient') vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('Temporary R2 failure'));
    if (mode === 'cancelled' || mode === 'deleted') vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      if (mode === 'cancelled') controller.abort(new Error('Cancelled'));
      else await store.delete(assetVersion);
      throw new SyntaxError('Late decode failure');
    });
    const tools = await store.searchTools(packets => packets, controller.signal, { runId: 'nonterminal' });
    await expect(tools.search_originals!.execute!({ assetVersion,
      ...(mode === 'invalid-query' ? { query: '!!!' } : {}),
      ...(mode === 'invalid-range' ? { startMs: 20, endMs: 10 } : {}),
    }, { toolCallId: 'read', messages: [], context: {} })).rejects.toThrow();
    expect(reopen().savedEvidenceReadState('nonterminal')).toEqual({ attempts: 1, outcomes: [] });
    if (mode === 'transient') {
      const recovered = await reopen().searchTools(packets => packets, new AbortController().signal, { runId: 'nonterminal' });
      await expect(recovered.search_originals!.execute!({ assetVersion }, { toolCallId: 'retry', messages: [], context: {} }))
        .resolves.toMatchObject({ coverage: { returnedExcerpts: 1 }, remainingReads: 14 });
    }
  }));


test('invalid comment time filters never mark a corrupt original unavailable', async () =>
  within('original-comment-invalid-filter', async (store, reopen, sql) => {
    const value = { comments: [{ id: 'comment', text: 'saved comment', author: { name: 'Alice' } }] };
    const raw = await store.retrieve('comments', 'comments', id, false,
      async () => ({ value, cacheStatus: 'miss' }), () => ({}));
    const assetVersion = raw.assetVersions![0]!;
    const key = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', assetVersion).one().blob_key;
    await env.RESEARCH.put(key, '{broken');
    const tools = await store.searchTools(packets => packets, new AbortController().signal, { runId: 'invalid-filter' });
    await expect(tools.search_originals!.execute!({ assetVersion, startMs: 10 }, { toolCallId: 'read', messages: [], context: {} }))
      .rejects.toThrow('Timestamp filters');
    expect(reopen().savedEvidenceReadState('invalid-filter')).toEqual({ attempts: 1, outcomes: [] });
  }));

// Deterministic replays of saved sessions: original reads, caption times and provider-free search.
const gcnId = 'YhOT5GYUZJw', officialId = 'Ml9Ojbl2uaw', jsId = 'DC471a9qrU4';
const replayMeta = { source: 'allthingsyoutube' as const, fetchedAt: '2026-10-26T00:00:00Z', partial: false, warnings: [] };
// Captions and comments come from saved UI previews, not a fresh provider fetch.
// Preview timestamps have whole-second precision; comment IDs below are fixture IDs.
function replayTranscript(videoId: string, values: (string | number)[][]): Transcript {
  const rows = values as [number, string][];
  return { videoId, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'asr', isTranslatable: true, isDefault: true },
    segments: rows.map(([seconds, text], index) => ({ text, startMs: seconds * 1000,
      endMs: (rows[index + 1]?.[0] ?? seconds + 2) * 1000,
      durationMs: ((rows[index + 1]?.[0] ?? seconds + 2) - seconds) * 1000 })),
    text: rows.map(row => row[1]).join(' '), meta: replayMeta };
}
function replayComments(): CommentsPage {
  return { videoId: jsId, meta: replayMeta, totalCount: 213, continuation: 'fixture-more-remote-comments',
    comments: javascriptComments.map(row => ({
      id: `saved-position-${row.position}`, text: row.text, author: { name: row.author, thumbnails: [] },
      isPinned: false, isHearted: false, replies: [],
    })) };
}
async function seedReplay(store: SessionEvidenceStore, name: string) {
  const prior: EvidencePacket[] = [];
  if (name.startsWith('bicycle')) {
    for (const [videoId, rows, analysis] of [[gcnId, gcnCaptions, gcnAnalysis], [officialId, officialCaptions, officialAnalysis]] as const) {
      const saved = await store.retrieve(`captions:${videoId}`, 'transcript', videoId, false,
        async () => ({ value: replayTranscript(videoId, rows), cacheStatus: 'miss' }), value => ({ segments: value.segments.length }));
      const packet = evidencePacketSchema.parse({ ...analysis, assetVersions: saved.assetVersions });
      store.savePacket(packet);
      prior.push(packet);
    }
  } else {
    await store.retrieve('comments', 'comments', jsId, false,
      async () => ({ value: replayComments(), cacheStatus: 'miss' }), value => ({ comments: value.comments.length, complete: false }));
  }
  return prior;
}

test('prior transcript analyses cannot exhaust a saved-original verification run before it reads', async () => {
  const { MockLanguageModelV4 } = await import('ai/test');
  const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
  await runInDurableObject(env.AGENT_RUNTIME.getByName('bicycle-prior-budget'), async (_instance, state) => {
    const store = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-replay/bicycle-prior-budget/');
    const prior = await seedReplay(store, 'bicycle');
    const versions = store.brief().assets.map(asset => asset.version);
    let step = 0;
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 } };
    const core = new MockLanguageModelV4({ doGenerate: async call => {
      const current = step++;
      if (current < 2) expect(call.tools?.map(tool => tool.name)).toEqual(['search_originals']);
      else expect(call.tools?.map(tool => tool.name)).toContain('search_context');
      const toolName = current < 2 ? 'search_originals' : 'complete_research';
      return { content: [{ type: 'tool-call' as const, toolCallId: `step-${current}`, toolName,
        input: JSON.stringify(current < 2 ? { assetVersion: versions[current], limit: 1 } : {}) }],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] };
    } });
    const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ confidence: 'high', warnings: [],
        blocks: [{ text: 'Rowan source passages recovered.', evidenceIds: store.evidence().filter(packet => packet.packetId.startsWith('session:original:'))
          .flatMap(packet => packet.excerpts.map(excerpt => excerpt.id)) }] }) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [],
    }) });
    const finish = vi.fn(async (_id, input) => buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 100 }, input, store.evidence(), 0));
    await runResearchAgentWithModel({ message: bicycleHistory[3]!.user,
      conversationHistory: bicycleHistory.slice(0, 3).map((turn, index) => ({ ...turn,
        userMessageId: `u${index}`, agentMessageId: `a${index}`, resourceIds: [gcnId, officialId] })),
      decision: { route: 'topic_research', comparisonVideoIds: [gcnId, officialId], researchVideoCount: 2,
        savedOnly: true, skill: 'verify_saved_evidence', useStoryboard: false },
      recoveredEvidence: prior, inheritedResolved: true, model: core, finalizationModel: finalizer,
      context: { runId: crypto.randomUUID(), signal: new AbortController().signal, provider: savedOnlyProvider(), session: store,
        getEvidence: () => store.evidence(), transcriptPolicy: { mode: 'complete_transcript' },
        executeEvidenceTool: async execution => execution.execute(), finalize: finish } });
    expect(step).toBe(3);
    expect(finish).toHaveBeenCalledOnce();
  });
});

test('real saved JavaScript comments 13 and 17 are searchable after reopening, without provider access', async () => {
  await runInDurableObject(env.AGENT_RUNTIME.getByName('real-js-comments'), async (_instance, state) => {
    const reopen = () => new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-replay/real-js-comments/');
    await seedReplay(reopen(), 'javascript');
    const store = reopen(), assetVersion = store.brief().assets[0]!.version;
    for (const [query, position] of [['Promise.all', 17], ['imperative declarative', 13]] as const) {
      const result = await readSavedEvidence(store, { assetVersion, query });
      const text = result.packets.flatMap(packet => packet.excerpts).map(excerpt => excerpt.text).join('\n');
      expect(text).toContain(javascriptComments[position - 1]!.text);
      expect(text).toContain(javascriptComments[position - 1]!.author);
      expect(result.coverage.totalExcerpts).toBe(20);
      expect(result.coverage.sourceContinuationAvailable).toBe(true);
    }
  });
});

test('real saved Bicycle passages retain caption times instead of analyst window starts', async () => {
  await runInDurableObject(env.AGENT_RUNTIME.getByName('real-bicycle-passages'), async (_instance, state) => {
    const store = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-replay/real-bicycle-passages/');
    await seedReplay(store, 'bicycle');
    for (const [videoId, query, time] of [[officialId, '13 kilometer', 167_000], [officialId, 'gradient 8', 170_000],
      [gcnId, 'electronic systems', 152_000], [gcnId, 'keep under tension', 173_000]] as const) {
      const assetVersion = store.brief().assets.find(asset => asset.videoId === videoId)!.version;
      const result = await readSavedEvidence(store, { assetVersion, query });
      expect(result.packets[0]!.excerpts.some(excerpt => excerpt.startMs === time)).toBe(true);
    }
  });
});

test('first-turn search across bicycle transcripts returns the definition beyond the matching cue', async () =>
  within('bicycle-preview-ending', async store => {
    await seedReplay(store, 'bicycle');
    const { packets } = await searchSavedEvidence(store, { query: 'nine-speed' });
    const official = packets.find(packet => packet.sources.some(source => source.videoId === officialId));
    expect(official?.excerpts.map(cue => cue.text).join(' ')).toContain('nine cogs means a nine-speed bike and so on');
  }));

test('both chess quote previews include the continuation after their matched words', async () =>
  within('chess-preview-endings', async store => {
    const value = replayTranscript(id, [[41, "black's king is not in check"], [44, 'and has no legal move.'],
      [48, "Remember, in chess, you're"], [51, 'never forced to make an illegal move, so'],
      [53, 'black cannot put the king onto a square'], [56, 'where it would be captured.'],
      [137, 'The king is trapped.'], [139, 'But does that mean stalemate?'],
      [141, 'Not in this position because notice'], [143, 'black has another piece. Black could'],
      [145, 'play the move h3, allowing white to'], [148, 'correct the mistake from the last move'],
      [150, 'and deliver checkmate with queen to b7.']]);
    const raw = await store.retrieve('captions', 'transcript', id, false, async () => ({ value, cacheStatus: 'hit' }), () => ({}));
    const packets: EvidencePacket[] = [];
    for (const [query, ending] of [['Remember chess never forced illegal', 'where it would be captured.'],
      ['not in this position', 'and deliver checkmate with queen to b7.']] as const) {
      const result = await readSavedEvidence(store, { assetVersion: raw.assetVersions![0], query });
      expect(result.packets[0]!.excerpts.map(cue => cue.text)).toContain(ending);
      packets.push(...result.packets);
    }
    expect(unverifiedCaptionPassages(packets)).toHaveLength(2);
    for (const preview of [...packets]) {
      const startMs = preview.excerpts[0]!.startMs, endMs = preview.excerpts.at(-1)!.endMs;
      const read = await readSavedEvidence(store, { assetVersion: raw.assetVersions![0], startMs, endMs });
      packets.push(...read.packets);
      expect(unverifiedCaptionPassages(packets).map(passage => passage.packetId)).not.toContain(preview.packetId);
    }
    expect(unverifiedCaptionPassages(packets)).toEqual([]);
  }));

test('a lead-in read leaves both watercolor gradient passages pending until their cues are read', async () =>
  within('watercolor-gradient-passages', async store => {
    const saved = await store.retrieve('captions', 'transcript', kelogId, false,
      async () => ({ value: watercolorTranscript(kelogId), cacheStatus: 'hit' }), () => ({}));
    const assetVersion = saved.assetVersions![0]!;
    const { packets } = await readSavedEvidence(store, { assetVersion, query: 'gradient' });
    const pendingStarts = () => unverifiedCaptionPassages(packets).map(passage => passage.startMs);
    expect(packets).toHaveLength(1);
    expect(pendingStarts()).toEqual([200_000, 646_000]);
    for (const [startMs, endMs, expected] of [
      [200_000, 202_000, [204_000, 646_000]],
      [204_000, 220_000, [646_000]],
      [646_000, 670_000, []],
    ] as const) {
      packets.push(...(await readSavedEvidence(store, { assetVersion, startMs, endMs })).packets);
      expect(pendingStarts()).toEqual(expected);
    }
  }));

// Segment index: originals are searched in SQLite with stemming, never reread from R2.
test.each([
  ["DON’T", "Don't rush", 1], ['paint', 'painting', 1], ['mix', 'mixing your own greens', 1], ['lube', 'I lubed it yesterday', 1],
  ['anna', "Anna's palette", 1], ['café', 'CAFÉ brush', 1], ['Promise.all', 'Use Promise.all here', 1], ['Alice', 'Nice tutorial', 1],
  ['tutorial', 'Nice tutorial', 1], ["don't", 'London time', 0], ['t', "Don't rush", 0],
] as const)('saved comment search: %s in %s', async (query, text, count) =>
  within(`original-words-${query}-${count}`, async store => {
    const assetVersion = await saveComments(store, { meta: transcript().meta, comments: [indexedComment(text)] });
    const result = await readSavedEvidence(store, { assetVersion, query });
    expect(result.coverage.returnedExcerpts).toBe(count);
    if (count) expect(result.packets[0]!.excerpts[0]!.text).toContain('Author: Alice');
  }));

test('saved comment search ignores attribution labels and keeps historical completeness', async () =>
  within('original-labels-history', async store => {
    const plain = await saveComments(store, { comments: [indexedComment('Nice tutorial')] });
    for (const query of ['author', 'comment', 'position'])
      expect((await readSavedEvidence(store, { assetVersion: plain, query })).coverage.returnedExcerpts).toBe(0);
    const unknown = await readSavedEvidence(store, { assetVersion: plain });
    expect(unknown.coverage).toMatchObject({ returnedExcerpts: 1 });
    expect(unknown.coverage.sourcePartial).toBeUndefined();
    const { replies: _replies, ...withoutReplies } = indexedComment('No replies here');
    const legacy = await saveComments(store, { meta: {}, comments: [withoutReplies] }, 'legacy-comments');
    expect((await readSavedEvidence(store, { assetVersion: legacy })).coverage.returnedExcerpts).toBe(1);
    const partial = await saveComments(store, { meta: { partial: true, warnings: ['Missing page'] }, comments: [indexedComment('Partial page')] }, 'partial-comments');
    const read = await readSavedEvidence(store, { assetVersion: partial });
    expect(read.coverage.sourcePartial).toBe(true);
    expect(read.packets[0]!.warnings.map(warning => warning.message)).toContain('Missing page');
  }));

test('saved captions are indexed on save and paged without touching storage', async () =>
  within('original-index-no-storage', async (store, reopen, sql) => {
    const value = transcript();
    value.segments = ['you want to lube it', 'every hundred miles or so', 'and wipe off the excess', 'then shift through the gears', 'mixing your own greens']
      .map((text, index) => ({ text, startMs: index * 3000, endMs: index * 3000 + 3000, durationMs: 3000 }));
    const raw = await store.retrieve('captions', 'transcript', id, false, async () => ({ value, cacheStatus: 'miss' }), () => ({}));
    const assetVersion = raw.assetVersions![0]!;
    expect(sql.exec('SELECT COUNT(*) AS count FROM session_original_segments WHERE version=?', assetVersion).one().count).toBe(5);
    // The blob is gone: every read below must come from SQLite.
    await env.RESEARCH.delete(sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', assetVersion).one().blob_key);
    const restored = reopen();
    const storage = vi.spyOn(restored, 'read');
    // Words split across consecutive captions still match, with context following the last matched word.
    const split = await readSavedEvidence(restored, { assetVersion, query: 'lube hundred' });
    expect(split.packets[0]!.excerpts.map(excerpt => excerpt.startMs)).toEqual([0, 3000, 6000, 9000, 12000]);
    expect((await readSavedEvidence(restored, { assetVersion, query: 'lube gears' })).coverage.selectedExcerpts).toBe(0);
    expect((await readSavedEvidence(restored, { assetVersion, query: 'mix' })).packets[0]!.excerpts.at(-1)!.text).toBe('mixing your own greens');
    const timed = await readSavedEvidence(restored, { assetVersion, startMs: 6000, endMs: 9000 });
    expect(timed.packets[0]!.excerpts.map(excerpt => excerpt.text)).toEqual(['every hundred miles or so', 'and wipe off the excess', 'then shift through the gears']);
    const paged = await readSavedEvidence(restored, { assetVersion, limit: 2, offset: 2 });
    expect(paged.coverage).toMatchObject({ totalExcerpts: 5, selectedExcerpts: 5, returnedExcerpts: 2, nextOffset: 4 });
    expect(paged.packets[0]!.excerpts[0]!.id).toBe(`saved:${assetVersion}:caption:2`);
    expect(storage).not.toHaveBeenCalled();
  }));

test('assets saved before the index are indexed once on first read, and deletion removes the index', async () =>
  within('original-index-backfill', async (store, reopen, sql) => {
    const raw = await store.retrieve('captions', 'transcript', id, false, async () => ({ value: transcript('Mixing greens slowly'), cacheStatus: 'miss' }), () => ({}));
    const assetVersion = raw.assetVersions![0]!;
    forgetSavedOriginalIndex(sql, assetVersion);
    const restored = reopen();
    const storage = vi.spyOn(restored, 'read');
    expect((await readSavedEvidence(restored, { assetVersion, query: 'mix' })).coverage.returnedExcerpts).toBe(1);
    expect((await readSavedEvidence(restored, { assetVersion, query: 'greens' })).coverage.returnedExcerpts).toBe(1);
    expect(storage).toHaveBeenCalledOnce();
    await restored.delete(assetVersion);
    expect(sql.exec('SELECT COUNT(*) AS count FROM session_original_segments').one().count).toBe(0);
    expect(sql.exec('SELECT COUNT(*) AS count FROM session_original_assets').one().count).toBe(0);
    expect(sql.exec("SELECT COUNT(*) AS count FROM session_original_fts WHERE session_original_fts MATCH 'mix'").one().count).toBe(0);
  }));

// Tool roles: search_originals owns original captions and comments, including search across them.
async function saveCaptions(store: SessionEvidenceStore, videoId: string, text: string, refresh = false) {
  return (await store.retrieve(`captions:${videoId}`, 'transcript', videoId, refresh,
    async () => ({ value: { ...transcript(text), videoId }, cacheStatus: 'miss' as const }), () => ({}))).assetVersions![0]!;
}

test('a search across saved originals is bounded, current-first, and counts as one read', async () =>
  within('original-search-bounds', async (store, reopen) => {
    const videos = Array.from({ length: 8 }, (_, index) => `goldvideo0${index}`);
    for (const videoId of videos) await saveCaptions(store, videoId, `Gold medal ceremony number ${videoId}.`);
    const options = { toolCallId: 'search', messages: [], context: {} };
    const tools = await reopen().searchTools(packets => packets, new AbortController().signal, { runId: 'bounded-search' });
    const result = await tools.search_originals!.execute!({ query: 'gold medals' }, options) as
      { packets: EvidencePacket[]; search: Record<string, number>; remainingReads: number; moreSources?: string };
    expect(result.packets).toHaveLength(6);
    expect(result.search).toMatchObject({ matchedSources: 8, returnedSources: 6, omittedSources: 2 });
    expect(result.moreSources).toBeDefined();
    expect(result.remainingReads).toBe(SAVED_EVIDENCE_READ_LIMIT - 1);
    // Each packet names its source, so the agent can page into it by version.
    for (const packet of result.packets) expect(packet.artifacts[0]!.data).toMatchObject({ assetVersion: packet.assetVersions![0], offset: 0 });
    // A refreshed transcript supersedes the old one; the current version ranks first.
    const refreshed = await saveCaptions(reopen(), videos[7]!, 'Gold medal ceremony, revised.', true);
    expect((await searchSavedEvidence(reopen(), { query: 'gold medal revised' })).packets[0]!.assetVersions).toEqual([refreshed]);
    // Nine sources match; the superseded one ranks below every current source, so it is cut first.
    const ranked = await searchSavedEvidence(reopen(), { query: 'gold medal' });
    expect(ranked.search).toMatchObject({ matchedSources: 9, returnedSources: 6 });
    expect(ranked.packets.flatMap(packet => packet.warnings.map(warning => warning.code))).not.toContain('SUPERSEDED_SESSION_EVIDENCE');
  }));

test('a search across saved originals respects its character budget and input rules', async () =>
  within('original-search-budget', async (store, reopen) => {
    for (const videoId of ['budgetvid01', 'budgetvid02', 'budgetvid03'])
      await saveCaptions(store, videoId, `Budget keyword ${'filler text '.repeat(250)}`);
    const found = await searchSavedEvidence(reopen(), { query: 'budget keyword' });
    const characters = found.packets.flatMap(packet => packet.excerpts).reduce((sum, excerpt) => sum + JSON.stringify(excerpt).length, 0);
    expect(characters).toBeLessThanOrEqual(8_000);
    expect(found.packets.length).toBeLessThan(3);
    await expect(searchSavedEvidence(reopen(), {})).rejects.toThrow('assetVersion');
    await expect(searchSavedEvidence(reopen(), { query: 'budget', offset: 5 })).rejects.toThrow('assetVersion');
    await expect(searchSavedEvidence(reopen(), { query: 'budget', startMs: 0 })).rejects.toThrow('assetVersion');
  }));

test('a search across saved originals records withheld sources and keeps transcript analysis in search_context', async () =>
  within('original-search-roles', async (store, reopen) => {
    const version = await saveCaptions(store, id, 'The saved caption mentions a lighthouse.');
    // Transcript analysis is derived context: it stays searchable in search_context.
    store.savePacket(await versionEvidencePacket({ packetId: 'packet:run:analysis', kind: 'youtube_transcript', assetVersions: [version],
      sources: [{ id: 's', provider: 'youtube', kind: 'transcript', videoId: id }],
      excerpts: [{ id: 'analysis:0', sourceId: 's', text: 'The analyst notes a lighthouse metaphor.', startMs: 0 }],
      artifacts: [{ type: 'youtube_transcript_analysis', data: {} }], warnings: [], usage: [] }));
    const context = await reopen().search.searchEvidence(reopen(), 'lighthouse');
    expect(context.packets.map(packet => packet.excerpts[0]!.text)).toEqual(['The analyst notes a lighthouse metaphor.']);
    // Originals withheld by the run's credit reserve become an explicit gap for that source.
    const tools = await reopen().searchTools(() => [], new AbortController().signal, { runId: 'withheld-search' });
    const result = await tools.search_originals!.execute!({ query: 'lighthouse' }, { toolCallId: 'search', messages: [], context: {} }) as
      { packets: EvidencePacket[]; withheld?: boolean };
    expect(result).toMatchObject({ packets: [], withheld: true });
    expect(reopen().savedEvidenceReadState('withheld-search')).toEqual({ attempts: 1, outcomes: [{ assetVersion: version, reason: 'withheld' }] });
  }));

test('an unreadable older source stays a reported gap on every search', async () =>
  within('original-search-unreadable', async (store, reopen, sql) => {
    await saveCaptions(store, 'goodvideo01', 'A readable lighthouse caption.');
    const broken = await saveCaptions(store, 'badvideo001', 'A lighthouse caption.');
    forgetSavedOriginalIndex(sql, broken);
    const blob = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', broken).one().blob_key;
    await env.RESEARCH.put(blob, JSON.stringify({ segments: 'broken' }));
    for (let search = 0; search < 2; search++) {
      const found = await searchSavedEvidence(reopen(), { query: 'lighthouse' });
      expect(found.packets).toHaveLength(1);
      expect(found.unavailable).toEqual([broken]);
    }
  }));

// Comments: each word is indexed once, in the chunk where it starts; matching chunks come first.
test('a long comment is indexed once and a match returns its chunks in order', async () =>
  within('comment-index-once', async (store, reopen, sql) => {
    // "lighthouse" crosses the 1,500-character chunk boundary; "closing remark" sits in the last chunk.
    const text = `${'x'.repeat(1495)} lighthouse keeper ${'padding words here '.repeat(400)}closing remark`;
    const page = commentPage(1, () => text);
    page.comments[0]!.author.name = 'Morgan';
    const version = await saveComments(store, page);
    const rows = sql.exec<{ position: number; search_text: string }>('SELECT position, search_text FROM session_original_segments WHERE version=? ORDER BY position', version).toArray();
    expect(rows).toHaveLength(7);
    // The whole comment and its author are indexed once, on the first chunk only.
    expect(rows[0]!.search_text).toBe(`${text.toLowerCase()} morgan`);
    expect(rows.slice(1).map(row => row.search_text)).toEqual(rows.slice(1).map(() => ''));
    const ids = async (query: string) => (await searchSavedEvidence(reopen(), { query })).packets[0]?.excerpts.map(excerpt => excerpt.id);
    // The first page starts at the comment's beginning, whichever chunk holds the match.
    const ordered = rows.map(row => `saved:${version}:comment:0:${row.position}`);
    for (const query of ['lighthouse', 'keeper', 'closing remark', 'lighthouse closing', 'morgan']) {
      const found = await ids(query);
      expect(found!.length).toBeGreaterThan(1);
      expect(found).toEqual(ordered.slice(0, found!.length));
    }
    // A chunk boundary inside a word never creates a word of its own.
    expect(await ids('ouse')).toBeUndefined();
    const all = await searchSavedEvidence(reopen(), { query: 'closing' });
    // The rest, including the matching last chunk, is one paged read away.
    expect(all.packets[0]!.artifacts[0]!.data).toMatchObject({ selectedExcerpts: rows.length, nextOffset: all.packets[0]!.excerpts.length });
  }));

test('comment indexes from the earlier layout rebuild on first use; caption indexes stay', async () =>
  within('comment-index-format', async (store, reopen, sql) => {
    const comments = await saveComments(store, commentPage(2, index => `Earlier format remark ${index + 1}`));
    const captions = await saveCaptions(store, id, 'Earlier format caption.');
    // The previous layout: format 1, no entry column values.
    sql.exec("UPDATE session_original_assets SET format=1");
    sql.exec('UPDATE session_original_segments SET entry=NULL');
    const restored = reopen();
    const storage = vi.spyOn(restored, 'read');
    expect((await readSavedEvidence(restored, { assetVersion: captions, query: 'caption' })).coverage.returnedExcerpts).toBe(1);
    expect(storage).not.toHaveBeenCalled();
    expect((await readSavedEvidence(restored, { assetVersion: comments, query: 'remark' })).coverage.selectedExcerpts).toBe(2);
    expect(storage).toHaveBeenCalledOnce();
    expect(sql.exec('SELECT format FROM session_original_assets WHERE version=?', comments).one().format).toBe(2);
  }));

// The answer stage receives search coverage limits, not only the passages delivered to it.
async function finalizerInputsAfter(store: SessionEvidenceStore, reopen: () => SessionEvidenceStore, reads: object[], skill: boolean) {
  const { MockLanguageModelV4 } = await import('ai/test');
  const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  let step = 0;
  const core = new MockLanguageModelV4({ doGenerate: async () => {
    const current = step++;
    const read = reads[current];
    return { content: [{ type: 'tool-call', toolCallId: `step-${current}`, toolName: read ? 'search_originals' : 'complete_research',
      input: JSON.stringify(read ?? {}) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  let supplied: { contextIncomplete: boolean; missingInputs: Array<Record<string, unknown>> } | undefined;
  const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
    const payload = call.prompt.find(message => message.role === 'user')!.content;
    supplied ??= JSON.parse(Array.isArray(payload) ? (payload[0] as { text: string }).text : payload as string);
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [],
      blocks: [{ text: 'The saved captions mention a gold medal ceremony.', evidenceIds: ['ref_1'] }] }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const restored = reopen();
  const ctx = context(restored, {} as YouTubeAgentProvider);
  ctx.runId = crypto.randomUUID();
  ctx.finalize = vi.fn(async (_tool, input) => buildAgentTurnResult({ runId: ctx.runId, conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() }, { userId: 'test', creditsRemaining: 100 }, input, restored.evidence(), 0));
  await runResearchAgentWithModel({ model: core, finalizationModel: finalizer, context: ctx, message: 'What do the saved videos say about gold medals?',
    decision: { route: 'topic_research', useStoryboard: false, ...(skill ? { savedOnly: true, skill: 'verify_saved_evidence' as const } : {}) },
    inheritedResolved: true, recoveredEvidence: [] });
  expect(ctx.finalize).toHaveBeenCalledOnce();
  return supplied!;
}

test('sources a search left out reach the finalizer as gaps until they are read', async () =>
  within('original-search-gap-handoff', async (store, reopen) => {
    const versions: string[] = [];
    for (let index = 0; index < 8; index++) versions.push(await saveCaptions(store, `gapvideo0${index}`, `Gold medal ceremony ${index}.`));
    const omitted = await finalizerInputsAfter(store, reopen, [{ query: 'gold medal' }], false);
    expect(omitted.contextIncomplete).toBe(true);
    const gap = omitted.missingInputs.find(input => input.reason === 'saved_original_search_incomplete')!;
    expect(gap).toMatchObject({ query: 'gold medal', matchedSources: 8, returnedSources: 6 });
    expect(gap.unreadSources).toHaveLength(2);
    // Reading the omitted sources directly closes the gap.
    const unread = (gap.unreadSources as Array<{ assetVersion: string }>).map(source => source.assetVersion);
    const covered = await finalizerInputsAfter(store, reopen, [{ query: 'gold medal' }, ...unread.map(assetVersion => ({ assetVersion }))], false);
    expect(covered.missingInputs.filter(input => String(input.reason).startsWith('saved_original'))).toEqual([]);
  }));

test('an unreadable older source reaches the finalizer as a gap outside the verification skill', async () =>
  within('original-unavailable-gap-handoff', async (store, reopen, sql) => {
    await saveCaptions(store, 'goodvideo02', 'A readable gold medal caption.');
    const broken = await saveCaptions(store, 'badvideo002', 'A gold medal caption.');
    forgetSavedOriginalIndex(sql, broken);
    await env.RESEARCH.delete(sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', broken).one().blob_key);
    const supplied = await finalizerInputsAfter(store, reopen, [{ query: 'gold medal' }], false);
    expect(supplied.contextIncomplete).toBe(true);
    expect(supplied.missingInputs).toContainEqual(expect.objectContaining({ reason: 'saved_original_unavailable', assetVersion: broken, videoId: 'badvideo002' }));
  }));

test('a word longer than a chunk is never indexed as its own suffix', async () =>
  within('comment-index-long-word', async (store, reopen, sql) => {
    // One 3,010-character token: its "lighthouse" ending lies two chunks past where the word starts.
    const page = commentPage(2, index => index === 0 ? `${'x'.repeat(3000)}lighthouse` : 'A real lighthouse keeper.');
    page.comments.forEach(comment => { comment.author.name = 'Reader'; });
    const version = await saveComments(store, page);
    const chunks = sql.exec<{ search_text: string }>('SELECT search_text FROM session_original_segments WHERE version=? AND entry=0 ORDER BY position', version).toArray();
    expect(chunks.map(chunk => chunk.search_text)).toEqual([`${'x'.repeat(3000)}lighthouse reader`, '', '']);
    const found = await searchSavedEvidence(reopen(), { query: 'lighthouse' });
    expect(found.packets[0]!.excerpts.map(excerpt => excerpt.id)).toEqual([`saved:${version}:comment:1:0`]);
  }));

// Requested evidence: research cannot complete while a requested kind can still be obtained.
async function runRequested(store: SessionEvidenceStore, p: YouTubeAgentProvider, decision: Extract<CapabilityRouteDecision, { route: 'inspect_video' | 'topic_research' }>,
  steps: Array<{ tool: string; input?: object }>, recoveredEvidence: EvidencePacket[] = [], setup?: (ctx: AgentToolContext) => void) {
  const { MockLanguageModelV4 } = await import('ai/test');
  const { runResearchAgentWithModel } = await import('../src/agents/research/research-agent');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const offered: string[][] = [];
  const core = new MockLanguageModelV4({ doGenerate: async call => {
    offered.push((call.tools ?? []).map(tool => tool.name));
    const step = steps[offered.length - 1] ?? { tool: 'complete_research' };
    return { content: [{ type: 'tool-call', toolCallId: `step-${offered.length}`, toolName: step.tool, input: JSON.stringify(step.input ?? {}) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  let supplied: { missingInputs: Array<Record<string, unknown>> } | undefined;
  let cite: string[] = [];
  const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
    const payload = call.prompt.find(message => message.role === 'user')!.content;
    const text = Array.isArray(payload) ? (payload[0] as { text: string }).text : payload as string;
    supplied ??= JSON.parse(text);
    if (!cite.length) cite = [...new Set(text.match(/ref_\d+/g) ?? [])].slice(0, 12);
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [],
      blocks: [{ text: 'The saved sources were reviewed as requested.', evidenceIds: cite }] }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const ctx = context(store, p);
  setup?.(ctx);
  ctx.finalize = vi.fn(async (_tool, input) => buildAgentTurnResult({ runId: ctx.runId, conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() }, { userId: 'test', creditsRemaining: 100 }, input, store.evidence(), 0));
  await runResearchAgentWithModel({ model: core, finalizationModel: finalizer, context: ctx, decision, inheritedResolved: true, recoveredEvidence,
    message: 'Explain the opening with exact quotes, and what do commenters say?' });
  expect(ctx.finalize).toHaveBeenCalledOnce();
  return { offered, missing: supplied!.missingInputs.filter(input => input.reason === 'requested_evidence_missing') };
}
const withComments = (store: SessionEvidenceStore, comments: ReturnType<typeof vi.fn> = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: commentPage(2, index => `Viewer note ${index + 1}`) }))) => {
  const p = { ...provider(), comments } as unknown as YouTubeAgentProvider;
  return { p: sessionProvider(p, store), comments };
};

test('requested comments keep research open until they are read', async () =>
  within('requested-comments', async store => {
    await saveCaptions(store, id, 'A clear opening sentence.');
    const { p, comments } = withComments(store);
    const { offered, missing } = await runRequested(store, p, { route: 'inspect_video', videoId: id, useStoryboard: false, requestedEvidence: ['comments'] },
      [{ tool: 'get_video_comments', input: { videoId: id } }, { tool: 'complete_research' }]);
    expect(offered[0]).not.toContain('complete_research');
    expect(offered[1]).toContain('complete_research');
    expect(comments).toHaveBeenCalledOnce();
    expect(missing).toEqual([]);
  }));

test('requested quotations keep research open until original captions are read', async () =>
  within('requested-quotes', async store => {
    await saveCaptions(store, id, 'A clear opening sentence.');
    const { offered, missing } = await runRequested(store, withComments(store).p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, requestedEvidence: ['original_quotes'] },
      [{ tool: 'search_originals', input: { query: 'clear opening' } }, { tool: 'complete_research' }]);
    expect(offered[0]).not.toContain('complete_research');
    expect(offered[1]).toContain('complete_research');
    expect(missing).toEqual([]);
  }));

test('requested evidence that cannot be obtained does not block research and reaches the finalizer as a gap', async () =>
  within('requested-unavailable', async store => {
    await saveCaptions(store, id, 'A clear opening sentence.');
    // Saved-only, and no comments were ever saved: comments cannot be obtained in this run.
    const { offered, missing } = await runRequested(store, withComments(store).p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, savedOnly: true, requestedEvidence: ['comments'] }, [{ tool: 'complete_research' }]);
    expect(offered[0]).toContain('complete_research');
    expect(missing).toEqual([{ reason: 'requested_evidence_missing', kind: 'comments', videoId: id }]);
  }));

test('the saved-evidence skill without saved-only reads originals first, then still fetches requested comments', async () =>
  within('requested-skill-retrieval', async store => {
    const version = await saveCaptions(store, id, 'A clear opening sentence.');
    const { p, comments } = withComments(store);
    const { offered, missing } = await runRequested(store, p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, skill: 'verify_saved_evidence', requestedEvidence: ['original_quotes', 'comments'] },
      [{ tool: 'search_originals', input: { assetVersion: version } }, { tool: 'get_video_comments', input: { videoId: id } }, { tool: 'complete_research' }]);
    // Originals come first; retrieval of the unsaved comments is then available, and completion only after them.
    expect(offered[0]).toEqual(['search_originals']);
    expect(offered[1]).toContain('get_video_comments');
    expect(offered[1]).not.toContain('complete_research');
    expect(offered[2]).toContain('complete_research');
    expect(comments).toHaveBeenCalledOnce();
    expect(missing).toEqual([]);
  }));

// Review reproductions: every requested subject and kind is enforced on its own.
const videoA = 'videoaaaaa1', videoB = 'videobbbbb2';
const perVideoComments = (failFor?: string) => vi.fn(async (videoId: string) => {
  if (videoId === failFor) throw new Error('Comments are unavailable for this video.');
  return { cacheStatus: 'miss' as const, value: { ...commentPage(2, index => `Viewer note ${index + 1}`), videoId } };
});
const transcriptAnalysis = (videoId: string): EvidencePacket => ({ packetId: `analysis:${videoId}`, kind: 'youtube_transcript',
  sources: [{ id: `youtube:${videoId}:transcript`, provider: 'youtube', kind: 'transcript', videoId }],
  excerpts: [{ id: `analysis:${videoId}:0`, sourceId: `youtube:${videoId}:transcript`, text: 'The analyst summarizes the explanation.' }],
  artifacts: [{ type: 'youtube_transcript_analysis', data: { analysisKey: `analysis-key:${videoId}` } }], warnings: [], usage: [] });

test('meeting the transcript analysis target does not end research before requested comments are read', async () =>
  within('requested-after-transcript-target', async store => {
    const { p, comments } = withComments(store, perVideoComments());
    const { offered, missing } = await runRequested(store, p, { route: 'topic_research', comparisonVideoIds: [videoA, videoB],
      researchVideoCount: 2, useStoryboard: false, requestedEvidence: ['comments'] },
    [{ tool: 'get_video_comments', input: { videoId: videoA } }, { tool: 'get_video_comments', input: { videoId: videoB } }, { tool: 'complete_research' }],
    [transcriptAnalysis(videoA), transcriptAnalysis(videoB)]);
    expect(comments).toHaveBeenCalledTimes(2);
    expect(offered[1]).not.toContain('complete_research');
    expect(missing).toEqual([]);
  }));

test('a comment failure for one video does not release another video that was not attempted', async () =>
  within('requested-per-video-failure', async store => {
    const { p, comments } = withComments(store, perVideoComments(videoA));
    const { offered, missing } = await runRequested(store, p, { route: 'topic_research', comparisonVideoIds: [videoA, videoB],
      researchVideoCount: 2, useStoryboard: false, requestedEvidence: ['comments'] },
    [{ tool: 'get_video_comments', input: { videoId: videoA } }, { tool: 'get_video_comments', input: { videoId: videoB } }, { tool: 'complete_research' }]);
    expect(offered[1]).not.toContain('complete_research');
    expect(comments).toHaveBeenCalledTimes(2);
    expect(missing).toEqual([{ reason: 'requested_evidence_missing', kind: 'comments', videoId: videoA }]);
  }));

test('reading viewer comments does not satisfy a request for the speaker\'s exact quotations', async () =>
  within('requested-quotes-need-captions', async store => {
    const captions = await saveCaptions(store, id, 'A clear opening sentence.');
    const commentsVersion = await saveComments(store, commentPage(2, index => `Viewer note ${index + 1}`));
    const { offered, missing } = await runRequested(store, withComments(store).p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, requestedEvidence: ['original_quotes', 'comments'] },
      [{ tool: 'search_originals', input: { assetVersion: commentsVersion } }, { tool: 'search_originals', input: { assetVersion: captions } }, { tool: 'complete_research' }]);
    expect(offered[1]).not.toContain('complete_research');
    expect(offered[2]).toContain('complete_research');
    expect(missing).toEqual([]);
  }));

// Requested evidence counts only when the model actually receives it.
test('a transcript withheld for analysis does not satisfy requested quotations', async () =>
  within('requested-quotes-withheld-transcript', async store => {
    const { offered, missing } = await runRequested(store, withComments(store).p,
      // Topic research withholds a fetched transcript's text until it is analyzed.
      { route: 'topic_research', comparisonVideoIds: [id], researchVideoCount: 1, useStoryboard: false, requestedEvidence: ['original_quotes'] },
      [{ tool: 'get_video_transcript', input: { videoId: id } }, { tool: 'search_originals', input: { query: 'clear opening' } }, { tool: 'complete_research' }],
      [], ctx => { ctx.transcriptPolicy = { mode: 'contextual_analysis', researchQuestion: 'Quote the opening.',
        analyze: async () => { throw new Error('Analysis is not part of this test.'); } }; });
    // The fetched transcript's text is withheld from the models, so only the original read opens completion.
    expect(offered[1]).not.toContain('complete_research');
    expect(offered[2]).toContain('complete_research');
    expect(missing).toEqual([]);
  }));

test('a comment search with no matches does not satisfy requested comments', async () =>
  within('requested-comments-empty-search', async store => {
    const commentsVersion = await saveComments(store, commentPage(3, index => `Viewer note ${index + 1}`));
    const filtered = await runRequested(store, withComments(store).p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, requestedEvidence: ['comments'] },
      [{ tool: 'search_originals', input: { assetVersion: commentsVersion, query: 'absentliteralword' } },
        { tool: 'search_originals', input: { assetVersion: commentsVersion } }, { tool: 'complete_research' }]);
    expect(filtered.offered[1]).not.toContain('complete_research');
    expect(filtered.offered[2]).toContain('complete_research');
    expect(filtered.missing).toEqual([]);
  }));

test('a comment fetch that returns no comments satisfies requested comments', async () =>
  within('requested-comments-none-exist', async store => {
    // The empty page is the whole finding: the answer says so without anything to cite.
    const none = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: commentPage(0, () => '') }));
    const { offered, missing } = await runRequested(store, withComments(store, none).p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, requestedEvidence: ['comments'] },
      [{ tool: 'get_video_comments', input: { videoId: id } }, { tool: 'complete_research' }]);
    expect(offered[1]).toContain('complete_research');
    expect(none).toHaveBeenCalledOnce();
    expect(missing).toEqual([]);
  }));

test('a saved-only run whose only evidence is an empty comments page can say so without citations', async () =>
  within('requested-comments-confirmed-empty', async store => {
    const empty = await saveComments(store, commentPage(0, () => ''));
    const { offered, missing } = await runRequested(store, withComments(store).p,
      { route: 'inspect_video', videoId: id, useStoryboard: false, savedOnly: true, requestedEvidence: ['comments'] },
      [{ tool: 'search_originals', input: { assetVersion: empty } }, { tool: 'complete_research' }]);
    // runRequested asserts the answer was accepted; there is nothing to cite and no gap to report.
    expect(offered[1]).toContain('complete_research');
    expect(missing).toEqual([]);
  }));
