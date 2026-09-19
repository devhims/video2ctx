import { attachTestAssetStore } from './fixtures/analysis-session';
import { MockLanguageModelV4 } from 'ai/test';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { EvidencePacket } from '../src/agents/contracts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const videoId = 'abcdefghijk';
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
const metadata: EvidencePacket = { packetId: 'metadata', kind: 'youtube_video',
  sources: [{ id: 'video', provider: 'youtube', kind: 'video', videoId, title: 'Cricket match' }],
  excerpts: [{ id: 'metadata-excerpt', sourceId: 'video', text: 'Cricket match metadata only.' }], artifacts: [], warnings: [], usage: [] };

function setup(delayMs: number) {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider operation'); };
  const analyzed = vi.fn(async () => ({ findings: [{ observation: 'The shirt reads SMRITI.', timestampsMs: [28000] }], warnings: [] }));
  const context: AgentToolContext = {
    runId: 'frame-deadline-run', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
    provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected,
      transcript: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected,
      channelPlaylists: unexpected, playlist: unexpected,
      frames: vi.fn(async (_request, signal) => {
        await new Promise<void>((resolve, reject) => {
          setTimeout(resolve, delayMs);
          // Model a slow cancellation acknowledgement from an upstream request.
          signal?.addEventListener('abort', () => { setTimeout(() => reject(signal.reason), 50); }, { once: true });
        });
        return { cacheStatus: 'miss' as const, value: { videoId, frames: [{ timestampMs: 28000,
          mimeType: 'image/jpeg' as const, width: 1920, height: 1080, imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } } };
      }),
    },
    analyzeFrames: analyzed, executeEvidenceTool: execution => execution.execute(),
    finalize: vi.fn(async (_id, input) => ({ ...input, runId: 'frame-deadline-run', conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), billing: { creditsCharged: 0, creditsRemaining: 100 } })),
  };
  attachTestAssetStore(context);
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: `step-${step}`, toolName: ['get_video_frames','analyze_video_frames','finalize_answer'][Math.min(step,2)]!,
      input: step++ === 0 ? JSON.stringify({videoId,timestampsMs:[28000]}) : step === 2
        ? JSON.stringify({assetVersions:['1'.padStart(64,'0')],focus:'Read names printed on shirts.'})
        : JSON.stringify({intent:'inspect_video',confidence:'medium',artifacts:[],warnings:[],blocks:[{text:'The shirt reads SMRITI.',evidenceIds:['ref_1']}]}) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
  }) });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({
    confidence: 'low', warnings: [], blocks: [{ text: 'The available evidence is limited.', evidenceIds: ['ref_1'] }],
  }) }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }) });
  const options = { model, finalizationModel: finalizer, context, message: 'Look at frames to confirm player names.',
    decision: { route: 'inspect_video' as const, videoId, useStoryboard: true },
    toolNames: ['get_video_frames', 'analyze_video_frames', 'finalize_answer'] as const };
  return { options, context, analyzed, finalizer };
}

test('allows a frame retrieval within the service limit to finish before visual finalization', async () => {
  const { options, context, analyzed, finalizer } = setup(45_000);
  const run = runResearchAgentWithModel(options).then(value => value, error => error);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(finalizer.doGenerateCalls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5_000);
  await run;
  expect(analyzed).toHaveBeenCalledOnce();
  expect(context.finalize).toHaveBeenCalledOnce();
  expect(JSON.stringify(finalizer.doGenerateCalls.at(-1)?.prompt)).toContain('The shirt reads SMRITI.');
});

test('reports an interrupted frame call to the finalizer before cancellation acknowledgement', async () => {
  const { options, context, finalizer } = setup(60_000);
  const run = runResearchAgentWithModel({ ...options, researchDeadlineAt: Date.now() + 40_000,
    recoveredEvidence: [metadata], recoveredToolFailures: [{ toolCallId: 'storyboard', toolName: 'get_video_storyboard',
      operation: 'storyboard', message: 'No storyboard is available for this video.' }] });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(context.provider.frames).toHaveBeenCalledOnce();
  await run;
  const prompt = JSON.stringify(finalizer.doGenerateCalls.at(-1)?.prompt);
  expect(prompt).toContain('get_video_frames');
  expect(prompt).toContain('Research phase timeout');
  expect(context.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ warnings:
    expect.arrayContaining([expect.objectContaining({ code: 'EVIDENCE_TOOL_FAILED', message: expect.stringContaining('get_video_frames') })]) }));
  await vi.advanceTimersByTimeAsync(50);
});

test('removes frame extraction from the next model step when only completion time remains', async () => {
  const { options, context } = setup(30_000);
  const run = runResearchAgentWithModel({ ...options, researchDeadlineAt: Date.now() + 60_000 });
  await vi.advanceTimersByTimeAsync(30_000);
  await run;
  expect(context.provider.frames).toHaveBeenCalledOnce();
  const nextTools = options.model.doGenerateCalls[1]?.tools?.map(tool => tool.name);
  expect(nextTools).toContain('finalize_answer');
  expect(nextTools).not.toContain('get_video_frames');
});
