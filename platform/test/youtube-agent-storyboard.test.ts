import { buildAgentTurnResult } from '../src/agents/finalizer';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
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
function model(frame = 11) {
  return new MockLanguageModelV4({ doGenerate: async (call) => {
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
  it('delivers images to the isolated model and produces timestamped evidence without image data', async () => {
    const result = await executeGetVideoStoryboard({ videoId: storyboard.videoId, focus: 'Describe the diagram' }, context(), 'call-1');
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
    await expect(executeGetVideoStoryboard({ videoId: storyboard.videoId, focus: 'Diagram' }, ctx, 'call')).rejects.toThrow('unavailable frame');
  });
  it('does not start analysis after provider failure', async () => {
    const ctx = context(); ctx.provider.storyboard = vi.fn(async () => { throw new Error('No storyboard'); });
    ctx.analyzeStoryboard = vi.fn();
    await expect(executeGetVideoStoryboard({ videoId: storyboard.videoId, focus: 'Diagram' }, ctx, 'call')).rejects.toThrow('No storyboard');
    expect(ctx.analyzeStoryboard).not.toHaveBeenCalled();
  });
  it('honors cancellation before fetching images', async () => {
    const ctx = context(); ctx.signal = AbortSignal.abort();
    await expect(executeGetVideoStoryboard({ videoId: storyboard.videoId, focus: 'Diagram' }, ctx, 'call')).rejects.toThrow();
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
    const result = await executeGetVideoStoryboard({ videoId: storyboard.videoId, focus: 'Find a chart' }, ctx, 'empty');
    expect(result.excerpts).toEqual([]);
  });
  it('records usage using the visual model pricing and identity', async () => {
    const recordUsage = vi.fn();
    await createVisualAnalyst(model(), { limitMicros: 1000000, currentCostMicros: () => 0, recordUsage })({
      storyboard, focus: 'Diagram', signal: new AbortController().signal, modelCallId: 'visual-cost',
    });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ category: 'visual_analyst',
      modelId: '@cf/zai-org/glm-5.3-flash', pricing: expect.objectContaining({ uncachedInputUsdPerMillionTokens: 0.15, cachedInputUsdPerMillionTokens: 0.03, outputUsdPerMillionTokens: 0.5 }) }));
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
