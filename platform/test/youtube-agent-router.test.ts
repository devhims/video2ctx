import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  agentCoreReasoningEffort,
  runResearchAgentWithModel,
} from '../src/agents/research/research-agent';
import { INSPECT_VIDEO_TOOL_NAMES } from '../src/agents/research/capabilities/inspect-video';
import {
  classifyCapabilityWithModel,
  extractYouTubeVideoIds,
  finalIntentMatchesRoute,
  resolveCapabilityRoute,
} from '../src/agents/research/capability-router';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import type { ConversationTurn } from '../src/agents/runtime/conversation-memory';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';

describe('YouTube agent capability router', () => {
  it('uses medium reasoning for research and low reasoning for bounded inspection', () => {
    expect(agentCoreReasoningEffort('topic_research')).toBe('medium');
    expect(agentCoreReasoningEffort('inspect_video')).toBe('low');
  });

  it('extracts and deduplicates supported YouTube video references', () => {
    expect(extractYouTubeVideoIds([
      'Inspect https://youtu.be/abcdefghijk,',
      'then compare HTTPS://www.youtube.com/watch?v=lmnopqrstuv.',
      'The first link also appears as https://youtube.com/shorts/abcdefghijk.',
    ].join(' '))).toEqual(['abcdefghijk', 'lmnopqrstuv']);

    expect(extractYouTubeVideoIds('video ID: ABCDEFG1234')).toEqual(['ABCDEFG1234']);
  });

  it('routes a request pinned to one supplied video into inspect_video', async () => {
    const decision = await classifyCapabilityWithModel({
      message: 'Summarize https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk' }),
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk' });
  });

  it('routes discovery and comparison requests into topic_research', async () => {
    const decision = await classifyCapabilityWithModel({
      message: 'Compare current YouTube advice about audience retention.',
      model: classifierModel({ route: 'topic_research' }),
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'topic_research' });
  });

  it('does not accept an inspect_video ID invented by the classifier', async () => {
    const decision = await classifyCapabilityWithModel({
      message: 'Inspect this video for me.',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk' }),
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({
      route: 'clarification',
      question: 'Which YouTube video would you like me to inspect? Please provide its URL or video ID.',
    });
  });

  it('uses completed conversation memory to resolve a follow-up video reference', async () => {
    const model = classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk' });
    const decision = await classifyCapabilityWithModel({
      message: 'Inspect that one in more detail.',
      conversationHistory: [conversationTurn({
        user: 'Find a useful example.',
        assistant: 'The strongest example is the first result.',
        resourceIds: ['abcdefghijk'],
      })],
      model,
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk' });
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('Find a useful example.');
    expect(prompt).toContain('Inspect that one in more detail.');
    expect(prompt).toContain('abcdefghijk');
  });

  it('reuses a persisted decision during recovery without classifying again', async () => {
    const classify = vi.fn(async () => ({ route: 'topic_research' as const }));
    const persist = vi.fn();

    const decision = await resolveCapabilityRoute({
      persisted: { route: 'inspect_video', videoId: 'abcdefghijk' },
      classify,
      persist,
    });

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk' });
    expect(classify).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists a newly classified decision exactly once', async () => {
    const persist = vi.fn();
    const decision = await resolveCapabilityRoute({
      classify: async () => ({ route: 'topic_research' }),
      persist,
    });

    expect(decision).toEqual({ route: 'topic_research' });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(decision);
  });

  it('allows clarification but rejects a mismatched executable intent', () => {
    const decision = { route: 'inspect_video', videoId: 'abcdefghijk' } as const;
    expect(finalIntentMatchesRoute(decision, 'inspect_video')).toBe(true);
    expect(finalIntentMatchesRoute(decision, 'clarification')).toBe(true);
    expect(finalIntentMatchesRoute(decision, 'topic_research')).toBe(false);
  });

  it('pins inspect_video provider calls to the classified video', async () => {
    const video = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: {} as never }));
    const provider = createCapabilityProvider(providerWith({ video }), {
      route: 'inspect_video',
      videoId: 'abcdefghijk',
    });

    await provider.video('abcdefghijk');
    expect(video).toHaveBeenCalledOnce();
    await expect(provider.video('lmnopqrstuv')).rejects.toThrow(/pinned to video abcdefghijk/);
    expect(video).toHaveBeenCalledOnce();
  });

  it('constructs the main loop with only the classified capability tools', async () => {
    const model = finalizingModel();
    const context = inspectContext();
    const loop = await runResearchAgentWithModel({
      model,
      message: 'Summarize https://youtu.be/abcdefghijk',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk' },
      context,
      conversationHistory: [conversationTurn({
        user: 'Start with this video.',
        assistant: 'I inspected its main argument.',
        resourceIds: ['abcdefghijk'],
      })],
    });

    const toolNames = model.doGenerateCalls[0]?.tools?.map((candidate) => candidate.name);
    expect(toolNames).toEqual([...INSPECT_VIDEO_TOOL_NAMES]);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Pinned video ID: abcdefghijk');
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Start with this video.');
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('I inspected its main argument.');
    expect(context.finalize).toHaveBeenCalledOnce();
    expect(loop.stepCount).toBe(1);
  });
});

function classifierModel(output: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function conversationTurn(overrides: Pick<ConversationTurn, 'user' | 'assistant' | 'resourceIds'>): ConversationTurn {
  return {
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    ...overrides,
  };
}

function finalizingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{
        type: 'tool-call',
        toolCallId: 'finalize-inspect',
        toolName: 'finalize_answer',
        input: JSON.stringify({
          answer: 'Please clarify the requested aspect of the video.',
          intent: 'clarification',
          confidence: 'low',
          citations: [],
          artifacts: [],
          warnings: [],
        }),
      }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function inspectContext(): AgentToolContext {
  const runId = crypto.randomUUID();
  return {
    runId,
    provider: providerWith({}),
    transcriptPolicy: { mode: 'complete_transcript' },
    signal: new AbortController().signal,
    executeEvidenceTool: (execution) => execution.execute(),
    finalize: vi.fn(async () => ({
      runId,
      conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      answer: 'Please clarify the requested aspect of the video.',
      intent: 'clarification' as const,
      confidence: 'low' as const,
      citations: [],
      artifacts: [],
      warnings: [],
      billing: { creditsCharged: 0, creditsRemaining: 100 },
    })),
  };
}

function providerWith(overrides: Partial<YouTubeAgentProvider>): YouTubeAgentProvider {
  const unexpected = async () => { throw new Error('Unexpected provider call.'); };
  return {
    search: unexpected,
    browse: unexpected,
    trends: unexpected,
    video: unexpected,
    tracks: unexpected,
    transcript: unexpected,
    comments: unexpected,
    endscreen: unexpected,
    channel: unexpected,
    channelVideos: unexpected,
    channelPlaylists: unexpected,
    playlist: unexpected,
    ...overrides,
  } as YouTubeAgentProvider;
}
