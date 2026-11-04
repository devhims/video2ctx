import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { EvidencePacket } from '../src/agents/contracts';
import { AGENT_MAX_TOOL_CALLS } from '../src/agents/runtime/billing';
import type { AgentToolContext, EvidenceToolExecution } from '../src/agents/providers/youtube/tool-context';

const calls = vi.hoisted(() => ({ run: undefined as undefined | ((context: AgentToolContext) => Promise<unknown>) }));
// Drive the real research runtime's analyst callbacks through one model tool step.
vi.mock('../src/agents/providers/youtube/tool-library', () => ({ createCapabilityToolSet: (context: AgentToolContext) => ({
  research_video_transcripts: tool({ inputSchema: z.object({}), execute: () => calls.run!(context) }),
  finalize_answer: tool({ inputSchema: z.object({}), execute: () => context.finalize('final', {
    intent: 'topic_research', confidence: 'medium', answer: 'Completed.', citations: [], artifacts: [], warnings: [],
  }) }),
}) }));
const videoId = 'B2QtJKMlYTo';
const description = 'The BBC’s South Asia correspondent, Azadeh Moshiri, explains.\n0:51 Introduction to Azadeh Moshiri';

it.each(['missing', 'failed', 'saved'] as const)('supplies video context to all analysts with %s metadata', async mode => {
  const fails = mode === 'failed';
  const video = vi.fn(async () => {
    if (fails) throw new Error('Metadata unavailable');
    return { cacheStatus: 'hit', value: { id: videoId, title: 'BBC interview', description,
      channel: { id: 'bbc', name: 'BBC News' }, url: `https://www.youtube.com/watch?v=${videoId}`,
      keywords: [], availability: { status: 'OK' },
      meta: { source: 'allthingsyoutube', partial: false, warnings: [], fetchedAt: new Date().toISOString() } } };
  });
  const transcript = vi.fn(async (_input: unknown) => ({ findings: [], warnings: [] }));
  const frames = vi.fn(async (_input: unknown) => ({ findings: [], warnings: [] }));
  const storyboard = vi.fn(async (_input: unknown) => ({ findings: [], warnings: [] }));
  const controller = new AbortController();
  const context = { runId: 'analysis-context', signal: controller.signal, provider: { video },
    transcriptPolicy: { mode: 'contextual_analysis', researchQuestion: 'Who is speaking?', analyze: transcript },
    analyzeFrames: frames, analyzeStoryboard: storyboard,
    executeEvidenceTool: (execution: { execute: () => Promise<unknown> }) => execution.execute(),
    finalize: vi.fn(async () => ({})),
  } as unknown as AgentToolContext;
  calls.run = async ctx => {
    if (ctx.transcriptPolicy.mode !== 'contextual_analysis') throw new Error('Transcript analyst missing');
    const common = { signal: controller.signal, modelCallId: 'test', focus: 'Identify the speaker' };
    return Promise.all([
      ctx.transcriptPolicy.analyze({ ...common, videoId, researchQuestion: 'Who is speaking?', segments: [], sourceContext: { language: 'en', provenance: 'asr' } }),
      ctx.analyzeFrames!({ ...common, frames: { videoId } } as Parameters<NonNullable<AgentToolContext['analyzeFrames']>>[0]),
      ctx.analyzeStoryboard!({ ...common, storyboard: { videoId } } as Parameters<NonNullable<AgentToolContext['analyzeStoryboard']>>[0]),
    ]);
  };
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: `step:${step}`, toolName: step++ === 0 ? 'research_video_transcripts' : 'finalize_answer', input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, warnings: [],
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
  }) });
  await runResearchAgentWithModel({ model, message: 'Who is the presenter?', decision: {
    route: 'topic_research', researchBreadth: 'focused', useStoryboard: true, visualEvidence: 'helpful',
  }, context, recoveredEvidence: mode === 'saved' ? [{ packetId: 'saved-metadata', kind: 'youtube_video',
    sources: [{ id: 'source', kind: 'video', provider: 'youtube', videoId, title: 'BBC interview' }],
    excerpts: [], artifacts: [{ type: 'youtube_video_metadata', data: { id: videoId, description, channel: { name: 'BBC News' } } }],
    warnings: [], usage: [],
  }] : [] });
  expect(video).toHaveBeenCalledTimes(mode === 'saved' ? 0 : 1);
  for (const analyst of [transcript, frames, storyboard]) {
    expect(analyst).toHaveBeenCalledOnce();
    expect(analyst.mock.calls[0]![0]).toMatchObject({ sourceContext: fails ? {} : { title: 'BBC interview', channel: 'BBC News', description } });
  }
  expect(transcript.mock.calls[0]![0]).toMatchObject({ sourceContext: { language: 'en', provenance: 'asr' } });
  expect(frames.mock.calls[0]![0]).toMatchObject({ researchQuestion: 'Who is the presenter?' });
  expect(storyboard.mock.calls[0]![0]).toMatchObject({ researchQuestion: 'Who is the presenter?' });
});


it.each([false, true])('preserves eight transcript retrievals across sequential batches when metadata fails=%s', async metadataFails => {
  const controller = new AbortController();
  const videos = Array.from({ length: 8 }, (_, index) => `video00000${index}`);
  const transcript = vi.fn(async (_videoId: string) => ({ cacheStatus: 'hit' as const, value: {
    segments: [{ text: 'A supported transcript.', startMs: 0, endMs: 1000, durationMs: 1000 }],
    meta: { partial: false, warnings: [] },
  } }));
  const video = vi.fn(async (id: string) => {
    if (metadataFails) throw new Error('Metadata unavailable');
    return { cacheStatus: 'hit' as const, value: { id, title: 'An interview', description,
      channel: { id: 'bbc', name: 'BBC News' }, url: `https://www.youtube.com/watch?v=${id}`,
      keywords: [], availability: { status: 'OK' },
      meta: { source: 'allthingsyoutube', partial: false, warnings: [], fetchedAt: new Date().toISOString() } } };
  });
  const analyze = vi.fn(async (_input: unknown) => ({ findings: [], warnings: [] }));
  const providerRows: EvidenceToolExecution[] = [];
  // Match the durable admission gate: reserve a row before work, including failures.
  const executeEvidenceTool = async (execution: EvidenceToolExecution) => {
    if (!execution.toolName.startsWith('analyze_')) {
      if (providerRows.length + (execution.reserveProviderCalls ?? 0) >= AGENT_MAX_TOOL_CALLS - 1)
        throw new Error('AGENT_TOOL_BUDGET_EXCEEDED');
      providerRows.push(execution);
    }
    return execution.execute();
  };
  const context = { runId: 'sequential-analysis-context', signal: controller.signal,
    provider: { video, transcript }, executeEvidenceTool,
    transcriptPolicy: { mode: 'contextual_analysis', researchQuestion: 'Compare the interviews', analyze },
    finalize: vi.fn(async () => ({})),
  } as unknown as AgentToolContext;
  const batchResults: number[] = [];
  calls.run = async ctx => {
    // A preceding search consumes one provider row, just like normal topic research.
    await ctx.executeEvidenceTool({ toolCallId: 'search', toolName: 'search_youtube', operation: 'search',
      semanticKey: 'search', input: {}, execute: async () => ({ packetId: 'search', kind: 'youtube_search',
        sources: [], excerpts: [], artifacts: [], warnings: [], usage: [] } as EvidencePacket) });
    for (const batch of [videos.slice(0, 4), videos.slice(4)]) {
      const results = await Promise.allSettled(batch.map(async id => {
        await executeGetVideoTranscript({ videoId: id }, ctx, `transcript:${id}`);
        if (ctx.transcriptPolicy.mode !== 'contextual_analysis') throw new Error('Analyst missing');
        await ctx.transcriptPolicy.analyze({ videoId: id, researchQuestion: 'Compare the interviews',
          focus: 'Speaker background', segments: [], signal: controller.signal });
      }));
      batchResults.push(results.filter(result => result.status === 'fulfilled').length);
    }
    return { batchResults };
  };
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: `step:${step}`, toolName: step++ === 0 ? 'research_video_transcripts' : 'finalize_answer', input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, warnings: [],
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
  }) });
  await runResearchAgentWithModel({ model, context, message: 'Compare eight interviews', decision: {
    route: 'topic_research', researchBreadth: 'comparative', researchVideoCount: 8, visualEvidence: 'none', useStoryboard: false,
  } });
  expect(batchResults).toEqual([4, 4]);
  expect(transcript).toHaveBeenCalledTimes(8);
  expect(analyze).toHaveBeenCalledTimes(8);
  expect(video).toHaveBeenCalledTimes(2);
  expect(providerRows).toHaveLength(11);
});

it.each(['required', 'helpful'] as const)('keeps provider calls for exact frames only when images are %s', async visualEvidence => {
  const controller = new AbortController();
  const video = vi.fn(async () => ({ cacheStatus: 'hit', value: { id: videoId, title: 'BBC interview', description,
    channel: { id: 'bbc', name: 'BBC News' }, url: `https://www.youtube.com/watch?v=${videoId}`, keywords: [], availability: { status: 'OK' },
    meta: { source: 'allthingsyoutube', partial: false, warnings: [], fetchedAt: new Date().toISOString() } } }));
  const executions: EvidenceToolExecution[] = [];
  const packet = (id: string, observed = false): EvidencePacket => ({ packetId: id, kind: observed ? 'youtube_frames' : 'youtube_transcript',
    sources: [{ id: `youtube:${videoId}:frames`, provider: 'youtube', kind: 'frames', videoId }],
    excerpts: observed ? [{ id: `${id}:0`, sourceId: `youtube:${videoId}:frames`, text: 'Visual observation.', startMs: 1000, endMs: 1000 }] : [],
    artifacts: observed ? [{ type: 'youtube_frame_analysis', data: {} }] : [], warnings: [], usage: [] });
  const context = { runId: `frame-reserve-${visualEvidence}`, signal: controller.signal, provider: { video, frames: vi.fn() },
    transcriptPolicy: { mode: 'contextual_analysis', researchQuestion: 'Compare the camera angles', analyze: vi.fn() },
    analyzeFrames: vi.fn(async () => ({ findings: [], warnings: [] })),
    executeEvidenceTool: async (execution: EvidenceToolExecution) => { executions.push(execution); return execution.execute(); },
    finalize: vi.fn(async () => ({})),
  } as unknown as AgentToolContext;
  calls.run = async ctx => {
    const run = (toolName: EvidenceToolExecution['toolName'], observed = false) => ctx.executeEvidenceTool({ toolCallId: toolName,
      toolName, operation: 'transcript', semanticKey: toolName, input: {}, execute: async () => packet(toolName, observed) });
    await run('get_video_transcript');
    await run('get_video_storyboard');
    await run('get_video_frames', true);
    // An analyst's automatic metadata lookup keeps the frame reserve instead of a transcript reserve.
    await ctx.analyzeFrames!({ signal: controller.signal, modelCallId: 'test', focus: 'Camera angle', frames: { videoId } } as Parameters<NonNullable<AgentToolContext['analyzeFrames']>>[0]);
    return {};
  };
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: `step:${step}`, toolName: step++ === 0 ? 'research_video_transcripts' : 'finalize_answer', input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, warnings: [],
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
  }) });
  await runResearchAgentWithModel({ model, message: 'Compare the camera angles', context, decision: {
    route: 'topic_research', researchBreadth: 'comparative', researchVideoCount: 4, useStoryboard: true, visualEvidence,
    ...(visualEvidence === 'required' ? { visualRequirements: ['camera angle'] } : {}),
  } });
  const reserve = visualEvidence === 'required' ? 2 : undefined;
  expect(executions.map(execution => [execution.toolName, execution.frameReserveCalls])).toEqual([
    ['get_video_transcript', reserve], ['get_video_storyboard', reserve], ['get_video_frames', reserve], ['get_video', reserve]]);
  expect(executions.find(execution => execution.toolName === 'get_video')!.reserveProviderCalls).toBe(visualEvidence === 'required' ? 0 : 4);
});
