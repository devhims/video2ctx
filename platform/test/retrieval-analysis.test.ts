import { withPreviewCleanup } from '../src/agents/runtime/preview-lifecycle';
import { framePreviewKey, saveFramePreviews, packetFramePreviews } from '../src/agents/runtime/frame-previews';
import { saveStoryboardPreviews, packetStoryboardPreviews } from '../src/agents/runtime/storyboard-previews';
import { z } from 'zod';
import { describe, expect, test, vi } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { createGetVideoFramesTool, executeGetVideoFrames } from '../src/agents/providers/youtube/tools/get-video-frames';
import { createGetVideoStoryboardTool, executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import { createGetVideoTranscriptTool, executeGetVideoTranscriptForModel } from '../src/agents/providers/youtube/tools/get-video-transcript';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import { evidencePacketForModel } from '../src/agents/runtime/model-evidence';
import { retrieveWithAnalysis } from '../src/agents/providers/youtube/tools/retrieval-analysis';
import type { EvidencePacket } from '../src/agents/contracts';
import { framesSchema } from '../src/lib/youtube-frames-contract';
import { storyboardSchema } from '../src/agents/providers/youtube/storyboard';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const videoId = 'abcdefghijk';
const version = 'a'.repeat(64);
const frames = framesSchema.parse({ videoId, frames: [{ timestampMs: 1000, mimeType: 'image/jpeg', width: 1920, height: 1080, imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } });
const storyboard = storyboardSchema.parse({ videoId, frameCount: 2, intervalMs: 1000,
  manifest: { totalSheets: 1, framesPerSheet: 2, tileWidth: 100, tileHeight: 100, columns: 2, rows: 1, lastSampleMs: 1000 },
  sheets: [{ imageBase64: '/9j/2Q==', tileWidth: 100, tileHeight: 100, columns: 2, rows: 1, firstFrameIndex: 0, frameCount: 2, intervalMs: 1000 }],
  meta: { partial: false, warnings: [] } });
const transcript: Transcript = { videoId, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isDefault: true, isTranslatable: false },
  segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text: 'Revenue grew.' }], text: 'Revenue grew.',
  meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-20T00:00:00Z', partial: false, warnings: [] } };
function context() {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider call'); };
  const controller = new AbortController();
  const ctx: AgentToolContext = { runId: 'combined', signal: controller.signal, pinnedVideoId: videoId,
    provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected, transcript: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected },
    transcriptPolicy: { mode: 'complete_transcript' }, executeEvidenceTool: execution => execution.execute(), finalize: unexpected };
  return { ctx, controller };
}

describe('retrieval with optional analysis', () => {
  test.each(['frames', 'storyboard', 'transcript'] as const)('%s starts inference before persistence completes, returns one billed packet, and exposes no image bytes', async kind => {
    const { ctx } = context();
    const activities: string[] = [];
    const finishing = deferred();
    ctx.onToolActivity = (id, activity) => { expect(id).toBe('combined'); activities.push(activity); if (activity === 'finishing') finishing.resolve(); };
    const save = deferred();
    const started = deferred();
    const inferred = deferred();
    const captured: string[] = [];
    ctx.executeEvidenceTool = execution => { captured.push(execution.semanticKey); expect(execution.retrySavedAnalysis).toBeTypeOf('function'); return execution.execute(); };
    const response = <T>(value: T) => ({ value, cacheStatus: 'miss' as const, assetVersions: [version] });
    ctx.provider.frames = async (_r, _s, _l, _d, ready) => { ready?.(frames); await save.promise; return response(frames); };
    ctx.provider.storyboard = async (_id, _t, _o, _d, ready) => { ready?.(storyboard); await save.promise; return response(storyboard); };
    ctx.provider.transcript = async (_id, _l, _o, _d, ready) => { ready?.(transcript); await save.promise; return response(transcript); };
    // The pinned-video adapter must forward the availability hook too.
    ctx.provider = createCapabilityProvider(ctx.provider, { route: 'inspect_video', videoId });
    ctx.analyzeFrames = async input => { expect(input.frames).toEqual(frames); started.resolve(); await inferred.promise; return { findings: [{ observation: 'Revenue grew.', timestampsMs: [1000] }], warnings: [] }; };
    ctx.analyzeStoryboard = async input => { expect(input.storyboard.sheets).toEqual(storyboard.sheets); started.resolve(); await inferred.promise; return { findings: [{ observation: 'Revenue grew.', frameIndexes: [1] }], warnings: [] }; };
    ctx.analyzeTranscript = async input => { expect(input.segments).toEqual(transcript.segments); started.resolve(); await inferred.promise; return { summary: 'Revenue grew.', findings: [{ claim: 'Revenue grew.', excerptIds: ['quote'] }], excerpts: [{ id: 'quote', text: 'Revenue grew.', startMs: 0, endMs: 1000 }], coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 0, endMs: 1000 }, warnings: [] }; };
    const preview = { assetId: 'b'.repeat(64), collectionId: 'c'.repeat(64), timestampMs: 1000, width: 200, height: 100 };
    ctx.saveFramePreviews = async () => [preview];
    ctx.saveStoryboardPreviews = async () => [{ ...preview, timestampMs: 0, endTimestampMs: 1000, frameCount: 2, columns: 2, rows: 1, intervalMs: 1000 }];
    const analysis = 'Explain revenue growth';
    const work = kind === 'frames' ? executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis }, ctx, 'combined')
      : kind === 'storyboard' ? executeGetVideoStoryboard({ videoId, analysis }, ctx, 'combined')
      : executeGetVideoTranscriptForModel({ videoId, analysis }, ctx, 'combined');
    let returned = false;
    void work.then(() => { returned = true; });
    expect(activities).toEqual(['loading']);
    await started.promise;
    expect(activities).toEqual(['loading', 'analyzing']);
    inferred.resolve();
    await finishing.promise;
    expect(activities).toEqual(['loading', 'analyzing', 'finishing']);
    expect(returned).toBe(false);
    save.resolve();
    const packet = await work;
    expect(packet.assetVersions).toEqual([version]);
    expect(packet.usage).toHaveLength(1);
    expect(packet.excerpts[0]?.text).toContain('Revenue grew');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(analysis);
    expect(JSON.stringify(packet)).not.toContain('/9j/');
    if (kind === 'frames') expect(packetFramePreviews(packet)).toHaveLength(1);
    if (kind === 'storyboard') expect(packetStoryboardPreviews(packet).sheets).toHaveLength(1);
    if (kind === 'transcript') expect(evidencePacketForModel(packet).transcriptAnalysis?.summary).toBe('Revenue grew.');
  });

  test('retrieval-only calls never start inference and use a different semantic key for each analysis question', async () => {
    const { ctx } = context();
    ctx.provider.frames = async () => ({ value: frames, cacheStatus: 'hit', assetVersions: [version] });
    ctx.analyzeFrames = vi.fn(async () => ({ findings: [], warnings: [] }));
    ctx.onToolActivity = vi.fn();
    const keys: string[] = [];
    ctx.executeEvidenceTool = execution => { keys.push(execution.semanticKey); return execution.execute(); };
    await executeGetVideoFrames({ videoId, timestampsMs: [1000] }, ctx, 'raw');
    expect(ctx.analyzeFrames).not.toHaveBeenCalled();
    expect(ctx.onToolActivity).not.toHaveBeenCalled();
    for (const analysis of ['Read the title', 'Read the legend']) await executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis }, ctx, analysis);
    expect(new Set(keys).size).toBe(3);
    expect(ctx.analyzeFrames).toHaveBeenCalledTimes(2);
  });

  test('complete transcript analysis does not retain raw-caption pagination gaps', async () => {
    const { ctx } = context();
    const long = { ...transcript, segments: Array.from({ length: 5001 }, (_, index) => ({
      text: 'Revenue grew.', startMs: index * 1000, endMs: (index + 1) * 1000, durationMs: 1000,
    })) };
    ctx.provider.transcript = async () => ({ value: long, cacheStatus: 'hit', assetVersions: [version] });
    ctx.analyzeTranscript = async input => {
      expect(input.segments).toHaveLength(5001);
      return { summary: 'Revenue grew.', findings: [], excerpts: [], warnings: [],
        coverage: { completeTranscriptRead: true, segmentCount: 5001, startMs: 0, endMs: 5001000 } };
    };
    const packet = await executeGetVideoTranscriptForModel({ videoId, analysis: 'Summarize all captions' }, ctx, 'long');
    expect(packet.continuation).toBeUndefined();
    expect(packet.warnings.some(warning => warning.code === 'TRANSCRIPT_CONTEXT_TRUNCATED')).toBe(false);
    expect(evidencePacketForModel(packet).transcriptAnalysis?.coverage.completeTranscriptRead).toBe(true);
  });

  test('all three tool schemas expose analysis and keep the ignored legacy focus private', async () => {
    const { ctx } = context();
    for (const tool of [createGetVideoFramesTool(ctx), createGetVideoStoryboardTool(ctx), createGetVideoTranscriptTool(ctx)]) {
      const schema = tool.inputSchema;
      if (!(schema instanceof z.ZodObject)) throw new Error('Expected a Zod object');
      expect(schema.shape).toHaveProperty('analysis');
      expect(schema.shape).not.toHaveProperty('focus');
    }
  });
});

const emptyPacket: EvidencePacket = { packetId: 'p', kind: 'youtube_frames', sources: [], excerpts: [], artifacts: [], warnings: [], usage: [] };
describe('parallel analysis failure boundaries', () => {
  test('save failure aborts and drains inference, and rejects instead of returning findings', async () => {
    const { ctx } = context();
    const started = deferred();
    let aborted = false;
    const work = retrieveWithAnalysis(ctx, { videoId, toolCallId: 'test', content: value => value,
      analyze: async (_value, c) => { started.resolve(); await new Promise<void>(resolve => c.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return emptyPacket; },
    }, async ready => { ready?.('bytes'); await started.promise; throw new Error('R2 save failed'); });
    await expect(work).rejects.toThrow('R2 save failed');
    expect(aborted).toBe(true);
  });

  test('analyst failure returns saved inputs with a retry warning and original usage', async () => {
    const { ctx } = context();
    ctx.provider.frames = async (_r, _s, _l, _d, ready) => { ready?.(frames); return { value: frames, cacheStatus: 'miss', assetVersions: [version] }; };
    ctx.analyzeFrames = async () => { throw Object.assign(new Error('private model failure'), { name: 'AI_APICallError', statusCode: 503, responseHeaders: { 'x-request-id': 'safe-request-id', authorization: 'secret' } }); };
    const log = vi.spyOn(console, 'error');
    const packet = await executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis: 'Read chart' }, ctx, 'failure');
    expect(packet.assetVersions).toEqual([version]);
    expect(packet.usage[0]?.credits).toBeGreaterThan(0);
    expect(packet.excerpts).toEqual([]);
    expect(packet.warnings).toContainEqual(expect.objectContaining({ code: 'RETRIEVAL_ANALYSIS_FAILED' }));
    expect(JSON.stringify(packet)).not.toContain('private model failure');
    expect(packet.artifacts.find(a => a.type === 'retrieval_analysis_failure')?.data).toMatchObject({
      runId: ctx.runId, toolCallId: 'failure', failureCode: 'ANALYSIS_FAILED', errorType: 'AI_APICallError',
      statusCode: 503, providerRequestId: 'safe-request-id',
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private model failure|secret/);
    log.mockRestore();
  });

  test.each(['deletion', 'cancellation', 'different content', 'missing save'] as const)('rejects %s after early analysis', async reason => {
    const { ctx, controller } = context();
    let generation = 0;
    ctx.session = { brief: () => ({ assets: [], memories: [] }), generation: () => generation, has: () => reason !== 'missing save', evidence: () => [], readEvidence: async () => ({ packets: [] }) };
    const started = deferred();
    const work = retrieveWithAnalysis(ctx, { videoId, toolCallId: 'test', content: value => value, analyze: async () => { started.resolve(); return emptyPacket; } }, async ready => {
      ready?.('original'); await started.promise;
      if (reason === 'deletion') generation++;
      if (reason === 'cancellation') controller.abort(new Error('User canceled'));
      return { value: reason === 'different content' ? 'replacement' : 'original', assetVersions: [version], cacheStatus: 'miss' };
    });
    await expect(work).rejects.toThrow();
  });

  test('ignores repeated and late ready notifications', async () => {
    const { ctx } = context();
    const analyze = vi.fn(async () => emptyPacket);
    let late!: (value: string) => void;
    await retrieveWithAnalysis(ctx, { videoId, toolCallId: 'test', content: value => value, analyze }, async ready => {
      late = ready!; ready?.('bytes'); ready?.('bytes'); return { value: 'bytes', cacheStatus: 'hit' };
    });
    late('other');
    expect(analyze).toHaveBeenCalledOnce();
  });

  test('transcript budget refuses inference before retrieval and releases a failed attempt', async () => {
    const { ctx } = context();
    const budget = { tryReserve: vi.fn(() => false), release: vi.fn(), isExhausted: () => false };
    ctx.transcriptPolicy = { mode: 'contextual_analysis', researchQuestion: 'question', analyze: vi.fn(), budget };
    const retrieve = vi.fn(async () => ({ value: 'bytes', cacheStatus: 'miss' as const }));
    const analysis = { videoId, toolCallId: 'budget', budgetKey: 'key', content: (value: string) => value, analyze: async (): Promise<EvidencePacket> => { throw new Error('failed'); } };
    await expect(retrieveWithAnalysis(ctx, analysis, retrieve)).rejects.toThrow('budget');
    expect(retrieve).not.toHaveBeenCalled();
    budget.tryReserve.mockReturnValue(true);
    await retrieveWithAnalysis(ctx, analysis, retrieve);
    expect(budget.release).toHaveBeenCalledWith('key');
  });
});


describe('previews overlap inference after persistence', () => {
  test.each(['frames', 'storyboard'] as const)('%s prepares previews before inference finishes and awaits both', async kind => {
    const { ctx } = context();
    const saved = deferred(), inferred = deferred(), previewDone = deferred();
    const analysisStarted = deferred(), previewStarted = deferred();
    const preview = { assetId: 'b'.repeat(64), collectionId: 'c'.repeat(64), timestampMs: 1000, width: 200, height: 100 };
    ctx.provider.frames = async (_r, _s, _l, _d, ready) => { ready?.(frames); await saved.promise; return { value: frames, cacheStatus: 'miss', assetVersions: [version] }; };
    ctx.provider.storyboard = async (_id, _t, _o, _d, ready) => { ready?.(storyboard); await saved.promise; return { value: storyboard, cacheStatus: 'miss', assetVersions: [version] }; };
    ctx.analyzeFrames = async () => { analysisStarted.resolve(); await inferred.promise; return { findings: [], warnings: [] }; };
    ctx.analyzeStoryboard = async () => { analysisStarted.resolve(); await inferred.promise; return { findings: [], warnings: [] }; };
    ctx.saveFramePreviews = vi.fn(async () => { previewStarted.resolve(); await previewDone.promise; return [preview]; });
    ctx.saveStoryboardPreviews = vi.fn(async () => { previewStarted.resolve(); await previewDone.promise; return [{ ...preview, timestampMs: 0, endTimestampMs: 1000, frameCount: 2, columns: 2, rows: 1, intervalMs: 1000 }]; });
    const work = kind === 'frames' ? executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis: 'Read chart' }, ctx, 'overlap')
      : executeGetVideoStoryboard({ videoId, analysis: 'Read chart' }, ctx, 'overlap');
    let completed = false;
    void work.then(() => { completed = true; });
    await analysisStarted.promise;
    expect(ctx.saveFramePreviews).not.toHaveBeenCalled();
    expect(ctx.saveStoryboardPreviews).not.toHaveBeenCalled();
    saved.resolve();
    await previewStarted.promise; // Inference is still held at this point.
    expect(completed).toBe(false);
    inferred.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    previewDone.resolve();
    const result = await work;
    expect(kind === 'frames' ? packetFramePreviews(result) : packetStoryboardPreviews(result).sheets).toHaveLength(1);
  });

  test.each(['frames', 'storyboard'] as const)('%s preview failure retains analysis with a warning', async kind => {
    const { ctx } = context();
    ctx.provider.frames = async () => ({ value: frames, cacheStatus: 'hit', assetVersions: [version] });
    ctx.provider.storyboard = async () => ({ value: storyboard, cacheStatus: 'hit', assetVersions: [version] });
    ctx.analyzeFrames = async () => ({ findings: [{ observation: 'Chart', timestampsMs: [1000] }], warnings: [] });
    ctx.analyzeStoryboard = async () => ({ findings: [{ observation: 'Chart', frameIndexes: [0] }], warnings: [] });
    ctx.saveFramePreviews = ctx.saveStoryboardPreviews = async () => { throw new Error('Preview save failed'); };
    const result = kind === 'frames' ? await executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis: 'Read chart' }, ctx, 'preview-failure')
      : await executeGetVideoStoryboard({ videoId, analysis: 'Read chart' }, ctx, 'preview-failure');
    expect(result.excerpts).toHaveLength(1);
    expect(result.warnings.some(warning => warning.code.endsWith('PREVIEW_UNAVAILABLE'))).toBe(true);
  });

  test('a failed source save never starts preview preparation', async () => {
    const { ctx } = context();
    const prepare = vi.fn();
    await expect(retrieveWithAnalysis(ctx, { videoId, toolCallId: 'save-failure', content: value => value,
      analyze: async () => emptyPacket }, async ready => { ready?.('bytes'); throw new Error('Source save failed'); }, prepare))
      .rejects.toThrow('Source save failed');
    expect(prepare).not.toHaveBeenCalled();
  });

  test('cancelling preview preparation aborts and drains in-flight analysis', async () => {
    const { ctx, controller } = context();
    const previewStarted = deferred(), analysisStarted = deferred();
    let analysisDrained = false;
    const work = retrieveWithAnalysis(ctx, { videoId, toolCallId: 'preview-cancel', content: value => value,
      analyze: async (_value, inner) => {
        analysisStarted.resolve();
        await new Promise<void>(resolve => { if (inner.signal.aborted) resolve(); else inner.signal.addEventListener('abort', () => resolve(), { once: true }); });
        analysisDrained = true; return emptyPacket;
      },
    }, async ready => { ready?.('bytes'); return { value: 'bytes', cacheStatus: 'hit' }; }, async (_response, signal) => {
      previewStarted.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const rejected = expect(work).rejects.toThrow('cancelled');
    await Promise.all([previewStarted.promise, analysisStarted.promise]);
    controller.abort(new Error('cancelled'));
    await rejected;
    expect(analysisDrained).toBe(true);
  });
});

describe.each(['frames', 'storyboard'] as const)('%s preview ownership', kind => {
  test.each(['deleted', 'changed', 'cancelled', 'publication-failed', 'success', 'analysis-failed'] as const)(
    'cleans up only abandoned previews after %s', async outcome => {
    const { ctx, controller } = context();
    const inference = deferred(), started = deferred(), previewSaved = deferred();
    let generation = 0;
    ctx.session = { brief: () => ({ assets: [], memories: [] }), generation: () => generation,
      has: () => true, evidence: () => [], readEvidence: async () => ({ packets: [] }) };
    const objects = new Map<string, unknown>([['existing-preview', 'keep']]);
    // Exercise raw JPEG copies and private pointers through the real preview savers.
    const bucket = { put: async (key: string, body: unknown) => { objects.set(key, body); },
      delete: async (keys: string[]) => { keys.forEach(key => objects.delete(key)); } } as unknown as R2Bucket;
    const shared = kind === 'storyboard' ? { head: async () => ({}) } as unknown as R2Bucket : undefined;
    ctx.saveFramePreviews = async (...args) => {
      const result = await saveFramePreviews(bucket, 'owner', args[0], args[1], shared, args[2]);
      previewSaved.resolve(); return result;
    };
    ctx.saveStoryboardPreviews = async (...args) => {
      const result = await saveStoryboardPreviews(bucket, 'owner', args[0], args[1], shared, args[2]);
      previewSaved.resolve(); return result;
    };
    ctx.discardPreviews = vi.fn<NonNullable<AgentToolContext['discardPreviews']>>(async previews => bucket.delete(previews.map(preview => framePreviewKey(preview.collectionId, preview.assetId))));
    const result = <T>(value: T) => ({ value, cacheStatus: 'miss' as const, assetVersions: [version] });
    ctx.provider.frames = async (_r, _s, _l, _d, ready) => {
      ready?.(frames);
      return result(outcome === 'changed' ? { ...frames, frames: [{ ...frames.frames[0]!, imageBase64: '/9j/AA==' }] } : frames);
    };
    ctx.provider.storyboard = async (_id, _t, _o, _d, ready) => {
      ready?.(storyboard);
      return result(outcome === 'changed' ? { ...storyboard, sheets: [{ ...storyboard.sheets[0]!, imageBase64: '/9j/AA==' }] } : storyboard);
    };
    const analyze = async () => {
      started.resolve(); await inference.promise;
      if (outcome === 'analysis-failed') throw new Error('Analyst unavailable');
      return { findings: [], warnings: [] };
    };
    ctx.analyzeFrames = ctx.analyzeStoryboard = analyze;
    ctx.executeEvidenceTool = async execution => {
      const packet = await execution.execute();
      if (outcome === 'publication-failed') throw new Error('Packet commit failed');
      return packet;
    };
    const work = kind === 'frames' ? executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis: 'Read chart' }, ctx, 'cleanup')
      : executeGetVideoStoryboard({ videoId, analysis: 'Read chart' }, ctx, 'cleanup');
    const settled = Promise.allSettled([work]);
    await Promise.all([started.promise, previewSaved.promise]);
    expect(objects.size).toBe(2); // The new preview exists while inference is pending.
    if (outcome === 'deleted') generation++;
    if (outcome === 'cancelled') controller.abort(new Error('cancelled'));
    inference.resolve();
    const [finished] = await settled;
    if (outcome === 'success' || outcome === 'analysis-failed') {
      expect(finished!.status).toBe('fulfilled');
      expect(objects.size).toBe(2);
      expect(ctx.discardPreviews).not.toHaveBeenCalled();
    } else {
      expect(finished!.status).toBe('rejected');
      expect([...objects.keys()]).toEqual(['existing-preview']);
      expect(ctx.discardPreviews).toHaveBeenCalledOnce();
    }
  });
});


test('preview rollback drains late writes before removing them', async () => {
  const { ctx } = context();
  const writing = deferred(), release = deferred();
  const preview = { assetId: 'b'.repeat(64), collectionId: 'c'.repeat(64), timestampMs: 1000, width: 200, height: 100 };
  let stored = false;
  ctx.saveFramePreviews = async () => { writing.resolve(); await release.promise; stored = true; return [preview]; };
  ctx.discardPreviews = vi.fn(async () => { expect(stored).toBe(true); stored = false; });
  const work = withPreviewCleanup(ctx, async inner => {
    void inner.saveFramePreviews!(frames, ctx.signal);
    await writing.promise;
    throw new Error('Tool deadline expired');
  });
  const rejected = expect(work).rejects.toThrow('Tool deadline expired');
  await writing.promise;
  expect(ctx.discardPreviews).not.toHaveBeenCalled();
  release.resolve();
  await rejected;
  expect(stored).toBe(false);
  expect(ctx.discardPreviews).toHaveBeenCalledWith([preview]);
});
