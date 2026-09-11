import { MockLanguageModelV4 } from 'ai/test';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { executeGetVideoFrames } from '../src/agents/providers/youtube/tools/get-video-frames';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import { evidencePacketForModel } from '../src/agents/runtime/model-evidence';

const frames = { videoId: 'abcdefghijk', frames: [{ timestampMs: 1234, mimeType: 'image/jpeg' as const,
  width: 1920, height: 1080, imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } };
function context(): AgentToolContext {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected call'); };
  return {
    runId: 'frame-test', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
    provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected,
      transcript: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected,
      channelPlaylists: unexpected, playlist: unexpected, frames: vi.fn(async () => ({ value: frames, cacheStatus: 'miss' as const })) },
    executeEvidenceTool: execution => execution.execute(), finalize: vi.fn(),
    analyzeFrames: createFrameAnalyst(new MockLanguageModelV4({ doGenerate: async call => {
      expect(call.prompt.some(message => message.role === 'user' && Array.isArray(message.content)
        && message.content.some(part => part.type === 'file' && part.mediaType === 'image/jpeg'))).toBe(true);
      return { content: [{ type: 'text', text: JSON.stringify({ findings: [{ observation: 'The chart reads 42.', timestampsMs: [1234] }], warnings: [] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } };
    } })),
  };
}
const input = { videoId: frames.videoId, timestampsMs: [1234], focus: 'Read the chart' };
describe('agent frame tool', () => {
  test('delivers JPEGs to vision and returns timestamped evidence without image bytes', async () => {
    const result = await executeGetVideoFrames(input, context(), 'call-1');
    expect(result.excerpts[0]).toMatchObject({ startMs: 1234, endMs: 1234, text: expect.stringContaining('42') });
    expect(JSON.stringify(result)).not.toContain('/9j/');
    expect(result.usage).toEqual([{ operation: 'frames', credits: 2, cacheStatus: 'miss' }]);
    expect(evidencePacketForModel(result).frameCoverage).toMatchObject({
      requestedTimestampsMs: [1234], frames: [{ timestampMs: 1234, width: 1920, height: 1080 }], failures: [],
    });
  });
  test('rejects invented visual timestamps', async () => {
    const ctx = context();
    ctx.analyzeFrames = async () => ({ findings: [{ observation: 'Fake', timestampsMs: [5000] }], warnings: [] });
    await expect(executeGetVideoFrames(input, ctx, 'call')).rejects.toThrow('unavailable frame');
  });
  test('enforces pinned-video and disabled-visual capabilities', async () => {
    const ctx = context();
    const scoped = createCapabilityProvider(ctx.provider, { route: 'inspect_video', videoId: frames.videoId });
    await expect(scoped.frames!({ ...input, videoId: 'zyxwvutsrqp' })).rejects.toThrow('pinned');
    const disabled = createCapabilityProvider(ctx.provider, { route: 'inspect_video', videoId: frames.videoId, useStoryboard: false });
    await expect(disabled.frames!(input)).rejects.toThrow('unavailable');
    expect(ctx.provider.frames).not.toHaveBeenCalled();
  });
  test('normalizes repeated timestamp selections for durable reuse', async () => {
    const ctx = context();
    const keys: string[] = [];
    ctx.executeEvidenceTool = execution => { keys.push(execution.semanticKey); return execution.execute(); };
    await executeGetVideoFrames({ ...input, timestampsMs: [1234, 1234] }, ctx, 'a');
    await executeGetVideoFrames(input, ctx, 'b');
    expect(keys[0]).toBe(keys[1]);
  });
});
