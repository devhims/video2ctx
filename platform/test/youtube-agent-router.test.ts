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
  extractYouTubeChannelIds,
  finalIntentMatchesRoute,
  resolveCapabilityRoute,
} from '../src/agents/research/capability-router';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import type { ConversationTurn } from '../src/agents/runtime/conversation-memory';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';

describe('YouTube agent capability router', () => {
  it.each([1, 3, 6, 8])('persists an explicit research count of %s independently of breadth', async researchVideoCount => {
    const decision = await classifyCapabilityWithModel({ message: 'Compare model coding workflows',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'coding workflows', researchVideoCount }),
      signal: new AbortController().signal });
    const { researchVideoTarget } = await import('../src/agents/research/research-plan');
    expect(researchVideoTarget(decision)).toBe(researchVideoCount);
    expect(await resolveCapabilityRoute({ persisted: decision, classify: vi.fn(), persist: vi.fn() })).toEqual(decision);
  });
  it('requires a count for newly classified executable routes', async () => {
    await expect(classifyCapabilityWithModel({ message: 'Compare models',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'models', researchVideoCount: undefined }),
      signal: new AbortController().signal })).rejects.toThrow('researchVideoCount');
  });
  it('preserves an explicit source requirement above capacity separately from the research target', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Compare findings from ten videos',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'models', researchVideoCount: 8, requiredVideoCount: 10 }),
      signal: new AbortController().signal });
    expect(decision).toMatchObject({ researchVideoCount: 8, requiredVideoCount: 10 });
  });
  it('retains the explicitly classified numbered-list requirement', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Research exactly ten use cases. Number all ten.',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'use cases', numberedItemCount: 10 }),
      signal: new AbortController().signal });
    expect(decision).toMatchObject({ numberedItemCount: 10 });
  });
  it('retains supplied channel scope even when the model omits it', async () => {
    const decision = await classifyCapabilityWithModel({
      message: 'Find protein lab tests on https://youtube.com/@Trustified-Certification/videos',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'protein lab tests' }),
      signal: new AbortController().signal,
    });
    expect(decision).toMatchObject({ channelId: '@Trustified-Certification' });
    expect(extractYouTubeChannelIds('https://youtube.com.evil.test/@fake https://evilyoutube.com/@fake https://evil.youtube.com/@fake https://evil.test/youtube.com/@fake https://youtu.be/abcdefghijk')).toEqual([]);
  });

  it('does not accept an invented channel identifier from classification', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Research video lighting',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'video lighting', channelId: '@invented' }),
      signal: new AbortController().signal });
    expect(decision.route).toBe('clarification');
  });
  it('uses low reasoning for bounded research planning and inspection', () => {
    expect(agentCoreReasoningEffort('topic_research')).toBe('low');
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

  it.each(['standard', 'detailed'] as const)('persists the native answer budget choice %s', async answerDetail => {
    const model = classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', answerDetail });
    const decision = await classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk', model,
      signal: new AbortController().signal });
    expect(decision).toMatchObject({ answerDetail });
    expect(model.doGenerateCalls[0]?.tools?.find(t => t.type === 'function')?.inputSchema).toMatchObject({
      required: expect.arrayContaining(['answerDetail', 'researchVideoCount']),
      properties: { answerDetail: { enum: ['standard', 'detailed'] } },
    });
    expect(await resolveCapabilityRoute({ persisted: decision, classify: vi.fn(), persist: vi.fn() })).toEqual(decision);
  });

  it('rejects a new classification without an output-budget choice', async () => {
    await expect(classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', answerDetail: undefined }),
      signal: new AbortController().signal })).rejects.toThrow();
  });

  it('routes a request pinned to one supplied video into inspect_video', async () => {
    const decision = await classifyCapabilityWithModel({
      message: 'Summarize https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk' }),
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, useStoryboard: false, answerDetail: 'standard' });
  });

  it('routes discovery and comparison requests into topic_research', async () => {
    const model = classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'audience retention comparison' });
    const decision = await classifyCapabilityWithModel({
      message: 'Compare current YouTube advice about audience retention.',
      model,
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'audience retention comparison', researchVideoCount: 3, useStoryboard: false, answerDetail: 'standard' });
    expect(model.doGenerateCalls[0]?.tools?.find(tool => tool.type === 'function')?.inputSchema).toMatchObject({ type: 'object', properties: expect.objectContaining({ route: expect.any(Object), searchQuery: expect.any(Object) }) });
  });

  it.each(['focused', 'comparative'] as const)('persists classifier research breadth %s', async (researchBreadth) => {
    const decision = await classifyCapabilityWithModel({
      message: 'Research the best design skills for frontend developers using Claude Code',
      model: classifierModel({ route: 'topic_research', researchBreadth, searchQuery: 'frontend design skills' }),
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ route: 'topic_research', researchBreadth, searchQuery: 'frontend design skills', researchVideoCount: 3, useStoryboard: false, answerDetail: 'standard' });
  });

  it('rejects a new research decision that omits breadth instead of silently reviewing two videos', async () => {
    await expect(classifyCapabilityWithModel({
      message: 'Compare frontend design skills',
      model: classifierModel({ route: 'topic_research' }),
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  it('requires a search query in new research classifications', async () => {
    await expect(classifyCapabilityWithModel({
      message: 'Suggest use cases',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative' }),
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  it.each(['topic_research', 'inspect_video'] as const)('requires an explicit storyboard choice for new %s routes', async route => {
    await expect(classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route, videoId: 'abcdefghijk', researchBreadth: 'focused', searchQuery: 'YouTube', useStoryboard: undefined }),
      signal: new AbortController().signal,
    })).rejects.toThrow(/useStoryboard/);
  });

  it.each([true, false])('persists the classifier storyboard choice %s', async useStoryboard => {
    const decision = await classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard }),
      signal: new AbortController().signal,
    });
    const recovered = await resolveCapabilityRoute({ persisted: decision, classify: vi.fn(), persist: vi.fn() });
    expect(recovered).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, useStoryboard, answerDetail: 'standard' });
  });

  it('accepts a rejection with a reason and disallows executable answers for it', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Book a flight for me',
      model: classifierModel({ route: 'rejected', reason: 'Travel booking is outside YouTube video synthesis.' }),
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ route: 'rejected', reason: 'Travel booking is outside YouTube video synthesis.' });
    expect(finalIntentMatchesRoute(decision, 'rejected')).toBe(true);
    expect(finalIntentMatchesRoute(decision, 'topic_research')).toBe(false);
    expect(finalIntentMatchesRoute(decision, 'clarification')).toBe(false);
    expect(finalIntentMatchesRoute({ route: 'topic_research' }, 'rejected')).toBe(false);
  });

  it('rejects malformed scope rejections that omit the reason', async () => {
    await expect(classifyCapabilityWithModel({ message: 'Book a flight for me',
      model: classifierModel({ route: 'rejected' }), signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  it('bounds even a classifier provider that ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const model = new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) });
      const result = classifyCapabilityWithModel({ message: 'Research YouTube tutorials', model,
        signal: new AbortController().signal }).then(() => 'completed', error => error.message);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await result).toBe('Classification phase timeout.');
    } finally { vi.useRealTimers(); }
  });

  it('restores comparative breadth without rerunning the classifier', async () => {
    const classify = vi.fn(async () => ({ route: 'topic_research' as const }));
    const decision = await resolveCapabilityRoute({
      persisted: { route: 'topic_research', researchBreadth: 'comparative' },
      classify, persist: vi.fn(),
    });
    expect(decision).toEqual({ route: 'topic_research', researchBreadth: 'comparative' });
    expect(classify).not.toHaveBeenCalled();
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

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, useStoryboard: false, answerDetail: 'standard' });
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

  it.each([
    ['inspect_video', false], ['inspect_video', true], ['topic_research', false], ['topic_research', true],
  ] as const)('gates the %s storyboard tool using classifier choice %s', async (route, useStoryboard) => {
    const model = finalizingModel();
    await runResearchAgentWithModel({ model, message: 'Inspect the video',
      decision: route === 'inspect_video' ? { route, videoId: 'abcdefghijk', useStoryboard } : { route, useStoryboard },
      context: inspectContext(),
      // Even an explicit caller tool list cannot override the classifier's decision.
      toolNames: ['get_video_storyboard', 'finalize_answer'],
    });
    const names = model.doGenerateCalls[0]?.tools?.map(tool => tool.name);
    expect(names?.includes('get_video_storyboard')).toBe(useStoryboard);
    expect(names).toContain('finalize_answer');
  });

  it('blocks provider storyboard execution when the classifier disables it', async () => {
    const storyboard = vi.fn();
    const provider = createCapabilityProvider(providerWith({ storyboard }), {
      route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: false,
    });
    await expect(provider.storyboard!('abcdefghijk')).rejects.toThrow('unavailable');
    expect(storyboard).not.toHaveBeenCalled();
  });
});

function classifierModel(output: Record<string, unknown>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'classify-1', toolName: 'classify_request', input: JSON.stringify({ researchVideoCount: output.route === 'inspect_video' ? 1 : output.route === 'topic_research' ? 3 : 0, useStoryboard: false, answerDetail: 'standard', ...output }) }],
      finishReason: { unified: 'tool-calls', raw: undefined },
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
          blocks: [{ text: 'A supported finding from the video.', evidenceIds: ['ref_1'] }],
          intent: 'inspect_video',
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
