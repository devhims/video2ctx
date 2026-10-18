import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';

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
