import { MockLanguageModelV4 } from 'ai/test';
import type { TraceToolCall } from '../src/agents/runtime/tool-call-trace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { currentDateGuidance } from '../src/agents/runtime/current-date';

describe('YouTube agent capability router', () => {
  it.each([undefined, null, '', 'unknown', 0, false, {}, []].map(value => ({ value })))(
    'defaults and reports omitted or invalid answer detail on the first response: $value', async ({ value }) => {
      const model = classifierModel({ route: 'topic_research', answerDetail: value, researchBreadth: 'focused',
        searchQuery: 'exercise technique', visualEvidence: 'none' });
      const diagnostic = vi.fn();
      await expect(classifyCapabilityWithModel({ message: 'Explain exercise technique', model,
        signal: new AbortController().signal, onDiagnostic: diagnostic })).resolves.toMatchObject({
        route: 'topic_research', answerDetail: 'standard', researchBreadth: 'focused', researchVideoCount: 2,
      });
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'valid', issues: [], defaultedFields: ['answerDetail'] }));
    });

  it('keeps an explicit source count when research breadth defaults to focused', async () => {
    const model = classifierModel({ route: 'topic_research', answerDetail: 'detailed', researchBreadth: undefined,
      explicitSourceCount: 5, searchQuery: 'exercise technique', visualEvidence: 'none' });
    await expect(classifyCapabilityWithModel({ message: 'Give me a detailed report from five videos about exercise technique', model,
      signal: new AbortController().signal })).resolves.toMatchObject({ answerDetail: 'detailed', researchBreadth: 'focused',
      researchVideoCount: 5, requiredVideoCount: 5 });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it.each([undefined, 'comparison', 'broad'].map(researchBreadth => ({ researchBreadth })))(
    'repairs discovery breadth before considering a fallback: $researchBreadth', async ({ researchBreadth }) => {
      const base = { route: 'topic_research', searchQuery: 'exercise comparison', visualEvidence: 'none' };
      const model = sequenceClassifier([{ ...base, researchBreadth }, { ...base, researchBreadth: 'comparative' }]);
      const diagnostics = vi.fn();
      await expect(classifyCapabilityWithModel({ message: 'Compare exercise techniques', model,
        signal: new AbortController().signal, onDiagnostic: diagnostics })).resolves.toMatchObject({ researchBreadth: 'comparative', researchVideoCount: 4 });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(diagnostics.mock.calls.map(([event]) => ({ outcome: event.outcome, defaultedFields: event.defaultedFields })))
        .toEqual([{ outcome: 'invalid', defaultedFields: [] }, { outcome: 'valid', defaultedFields: [] }]);
    });

  it('defaults and reports only still-missing discovery breadth after repair', async () => {
    const model = sequenceClassifier([{ route: 'topic_research', answerDetail: undefined,
      searchQuery: 'exercise technique', visualEvidence: 'none' }]);
    const diagnostics = vi.fn();
    const traces: { output?: unknown; error?: unknown }[] = [];
    const traceToolCall: TraceToolCall = async call => {
      const trace: typeof traces[number] = {};
      traces.push(trace);
      try { const output = await call.execute(); trace.output = output; return output; }
      catch (error) { trace.error = error; throw error; }
    };
    await expect(classifyCapabilityWithModel({ message: 'Explain exercise technique', model, traceToolCall,
      signal: new AbortController().signal, onDiagnostic: diagnostics })).resolves.toMatchObject({ answerDetail: 'standard', researchBreadth: 'focused', researchVideoCount: 2 });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(diagnostics.mock.calls.map(([event]) => ({ outcome: event.outcome, defaultedFields: event.defaultedFields })))
      .toEqual([{ outcome: 'invalid', defaultedFields: ['answerDetail'] },
        { outcome: 'valid', defaultedFields: ['answerDetail', 'researchBreadth'] }]);
    expect(traces).toHaveLength(2);
    expect(traces[0]?.error).toMatchObject({ name: 'AI_InvalidToolInputError' });
    expect(traces[1]?.output).toMatchObject({ accepted: true });
    expect(model.doGenerateCalls[1]!.tools).toEqual(model.doGenerateCalls[0]!.tools);
  });

  it.each([null, '', 'comparison', 'broad', 0, false, {}, []].map(researchBreadth => ({ researchBreadth })))(
    'rejects still-invalid breadth after repair: $researchBreadth', async ({ researchBreadth }) => {
      const model = sequenceClassifier([{ route: 'topic_research', researchBreadth,
        searchQuery: 'exercise comparison', visualEvidence: 'none' }]);
      const diagnostics = vi.fn();
      await expect(classifyCapabilityWithModel({ message: 'Compare exercise techniques', model,
        signal: new AbortController().signal, onDiagnostic: diagnostics })).rejects.toThrow(/researchBreadth/);
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(diagnostics.mock.calls.map(([event]) => event.defaultedFields)).toEqual([[], []]);
    });

  it('retains valid comparative scope when an advisory visual reconsideration omits breadth', async () => {
    const first = { route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'slide design comparison', visualEvidence: 'helpful' };
    const model = sequenceClassifier([first, { ...first, researchBreadth: undefined }]);
    const diagnostics = vi.fn();
    await expect(classifyCapabilityWithModel({ message: 'Compare slide designs', model,
      signal: new AbortController().signal, onDiagnostic: diagnostics })).resolves.toMatchObject({ researchBreadth: 'comparative', researchVideoCount: 4 });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(diagnostics.mock.calls.map(([event]) => event.defaultedFields)).toEqual([[], []]);
  });

  it('still reports missing essential fields when optional preferences need defaults', async () => {
    const diagnostics = vi.fn();
    const model = sequenceClassifier([{ route: 'topic_research', answerDetail: undefined, explicitSourceCount: 0 }]);
    await expect(classifyCapabilityWithModel({ message: 'Explain exercise technique', model,
      signal: new AbortController().signal, onDiagnostic: diagnostics })).rejects.toMatchObject({ code: 'AGENT_CLASSIFICATION_INVALID' });
    expect(diagnostics.mock.calls[0]![0].issues.map((issue: { path: string }) => issue.path).sort())
      .toEqual(['explicitSourceCount', 'researchBreadth', 'searchQuery', 'visualEvidence']);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it.each([false, true])('recovers the captured fixed-video follow-up with missing discovery fields (answerDetail present: %s)', async hasDetail => {
    const decision = { route: 'topic_research', comparisonVideoIds: ['abcdefghijk', 'lmnopqrstuv'],
      visualEvidence: 'required', visualRequirements: ['exercise form'] };
    const model = sequenceClassifier([{ ...decision, answerDetail: hasDetail ? 'standard' : undefined },
      { ...decision, answerDetail: 'standard' }]);
    const diagnostics = vi.fn();
    const result = await classifyCapabilityWithModel({ message: 'Show exercise images from both videos', model, onDiagnostic: diagnostics,
      conversationHistory: [conversationTurn({ user: 'Review these videos', assistant: 'Earlier review', resourceIds: decision.comparisonVideoIds })],
      signal: new AbortController().signal });
    expect(result).toMatchObject({ ...decision, answerDetail: 'standard', researchVideoCount: 2 });
    expect(result).not.toHaveProperty('searchQuery');
    expect(result).not.toHaveProperty('researchBreadth');
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(diagnostics.mock.calls[0]![0].defaultedFields).toEqual(hasDetail ? [] : ['answerDetail']);
  });

  it('gives repair the previous candidate and all missing fields without losing valid choices', async () => {
    const candidate = { route: 'topic_research', answerDetail: 'detailed', visualEvidence: 'required',
      visualRequirements: ['exercise form'] };
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      const text = prompt.find(message => message.role === 'user')?.content.find(part => part.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Expected the classifier input as text.');
      const payload = JSON.parse(text.text);
      if (calls++) {
        expect(payload.classificationRepair.previousCandidate).toEqual({ researchVideoCount: 1, ...candidate });
        expect(payload.classificationRepair.issues.map((issue: { path: string }) => issue.path).sort())
          .toEqual(['researchBreadth', 'searchQuery']);
      }
      return { content: [{ type: 'tool-call', toolCallId: `route-${calls}`, toolName: 'classify_request',
        input: JSON.stringify(calls === 1 ? { researchVideoCount: 1, ...candidate }
          : { ...payload.classificationRepair.previousCandidate, researchBreadth: 'focused', searchQuery: 'exercise technique' }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    } });
    await expect(classifyCapabilityWithModel({ message: 'Explain exercise technique with images', model,
      signal: new AbortController().signal })).resolves.toMatchObject({ ...candidate, researchBreadth: 'focused', researchVideoCount: 2 });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('defaults a repaired candidate without merging preferences from the previous attempt', async () => {
    const model = sequenceClassifier([
      { route: 'topic_research', answerDetail: 'detailed', visualEvidence: 'none' },
      { route: 'topic_research', answerDetail: undefined, researchBreadth: 'focused', searchQuery: 'exercise technique', visualEvidence: 'none' },
    ]);
    await expect(classifyCapabilityWithModel({ message: 'Explain exercise technique', model,
      signal: new AbortController().signal })).resolves.toMatchObject({ answerDetail: 'standard', researchBreadth: 'focused' });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('previousCandidate');
  });

  it.each([[], ['abcdefghijk'], ['abcdefghijk', 'abcdefghijk'], ['abcdefghijk', 'zzzzzzzzzzz']].map(comparisonVideoIds => ({ comparisonVideoIds })))(
    'does not bypass video-scope validation when discovery fields are omitted: $comparisonVideoIds', async ({ comparisonVideoIds }) => {
      const model = sequenceClassifier([{ route: 'topic_research', comparisonVideoIds, visualEvidence: 'none' }]);
      await expect(classifyCapabilityWithModel({ message: 'Review those videos', model,
        conversationHistory: [conversationTurn({ user: 'Review these videos', assistant: 'Earlier review', resourceIds: ['abcdefghijk', 'lmnopqrstuv'] })],
        signal: new AbortController().signal })).rejects.toThrow(/comparisonVideoIds/);
      expect(model.doGenerateCalls).toHaveLength(2);
    });

  it('collects conditional visual and context requirements alongside invalid base fields', async () => {
    const diagnostics = vi.fn();
    const model = sequenceClassifier([{ route: 'finalize', responseIntent: 'context_answer', answerDetail: undefined,
      reason: 'Saved context', visualEvidence: 'required' }]);
    await expect(classifyCapabilityWithModel({ message: 'Explain the earlier scene', model,
      signal: new AbortController().signal, onDiagnostic: diagnostics })).rejects.toMatchObject({ code: 'AGENT_CLASSIFICATION_INVALID' });
    expect(diagnostics.mock.calls[0]![0].issues.map((issue: { path: string }) => issue.path).sort())
      .toEqual(['contextScope', 'visualRequirements']);
  });

  it('sends route-specific requirements in the model tool schema', async () => {
    const model = classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'exercise technique' });
    await classifyCapabilityWithModel({ message: 'Explain exercise technique', model, signal: new AbortController().signal });
    const schema = model.doGenerateCalls[0]!.tools!.find(tool => tool.type === 'function')!.inputSchema;
    expect(schema).toMatchObject({ type: 'object', required: ['route', 'answerDetail'], anyOf: expect.arrayContaining([
      { properties: { route: { const: 'topic_research' } }, required: ['researchBreadth', 'searchQuery', 'visualEvidence'] },
      { properties: { route: { const: 'topic_research' } }, required: ['comparisonVideoIds', 'visualEvidence'] },
      { properties: { route: { const: 'inspect_video' } }, required: ['videoId', 'visualEvidence'] },
      { properties: { route: { const: 'finalize' } }, required: ['responseIntent', 'reason'] },
    ]) });
  });

  it.each(['how to get the most out of Claude Opus 4.5 tips and prompting guide', 'Opus prompting guide', 'Opus 5.5 and 4.5 prompting guide'])('rejects changed or dropped versions before discovery: %s', async searchQuery => {
    const model = classifierModel({ route: 'topic_research', researchVideoCount: 2, researchBreadth: 'focused',
      searchQuery });
    await expect(classifyCapabilityWithModel({ message: 'how to get the most out of opus 5.5.',
      model, signal: new AbortController().signal })).rejects.toThrow(/searchQuery/);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('repairs a changed version and executes only the corrected routing decision', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'classify_request', input: JSON.stringify({
        route: 'topic_research', researchVideoCount: 2, answerDetail: 'standard', visualEvidence: 'none',
        researchBreadth: 'focused', searchQuery: calls++ ? 'Opus 5.5 prompting guide' : 'Claude Opus 4.5 prompting guide',
      }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
    }) });
    const diagnostic = vi.fn();
    await expect(classifyCapabilityWithModel({ message: 'how to get the most out of opus 5.5?', model,
      signal: new AbortController().signal, onDiagnostic: diagnostic })).resolves.toMatchObject({searchQuery: 'Opus 5.5 prompting guide'});
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('changed_numeric_constraint');
    expect(diagnostic.mock.calls[0]![0]).toMatchObject({outcome: 'invalid'});
  });

  it.each([
    ['Compare Opus 5.5 and Sonnet 4.5', 'Opus 5.5 vs Sonnet 4.5'],
    ['How do I use Blender v4.2.1?', 'Blender 4.2.1 tutorial'],
    ['Explain Opus', 'Opus prompting guide'],
  ])('preserves valid search refinement for %s', async (message, searchQuery) => {
    const model = classifierModel({route: 'topic_research', researchBreadth: 'focused', searchQuery});
    await expect(classifyCapabilityWithModel({message, model, signal: new AbortController().signal})).resolves.toMatchObject({searchQuery});
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('allows comparison with an earlier user-supplied version without dropping the current one', async () => {
    const searchQuery = 'Opus 5.5 vs Opus 4.5';
    await expect(classifyCapabilityWithModel({message: 'Compare that with Opus 5.5.',
      conversationHistory: [conversationTurn({user: 'Explain Opus 4.5', assistant: 'Previous answer', resourceIds: []})],
      model: classifierModel({route: 'topic_research', researchBreadth: 'comparative', searchQuery}),
      signal: new AbortController().signal})).resolves.toMatchObject({searchQuery});
  });

  it('refreshes dynamic data without refreshing transcripts or visuals', async () => {
    const base = providerWith({ video: vi.fn(), comments: vi.fn(), transcript: vi.fn(), storyboard: vi.fn() });
    const provider = createCapabilityProvider(base, {
      route: 'inspect_video', videoId: 'abcdefghijk', refreshDynamicData: true,
    });
    await provider.video('abcdefghijk');
    await provider.comments('abcdefghijk', { all: true });
    await provider.transcript('abcdefghijk', 'en');
    await provider.storyboard!('abcdefghijk');
    expect(base.video).toHaveBeenCalledWith('abcdefghijk', { refresh: true, includeSignals: true });
    expect(base.comments).toHaveBeenCalledWith('abcdefghijk', { all: true, refresh: true });
    expect(base.transcript).toHaveBeenCalledWith('abcdefghijk', 'en', undefined);
    expect(base.storyboard).toHaveBeenCalledWith('abcdefghijk', undefined, undefined, undefined);
  });

  it('retains the dynamic refresh decision and rejects finalizing from old statistics', async () => {
    const decision = { route: 'inspect_video', videoId: 'abcdefghijk', refreshDynamicData: true,
      visualEvidence: 'none', researchVideoCount: 1, answerDetail: 'standard' };
    expect(await classifyCapabilityWithModel({ message: 'How many likes does https://youtu.be/abcdefghijk have now?',
      model: classifierModel(decision), signal: new AbortController().signal })).toMatchObject(decision);
    await expect(classifyCapabilityWithModel({ message: 'How many likes now?',
      model: classifierModel({ route: 'finalize', responseIntent: 'context_answer', contextScope: 'video',
        reason: 'Saved counts', refreshDynamicData: true, researchVideoCount: 0 }),
      signal: new AbortController().signal })).rejects.toThrow();
  });

  it('repairs a follow-up comparison that drops the saved video from its scope', async () => {
    const previous = 'abcdefghijk', current = 'lmnopqrstuv';
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'classify_request', input: JSON.stringify({
        route: 'inspect_video', videoId: current, researchVideoCount: 1, answerDetail: 'standard', visualEvidence: 'none',
        ...(calls++ ? { comparisonVideoIds: [previous, current] } : {}),
      }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
    }) });
    const result = await classifyCapabilityWithModel({
      message: `compare this video with a new one: https://youtu.be/${current}`, model, signal: new AbortController().signal,
      conversationHistory: [{ userMessageId: 'u', agentMessageId: 'a', user: `Summarize https://youtu.be/${previous}`,
        assistant: 'Earlier summary.', resourceIds: [previous] }],
      sessionBrief: { assets: [{version:'a'.repeat(64),kind:'transcript',videoId:previous,collectedAt:1,current:true,details:{}}], memories: [] },
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result).toMatchObject({route:'inspect_video',videoId:current,comparisonVideoIds:[previous,current]});
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('comparisonVideoIds');
  });

  it('repairs the captured incomplete classifier response without forcing tool selection', async () => {
    const valid = { route: 'topic_research', answerDetail: 'standard', researchVideoCount: 3,
      researchBreadth: 'comparative', searchQuery: 'model comparison', visualEvidence: 'none' };
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: `classification-${++calls}`, toolName: 'classify_request',
        input: JSON.stringify(calls === 1 ? { researchBreadth: 'comparative' } : valid) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 40, text: 40, reasoning: undefined } }, warnings: [],
    }) });
    const recordUsage = vi.fn();
    const diagnostics = vi.fn();
    const traces: Array<{id:string;input:unknown;error?:unknown;output?:unknown}>=[];
    const traceToolCall:TraceToolCall=async call=>{
      const trace:typeof traces[number]={id:call.toolCallId,input:call.input};
      traces.push(trace);
      try {const output=await call.execute();trace.output=output;return output;}
      catch(error) {trace.error=error;throw error;}
    };
    expect(await classifyCapabilityWithModel({ traceToolCall, message: 'Compare models', model, signal: new AbortController().signal,
      modelCallId: 'classifier-test', modelBudget: { limitMicros: 10000, currentCostMicros: () => 0, recordUsage },
      onDiagnostic: diagnostics })).toEqual({ ...valid, researchVideoCount: 4, useStoryboard: false });
    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({id:'classification-1',input:{researchBreadth:'comparative'},error:{name:'AI_InvalidToolInputError'}});
    expect(traces[1]).toMatchObject({id:'classification-2',input:{route:'topic_research'},output:{accepted:true}});
    expect(model.doGenerateCalls.map(call => call.toolChoice)).toEqual([{ type: 'auto' }, { type: 'auto' }]);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('searchQuery');
    expect(recordUsage.mock.calls.map(([entry]) => entry.callId)).toEqual(['classifier-test', 'classifier-test:repair']);
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, outcome: 'invalid',
      issues: expect.arrayContaining([{ path: 'route', code: 'invalid_value' }]) });
  });

  it('repairs finalization missing its response intent, and stops after one unsuccessful repair', async () => {
    const model = classifierModel({ route: 'finalize', reason: 'No earlier context.' });
    await expect(classifyCapabilityWithModel({ message: 'try again', model, signal: new AbortController().signal }))
      .rejects.toThrow(/Classification.*responseIntent/);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('repairs a missing tool call without accepting ordinary model prose as a routing decision', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: 'I will compare the models.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    }) });
    await expect(classifyCapabilityWithModel({ message: 'Compare models', model, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'AGENT_CLASSIFICATION_INVALID' });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('requires a routing call when a conversation-list request produces prose', async () => {
    const message = 'Can you list all the user messages in this conversation?';
    const conversationHistory: ConversationTurn[] = [{ userMessageId: 'u1', agentMessageId: 'a1',
      user: 'Who is holding the microphone?', assistant: 'The woman holds it.', resourceIds: [] }];
    const model = new MockLanguageModelV4({ doGenerate: async ({ toolChoice }) => ({
      content: toolChoice?.type === 'tool'
        ? [{ type: 'tool-call' as const, toolCallId: 'route', toolName: 'classify_request', input: JSON.stringify({
          route: 'finalize', responseIntent: 'context_answer', contextScope: 'history', reason: 'List the supplied user messages.',
          answerDetail: 'standard', researchVideoCount: 0,
        }) }]
        : [{ type: 'text' as const, text: 'Your earlier message was: Who is holding the microphone?' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    }) });
    await expect(classifyCapabilityWithModel({ message, conversationHistory, model,
      signal: new AbortController().signal })).resolves.toMatchObject({ route: 'finalize', responseIntent: 'context_answer' });
    expect(model.doGenerateCalls.map(call => call.toolChoice)).toEqual([
      { type: 'auto' }, { type: 'tool', toolName: 'classify_request' },
    ]);
    for (const call of model.doGenerateCalls) {
      expect(JSON.stringify(call.prompt)).toContain(conversationHistory[0]!.user);
      expect(JSON.stringify(call.prompt)).toContain(message);
    }
  });

  it('keeps repair inside the original classification deadline', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: async () => {
        if (++calls > 1) return new Promise(() => {});
        // Slow but under the stall limit, so the repair has too little time left to retry a stall.
        await new Promise(resolve => setTimeout(resolve, 9_000));
        return { content: [{ type: 'tool-call', toolCallId: 'invalid', toolName: 'classify_request', input: '{}' }],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      } });
      const result = classifyCapabilityWithModel({ message: 'Compare models', model, signal: new AbortController().signal })
        .then(() => 'completed', error => error.message);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await result).toBe('Classification phase timeout.');
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('sends one fresh classifier request when the first stalls', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const answer = classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'event sourcing explained' });
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: async options => {
        if (++calls === 1) return new Promise(() => {});
        return answer.doGenerate(options);
      } });
      const result = classifyCapabilityWithModel({ message: 'Explain event sourcing', model, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(model.doGenerateCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ route: 'topic_research', researchBreadth: 'focused' });
      expect(model.doGenerateCalls).toHaveLength(2);
      // A stall is not a repair: the fresh request repeats the original prompt.
      expect(model.doGenerateCalls[1]!.prompt).toEqual(model.doGenerateCalls[0]!.prompt);
      // The phase ends with the decision, which aborts the abandoned request.
      expect(model.doGenerateCalls[0]!.abortSignal?.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent_classification_request_stalled'));
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });

  it('keeps a slow first classifier response that answers after the fresh request starts', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const answer = classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'event sourcing explained' });
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: async options => {
        if (++calls === 2) return new Promise(() => {});
        await new Promise(resolve => setTimeout(resolve, 14_000));
        return answer.doGenerate(options);
      } });
      const result = classifyCapabilityWithModel({ message: 'Explain event sourcing', model, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(14_000);
      await expect(result).resolves.toMatchObject({ route: 'topic_research' });
      expect(model.doGenerateCalls).toHaveLength(2);
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });

  it('fails a stalled classification with the provider error when both requests fail', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const model = new MockLanguageModelV4({ doGenerate: async () => {
        const call = ++calls;
        await new Promise(resolve => setTimeout(resolve, call === 1 ? 12_000 : 1_000));
        throw new Error(`provider failure ${call}`);
      } });
      const result = classifyCapabilityWithModel({ message: 'Explain event sourcing', model, signal: new AbortController().signal })
        .then(() => 'completed', error => error.message);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await result).toContain('provider failure 1');
      expect(model.doGenerateCalls).toHaveLength(2);
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });

  it('does not retry a stalled request when the outer phase deadline leaves too little time', async () => {
    vi.useFakeTimers();
    try {
      const model = new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) });
      const result = classifyCapabilityWithModel({ message: 'Explain event sourcing', model,
        signal: new AbortController().signal, deadlineAt: Date.now() + 12_000 }).then(() => 'completed', error => error.message);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await result).toBe('Classification phase timeout.');
      expect(model.doGenerateCalls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not retry a classifier request the caller cancelled', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const model = new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) });
      const result = classifyCapabilityWithModel({ message: 'Explain event sourcing', model, signal: controller.signal })
        .then(() => 'completed', error => error.message);
      await vi.advanceTimersByTimeAsync(5_000);
      controller.abort(new Error('Cancelled by caller.'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe('Cancelled by caller.');
      expect(model.doGenerateCalls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it.each([1, 3, 6, 8])('persists an explicit research count of %s independently of breadth', async researchVideoCount => {
    const decision = await classifyCapabilityWithModel({ message: `Compare findings from ${researchVideoCount} videos`,
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'coding workflows', explicitSourceCount: researchVideoCount }),
      signal: new AbortController().signal });
    const { researchVideoTarget } = await import('../src/agents/research/research-plan');
    expect(researchVideoTarget(decision)).toBe(researchVideoCount);
    expect(await resolveCapabilityRoute({ persisted: decision, classify: vi.fn(), persist: vi.fn() })).toEqual(decision);
  });
  it.each([0, 1])('accepts the captured DevDay classification despite obsolete conflicting count fields (%s)', async requiredVideoCount => {
    const model = classifierModel({ answerDetail: 'standard', researchBreadth: 'focused', researchVideoCount: 3,
      requiredVideoCount, route: 'topic_research', searchQuery: 'OpenAI DevDay 2026 presenters on stage keynote',
      visualEvidence: 'required', visualRequirements: ['presenter clothing'] });
    const decision = await classifyCapabilityWithModel({ message: 'What were the names of presenters from OpenAI DevDay 2026 and what were they wearing?', model, signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(decision).toMatchObject({ route: 'topic_research', researchVideoCount: 2, visualEvidence: 'required' });
    expect(decision).not.toHaveProperty('requiredVideoCount');
    const schema = model.doGenerateCalls[0]?.tools?.find(tool => tool.type === 'function')?.inputSchema;
    expect(schema).not.toHaveProperty('properties.researchVideoCount');
    expect(schema).not.toHaveProperty('properties.requiredVideoCount');
    expect(schema).toHaveProperty('properties.explicitSourceCount');
  });

  it.each(['https://youtu.be/abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com/shorts/abcdefghijk'])('pins a classifier research decision to the supplied video: %s', async url => {
    const model = classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'keynote presenters',
      visualEvidence: 'required', visualRequirements: ['presenter clothing'] });
    const decision = await classifyCapabilityWithModel({ message: `Research who presented and what they wore: ${url}`, model,
      conversationHistory: [{ userMessageId: 'previous-user', agentMessageId: 'previous-agent', user: 'An earlier video', assistant: 'Prior research', resourceIds: ['lmnopqrstuv'] }],
      signal: new AbortController().signal });
    expect(decision).toMatchObject({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, visualEvidence: 'required' });
    expect(decision).not.toHaveProperty('searchQuery');
    expect(decision).not.toHaveProperty('requiredVideoCount');
  });

  it('derives a research target when no explicit source count was requested', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Compare models',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'models', researchVideoCount: undefined }),
      signal: new AbortController().signal });
    expect(decision).toMatchObject({ researchVideoCount: 4 });
    expect(decision).not.toHaveProperty('requiredVideoCount');
  });
  it('preserves an explicit source requirement above capacity separately from the research target', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Compare findings from ten videos',
      model: classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'models', explicitSourceCount: 10 }),
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
    expect(decision).toMatchObject({ route: 'finalize', responseIntent: 'clarification' });
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
      required: ['route', 'answerDetail'],
      properties: { answerDetail: { enum: ['standard', 'detailed'] } },
    });
    expect(await resolveCapabilityRoute({ persisted: decision, classify: vi.fn(), persist: vi.fn() })).toEqual(decision);
  });

  it('defaults an inspection without an output-budget choice to standard', async () => {
    await expect(classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', answerDetail: undefined }),
      signal: new AbortController().signal })).resolves.toMatchObject({ answerDetail: 'standard' });
  });

  it('routes a request pinned to one supplied video into inspect_video', async () => {
    const decision = await classifyCapabilityWithModel({
      message: 'Summarize https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk' }),
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, useStoryboard: false, visualEvidence: 'none', answerDetail: 'standard' });
  });

  it('routes discovery and comparison requests into topic_research', async () => {
    const model = classifierModel({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'audience retention comparison' });
    const decision = await classifyCapabilityWithModel({
      message: 'Compare current YouTube advice about audience retention.',
      model,
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({ route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'audience retention comparison', researchVideoCount: 4, useStoryboard: false, visualEvidence: 'none', answerDetail: 'standard' });
    expect(model.doGenerateCalls[0]?.tools?.find(tool => tool.type === 'function')?.inputSchema).toMatchObject({ type: 'object', properties: expect.objectContaining({ route: expect.any(Object), searchQuery: expect.any(Object) }) });
  });

  it.each(['focused', 'comparative'] as const)('persists classifier research breadth %s', async (researchBreadth) => {
    const decision = await classifyCapabilityWithModel({
      message: 'Research the best design skills for frontend developers using Claude Code',
      model: classifierModel({ route: 'topic_research', researchBreadth, searchQuery: 'frontend design skills' }),
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ route: 'topic_research', researchBreadth, searchQuery: 'frontend design skills', researchVideoCount: researchBreadth === 'comparative' ? 4 : 2, useStoryboard: false, visualEvidence: 'none', answerDetail: 'standard' });
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

  it.each(['topic_research', 'inspect_video'] as const)('requires an explicit visual evidence choice for new %s routes', async route => {
    await expect(classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route, videoId: 'abcdefghijk', researchBreadth: 'focused', searchQuery: 'YouTube', visualEvidence: undefined }),
      signal: new AbortController().signal,
    })).rejects.toThrow(/visualEvidence/);
  });

  it.each([
    ['none', undefined, false], ['helpful', undefined, true], ['required', ['presenter clothing'], true],
  ] as const)('persists visual evidence %s with derived tool access', async (visualEvidence, visualRequirements, useStoryboard) => {
    const decision = await classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', visualEvidence, visualRequirements }),
      signal: new AbortController().signal,
    });
    const recovered = await resolveCapabilityRoute({ persisted: decision, classify: vi.fn(), persist: vi.fn() });
    expect(recovered).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, useStoryboard, visualEvidence,
      ...(visualRequirements ? { visualRequirements } : {}), answerDetail: 'standard' });
  });

  it('requires visual requirements when visual evidence is required, and drops them otherwise', async () => {
    const missing = classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', visualEvidence: 'required' });
    await expect(classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk', model: missing,
      signal: new AbortController().signal })).rejects.toThrow(/visualRequirements/);
    const helpful = await classifyCapabilityWithModel({ message: 'Inspect https://youtu.be/abcdefghijk',
      model: classifierModel({ route: 'inspect_video', videoId: 'abcdefghijk', visualEvidence: 'helpful', visualRequirements: ['demo screens'] }),
      signal: new AbortController().signal });
    expect(helpful).not.toHaveProperty('visualRequirements');
  });

  it('asks once to reconsider visual cues, then accepts the reconsidered decision', async () => {
    const outputs = [
      { route: 'topic_research', researchBreadth: 'focused', searchQuery: 'OpenAI DevDay keynote presenters', visualEvidence: 'none' },
      { route: 'topic_research', researchBreadth: 'focused', searchQuery: 'OpenAI DevDay keynote presenters', visualEvidence: 'required', visualRequirements: ['presenter clothing'] },
    ];
    const model = sequenceClassifier(outputs);
    const decision = await classifyCapabilityWithModel({ message: 'Who presented at the DevDay keynote and what were they wearing?',
      model, signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(2);
    const repair = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(repair).toContain('possible_visual_requirement');
    expect(repair).toContain('Reconsider the previous classification');
    expect(repair).toMatch(/The request mentions \W+wearing\W+\. If any requested fact depends on what is visible/);
    expect(decision).toMatchObject({ visualEvidence: 'required', visualRequirements: ['presenter clothing'], useStoryboard: true });
  });

  it('keeps the classifier choice when it declines a visual cue, without a third call', async () => {
    const output = { route: 'topic_research', researchBreadth: 'focused', searchQuery: 'jacket sizing advice', visualEvidence: 'none' };
    const model = sequenceClassifier([output, output]);
    const decision = await classifyCapabilityWithModel({ message: 'What sizing advice do tailors give for jackets?',
      model, signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(decision).toMatchObject({ visualEvidence: 'none', useStoryboard: false });
  });

  describe('best-effort visual reconsideration', () => {
    const message = 'Summarize the slide design tips in popular talks';
    const first = { route: 'topic_research', researchBreadth: 'focused', searchQuery: 'slide design tips', visualEvidence: 'helpful' };
    const route = (toolCallId: string) => ({ content: [{ type: 'tool-call' as const, toolCallId, toolName: 'classify_request',
      input: JSON.stringify({ researchVideoCount: 1, answerDetail: 'standard', ...first }) }],
      finishReason: { unified: 'tool-calls' as const, raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [] });
    // The first call answers at once; the reconsideration runs `second`.
    const model = (second: (signal?: AbortSignal) => Promise<never>) => {
      let call = 0;
      return new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
        if (call++ === 0) return route('first');
        return second(abortSignal);
      } });
    };
    const untilAborted = (signal?: AbortSignal) => new Promise<never>((_, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('keeps the first decision when the reconsideration call throws', async () => {
      const classifier = model(async () => { throw new Error('provider unavailable'); });
      const run = classifyCapabilityWithModel({ message, model: classifier, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(0);
      const decision = await run;
      expect(classifier.doGenerateCalls).toHaveLength(2);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"error"'));
      expect(decision).toMatchObject({ searchQuery: 'slide design tips', visualEvidence: 'helpful', useStoryboard: true });
    });

    it('keeps the first decision when the reconsideration exceeds its own deadline', async () => {
      const classifier = model(untilAborted);
      const run = classifyCapabilityWithModel({ message, model: classifier, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(run).resolves.toMatchObject({ searchQuery: 'slide design tips', visualEvidence: 'helpful' });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"timeout"'));
    });

    it('keeps the first decision when the provider ignores the reconsideration abort', async () => {
      const classifier = model(() => new Promise<never>(() => {}));
      const run = classifyCapabilityWithModel({ message, model: classifier, signal: new AbortController().signal });
      const outcome = run.then(decision => decision, (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await outcome).toMatchObject({ searchQuery: 'slide design tips', visualEvidence: 'helpful' });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"timeout"'));
    });

    it('skips reconsideration when too little classification time remains', async () => {
      let call = 0;
      // A first response cannot take 18 s any more: it stalls at 10 s and the
      // fresh request answers 8 s later, leaving no time to reconsider.
      const classifier = new MockLanguageModelV4({ doGenerate: async () => {
        if (call++ === 0) return new Promise<never>(() => {});
        if (call === 2) { await new Promise(resolve => setTimeout(resolve, 8_000)); return route('first'); }
        throw new Error('must not be called');
      } });
      const run = classifyCapabilityWithModel({ message, model: classifier, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(18_000);
      await expect(run).resolves.toMatchObject({ visualEvidence: 'helpful' });
      expect(classifier.doGenerateCalls).toHaveLength(2);
    });

    it('propagates user cancellation during reconsideration', async () => {
      const controller = new AbortController();
      const classifier = model(signal => { queueMicrotask(() => controller.abort(new Error('Cancelled by caller.'))); return untilAborted(signal); });
      const run = classifyCapabilityWithModel({ message, model: classifier, signal: controller.signal });
      const outcome = run.then(() => 'resolved', (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toBe('Cancelled by caller.');
      expect(classifier.doGenerateCalls).toHaveLength(2);
    });
  });

  it('keeps a valid first decision when the visual reconsideration is malformed', async () => {
    const model = sequenceClassifier([
      { route: 'topic_research', researchBreadth: 'focused', searchQuery: 'slide design tips', visualEvidence: 'helpful' },
      { route: 'topic_research' },
    ]);
    const decision = await classifyCapabilityWithModel({ message: 'Summarize the slide design tips in popular talks',
      model, signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(decision).toMatchObject({ route: 'topic_research', searchQuery: 'slide design tips', visualEvidence: 'helpful', useStoryboard: true });
  });

  it('does not ask for reconsideration without visual cues or when visuals are already required', async () => {
    const plain = sequenceClassifier([{ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'reservoir computing', visualEvidence: 'none' }]);
    await classifyCapabilityWithModel({ message: 'Help me understand reservoir computing', model: plain, signal: new AbortController().signal });
    expect(plain.doGenerateCalls).toHaveLength(1);
    const required = sequenceClassifier([{ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'keynote outfits',
      visualEvidence: 'required', visualRequirements: ['presenter clothing'] }]);
    await classifyCapabilityWithModel({ message: 'What were the keynote presenters wearing?', model: required, signal: new AbortController().signal });
    expect(required.doGenerateCalls).toHaveLength(1);
  });

  it('accepts a rejection with a reason and disallows executable answers for it', async () => {
    const decision = await classifyCapabilityWithModel({ message: 'Book a flight for me',
      model: classifierModel({ route: 'finalize', responseIntent: 'rejected', reason: 'Travel booking is outside YouTube video synthesis.', answerDetail: 'standard' }),
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ route: 'finalize', responseIntent: 'rejected', reason: 'Travel booking is outside YouTube video synthesis.', answerDetail: 'standard' });
    expect(finalIntentMatchesRoute(decision, 'rejected')).toBe(true);
    expect(finalIntentMatchesRoute(decision, 'topic_research')).toBe(false);
    expect(finalIntentMatchesRoute(decision, 'clarification')).toBe(false);
    expect(finalIntentMatchesRoute({ route: 'topic_research' }, 'rejected')).toBe(false);
  });

  it('rejects malformed scope rejections that omit the reason', async () => {
    await expect(classifyCapabilityWithModel({ message: 'Book a flight for me',
      model: classifierModel({ route: 'finalize', responseIntent: 'rejected' }), signal: new AbortController().signal,
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
      route: 'finalize', responseIntent: 'clarification',
      reason: 'Which YouTube video would you like me to inspect? Please provide its URL or video ID.',
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

    expect(decision).toEqual({ route: 'inspect_video', videoId: 'abcdefghijk', researchVideoCount: 1, useStoryboard: false, visualEvidence: 'none', answerDetail: 'standard' });
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
      decision: { route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: true },
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

  it('gives the research loop the run date as a trusted instruction', async () => {
    const model = finalizingModel();
    const currentDate = currentDateGuidance(Date.UTC(2026, 9, 1, 20, 0), 'Asia/Kolkata');
    await runResearchAgentWithModel({
      model, message: 'Find videos about it from this year',
      decision: { route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: false },
      context: { ...inspectContext(), currentDate },
    });
    const system = model.doGenerateCalls[0]!.prompt.find(message => message.role === 'system');
    expect(system?.content).toContain('Current date: Friday, 2 October 2026 (2026-10-02)');
    // The date must not be smuggled into the untrusted user payload instead.
    const user = JSON.stringify(model.doGenerateCalls[0]!.prompt.filter(message => message.role !== 'system'));
    expect(user).not.toContain('Current date:');
  });

  it('gives the classifier the run date and asks for absolute dates in searchQuery', async () => {
    const model = classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'AI agents 2026' });
    await classifyCapabilityWithModel({ message: 'AI agent videos from this year', model,
      signal: new AbortController().signal, currentDate: currentDateGuidance(Date.UTC(2026, 9, 2, 8), 'UTC') });
    const system = model.doGenerateCalls[0]!.prompt.find(message => message.role === 'system');
    expect(system?.content).toContain('Current date: Friday, 2 October 2026 (2026-10-02)');
    expect(system?.content).toContain('write the absolute year or date into searchQuery');
  });

  it('omits the date line when a caller supplies no date', async () => {
    const model = classifierModel({ route: 'topic_research', researchBreadth: 'focused', searchQuery: 'AI agents' });
    await classifyCapabilityWithModel({ message: 'AI agent videos', model, signal: new AbortController().signal });
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain('Current date:');
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

function sequenceClassifier(outputs: Record<string, unknown>[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const output = outputs[Math.min(call++, outputs.length - 1)]!;
      return {
        content: [{ type: 'tool-call', toolCallId: `classify-${call}`, toolName: 'classify_request', input: JSON.stringify({
          researchVideoCount: output.route === 'inspect_video' ? 1 : output.route === 'topic_research' ? 1 : 0, answerDetail: 'standard', ...output }) }],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
      };
    },
  });
}

function classifierModel(output: Record<string, unknown>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'classify-1', toolName: 'classify_request', input: JSON.stringify({ researchVideoCount: output.route === 'inspect_video' ? 1 : output.route === 'topic_research' ? 3 : 0, visualEvidence: 'none', answerDetail: 'standard', ...output }) }],
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
    agentMessageId: crypto.randomUUID(),
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
      agentMessageId: crypto.randomUUID(),
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
