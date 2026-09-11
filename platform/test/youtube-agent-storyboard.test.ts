import { buildAgentTurnResult } from '../src/agents/finalizer';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { executeGetVideoStoryboard, getVideoStoryboardInputSchema } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import { storyboardSchema, type Storyboard } from '../src/agents/providers/youtube/storyboard';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import { RESEARCH_TOPIC_TOOL_NAMES } from '../src/agents/research/capabilities/research-topic';
import { INSPECT_VIDEO_TOOL_NAMES } from '../src/agents/research/capabilities/inspect-video';

const storyboard: Storyboard = {
  videoId: 'Ct-mtWqV3Ro', frameCount: 12, intervalMs: 5000,
  sheets: [{ imageBase64: '/9j/2Q==', tileWidth: 100, tileHeight: 100, columns: 2, rows: 1,
    firstFrameIndex: 10, frameCount: 2, intervalMs: 5000 }],
  meta: { partial: true, warnings: ['Limited sheets'] },
};
function model(frame = 11, modelId = '@cf/zai-org/glm-5.3-flash') {
  return new MockLanguageModelV4({ modelId, doGenerate: async (call) => {
    expect(call.prompt.some(message => message.role === 'user' && Array.isArray(message.content)
      && message.content.some(part => part.type === 'file' && part.mediaType === 'image/jpeg'))).toBe(true);
    return {
      content: [{ type: 'text', text: JSON.stringify({ findings: [{ observation: 'A diagram with two boxes is visible.', frameIndexes: [frame] }], warnings: [] }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
      warnings: [],
    };
  } });
}
function context(): AgentToolContext {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider call'); };
  return {
    runId: 'visual-test', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
    provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected, transcript: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected, storyboard: vi.fn(async () => ({ value: storyboard, cacheStatus: 'miss' } as const)) },
    analyzeStoryboard: createVisualAnalyst(model()),
    executeEvidenceTool: execution => execution.execute(),
    finalize: vi.fn(),
  };
}
describe('storyboard agent tool', () => {
  it('exposes metadata to the research model before downloading or analyzing images', async () => {
    const ctx = context();
    const manifest = { totalSheets: 6, framesPerSheet: 2, tileWidth: 100, tileHeight: 100,
      columns: 2, rows: 1, lastSampleMs: 55000 };
    ctx.provider.storyboard = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: {
      ...storyboard, selection: { mode: 'metadata' as const }, manifest, sheets: [], meta: { partial: false, warnings: [] },
    } }));
    ctx.analyzeStoryboard = vi.fn();
    const packet = await executeGetVideoStoryboard({ videoId: storyboard.videoId }, ctx, 'metadata');
    expect(ctx.provider.storyboard).toHaveBeenCalledWith(storyboard.videoId, undefined,
      { metadataOnly: true, maxSheets: 20, sheetIndexes: undefined });
    expect(ctx.analyzeStoryboard).not.toHaveBeenCalled();
    expect(packet.excerpts).toEqual([]);
    const { evidencePacketForModel } = await import('../src/agents/runtime/model-evidence');
    expect(evidencePacketForModel(packet).visualCoverage).toMatchObject({ manifest, sampledFrames: 0 });
    expect(JSON.stringify(packet)).not.toContain('/9j/');
  });
  it('passes the agent-selected sheets through scope and retains all coverage', async () => {
    const ctx = context();
    const sheets = [0, 2, 4, 6].map(firstFrameIndex => ({ ...storyboard.sheets[0]!, firstFrameIndex }));
    const upstream = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: {
      ...storyboard, sheets, selection: { mode: 'indexes' as const, requestedSheetIndexes: [0, 1, 2, 3] },
    } }));
    ctx.provider.storyboard = upstream;
    ctx.provider = createCapabilityProvider(ctx.provider, { route: 'inspect_video', videoId: storyboard.videoId });
    ctx.analyzeStoryboard = vi.fn(async () => ({ findings: [{ observation: 'Late chart', frameIndexes: [7] }], warnings: [] }));
    const packet = await executeGetVideoStoryboard({ videoId: storyboard.videoId, focus: 'Charts',
      sheetIndexes: [0, 1, 2, 3], maxSheets: 4 }, ctx, 'four');
    expect(upstream).toHaveBeenCalledWith(storyboard.videoId, undefined,
      { maxSheets: 4, sheetIndexes: [0, 1, 2, 3], metadataOnly: false });
    expect(ctx.analyzeStoryboard).toHaveBeenCalledWith(expect.objectContaining({ storyboard: expect.objectContaining({ sheets }) }));
    const { evidencePacketForModel } = await import('../src/agents/runtime/model-evidence');
    expect(evidencePacketForModel(packet).visualCoverage?.sampledRanges).toHaveLength(4);
    expect(packet.excerpts[0]?.startMs).toBe(35000);
  });
  it('requires a focus for images and rejects conflicting selectors', () => {
    expect(getVideoStoryboardInputSchema.safeParse({ videoId: storyboard.videoId, maxSheets: 4 }).success).toBe(false);
    expect(getVideoStoryboardInputSchema.safeParse({ videoId: storyboard.videoId, focus: 'Chart',
      sheetIndexes: [0], timestampsMs: [0] }).success).toBe(false);
  });
  it('passes targeted follow-ups through inspect scope and includes coverage in evidence', async () => {
    const ctx = context();
    const provider = ctx.provider;
    ctx.provider = createCapabilityProvider(provider, { route: 'inspect_video', videoId: storyboard.videoId });
    const keys: string[] = [];
    ctx.executeEvidenceTool = execution => { keys.push(execution.semanticKey); return execution.execute(); };
    await executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Diagram', timestampsMs: [50000] }, ctx, 'first');
    const result = await executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Diagram', timestampsMs: [55000] }, ctx, 'second');
    expect(provider.storyboard).toHaveBeenLastCalledWith(storyboard.videoId, [55000], { maxSheets: 2, sheetIndexes: undefined, metadataOnly: false });
    expect(keys[0]).not.toBe(keys[1]);
    expect(result.artifacts[0]!.data).toMatchObject({ sampledRanges: [{ startMs: 50000, endMs: 55000 }] });
  });
  it('rejects empty, fractional, negative and excessive targets at the native tool schema', () => {
    for (const timestampsMs of [[], [-1], [1.1], Array.from({ length: 21 }, (_, i) => i)]) {
      expect(getVideoStoryboardInputSchema.safeParse({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Chart', timestampsMs }).success).toBe(false);
    }
  });
  it('delivers images to the isolated model and produces timestamped evidence without image data', async () => {
    const result = await executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Describe the diagram' }, context(), 'call-1');
    expect(result.excerpts[0]).toMatchObject({ startMs: 55000, endMs: 55000, text: expect.stringContaining('two boxes') });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SAMPLED_VISUAL_EVIDENCE' })]));
    expect(JSON.stringify(result)).not.toContain('/9j/');
    expect(result.usage).toEqual([{ operation: 'storyboard', credits: 1, cacheStatus: 'miss' }]);
    const finalized = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID() },
      { userId: 'test', idempotencyKey: 'storyboard-test', creditsRemaining: 100 },
      { answer: `A diagram is visible [cite:${result.excerpts[0]!.id}]`, intent: 'inspect_video', confidence: 'low',
        citations: [], artifacts: [], warnings: [] }, [result], 1);
    expect(finalized.citations[0]).toMatchObject({ videoId: storyboard.videoId, startMs: 55000, endMs: 55000 });
  });
  it('rejects invented or unprovided frame references', async () => {
    const ctx = context(); ctx.analyzeStoryboard = createVisualAnalyst(model(0));
    await expect(executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Diagram' }, ctx, 'call')).rejects.toThrow();
  });
  it('constrains structured generation to the supplied source frame IDs', async () => {
    const analyze = createVisualAnalyst(new MockLanguageModelV4({ doGenerate: async call => {
      expect(call.responseFormat).toMatchObject({ type: 'json', schema: { properties: {
        findings: { items: { properties: { frameIndexes: { items: { enum: [10, 11] } } } } },
      } } });
      return model().doGenerate(call);
    } }));
    const result = await analyze({ storyboard, focus: 'Diagram', signal: new AbortController().signal, modelCallId: 'native-frames' });
    expect(result.findings[0]!.frameIndexes).toEqual([11]);
  });
  it('does not start analysis after provider failure', async () => {
    const ctx = context(); ctx.provider.storyboard = vi.fn(async () => { throw new Error('No storyboard'); });
    ctx.analyzeStoryboard = vi.fn();
    await expect(executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Diagram' }, ctx, 'call')).rejects.toThrow('No storyboard');
    expect(ctx.analyzeStoryboard).not.toHaveBeenCalled();
  });
  it('honors cancellation before fetching images', async () => {
    const ctx = context(); ctx.signal = AbortSignal.abort();
    await expect(executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Diagram' }, ctx, 'call')).rejects.toThrow();
    expect(ctx.provider.storyboard).not.toHaveBeenCalled();
  });
  it('enforces inspect video scope before fetching images', async () => {
    const ctx = context();
    const provider = createCapabilityProvider(ctx.provider, { route: 'inspect_video', videoId: storyboard.videoId });
    await expect(provider.storyboard!('abcdefghijk')).rejects.toThrow('pinned');
    expect(ctx.provider.storyboard).not.toHaveBeenCalled();
  });
  it('returns no invented evidence when the analyst finds nothing relevant', async () => {
    const ctx = context(); ctx.analyzeStoryboard = async () => ({ findings: [], warnings: ['No relevant visuals.'] });
    const result = await executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Find a chart' }, ctx, 'empty');
    expect(result.excerpts).toEqual([]);
  });
  it.each(['@cf/zai-org/glm-5.3-flash', 'accounts/fireworks/models/glm-5p3-flash'])('records usage using the visual model pricing and identity for %s', async modelId => {
    const recordUsage = vi.fn();
    await createVisualAnalyst(model(11, modelId), { limitMicros: 1000000, currentCostMicros: () => 0, recordUsage })({
      storyboard, focus: 'Diagram', signal: new AbortController().signal, modelCallId: 'visual-cost',
    });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ category: 'visual_analyst',
      modelId, pricing: expect.objectContaining({ uncachedInputUsdPerMillionTokens: 0.15, cachedInputUsdPerMillionTokens: 0.03, outputUsdPerMillionTokens: 0.5 }) }));
  });
  it('bounds a non-cooperative visual model to 20 seconds', async () => {
    vi.useFakeTimers();
    try {
      const analyze = createVisualAnalyst(new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) }));
      const pending = analyze({ storyboard, focus: 'Diagram', signal: new AbortController().signal, modelCallId: 'timeout' });
      const check = expect(pending).rejects.toThrow('20-second deadline');
      await vi.advanceTimersByTimeAsync(20_001);
      await check;
    } finally { vi.useRealTimers(); }
  });
  it('rejects malformed frame mappings', () => {
    expect(storyboardSchema.safeParse({ ...storyboard, frameCount: 1 }).success).toBe(false);
  });
  it('exposes storyboard in both paths and removes endscreen and trends', () => {
    for (const tools of [RESEARCH_TOPIC_TOOL_NAMES, INSPECT_VIDEO_TOOL_NAMES]) {
      expect(tools).toContain('get_video_storyboard');
      expect(tools).not.toContain('get_video_endscreen');
      expect(tools).not.toContain('research_youtube_trends');
    }
  });
});

describe('visual evidence presented to synthesis', () => {
  it('preserves late distinct findings when earlier findings have repeated frame citations', async () => {
    const { evidencePacketForModel, finalizationEvidenceForModel } = await import('../src/agents/runtime/model-evidence');
    const ctx = context();
    const sheet = storyboard.sheets[0]!;
    ctx.provider.storyboard = async () => ({ cacheStatus: 'miss', value: { ...storyboard, frameCount: 102,
      selection: { mode: 'spread' }, sheets: [
        { ...sheet, firstFrameIndex: 0, frameCount: 25, columns: 5, rows: 5 },
        { ...sheet, firstFrameIndex: 100, frameCount: 2, columns: 5, rows: 5 },
      ] } });
    ctx.analyzeStoryboard = async () => ({ findings: [
      { observation: 'Early editor.', frameIndexes: [0, 1, 2] },
      { observation: 'Large presenter.', frameIndexes: [6, 7, 8] },
      { observation: 'Another layout.', frameIndexes: [9, 10, 11] },
      { observation: 'Final screen.', frameIndexes: [100, 101] },
    ], warnings: [] });
    const packet = await executeGetVideoStoryboard({ videoId: storyboard.videoId, maxSheets: 2, focus: 'Overview' }, ctx, 'overview');
    const projected = evidencePacketForModel(packet);
    expect(projected.excerpts).toHaveLength(8);
    expect(projected.excerpts!.slice(0, 4).map(e => e.startMs)).toEqual([0, 30000, 45000, 500000]);
    expect(projected.visualCoverage).toMatchObject({ selection: { mode: 'spread' },
      sampledRanges: [{ startMs: 0, endMs: 120000 }, { startMs: 500000, endMs: 505000 }] });
    const finalizer = finalizationEvidenceForModel([packet], 20000);
    const late = finalizer.evidence[0]!.excerpts!.find(e => e.text.includes('Final screen'))!;
    expect(finalizer.fullIds.get(late.id)).toBe(packet.excerpts.find(e => e.text.includes('Final screen'))!.id);
    const reduced = finalizationEvidenceForModel([packet], JSON.stringify([projected]).length - 1);
    expect(reduced.evidence[0]!.excerpts!.some(e => e.text.includes('Final screen'))).toBe(true);
  });
});
