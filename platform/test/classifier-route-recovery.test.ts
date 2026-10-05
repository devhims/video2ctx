import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCapabilityWithModel, type ClassificationDiagnostic } from '../src/agents/research/capability-router';
import type { TraceToolCall } from '../src/agents/runtime/tool-call-trace';
import type { CapabilityRouteDecision } from '../src/agents/contracts';
import type { AgentModelCostBudget } from '../src/agents/runtime/model-budget';

type Step = Record<string, unknown> | { error: string } | { afterMs: number; payload?: Record<string, unknown> };

// Each call returns the next step: raw arguments exactly as given (no test defaults),
// a provider error, or a delayed response. A delay without a payload never answers.
function rawClassifier(...steps: Step[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({ doGenerate: async () => {
    const step = steps[Math.min(call++, steps.length - 1)]!;
    if ('error' in step && typeof step.error === 'string' && Object.keys(step).length === 1) throw new Error(step.error);
    let payload = step as Record<string, unknown> | undefined;
    if ('afterMs' in step && typeof step.afterMs === 'number') {
      await new Promise(resolve => setTimeout(resolve, step.afterMs as number));
      payload = step.payload as Record<string, unknown> | undefined;
      if (!payload) return new Promise(() => {});
    }
    return { content: [{ type: 'tool-call', toolCallId: `classify-${call}`, toolName: 'classify_request', input: JSON.stringify(payload) }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });
}

async function classify(message: string, model: MockLanguageModelV4, extra: {
  fallbackModel?: MockLanguageModelV4; modelBudget?: AgentModelCostBudget; signal?: AbortSignal; advanceMs?: number; deadlineAt?: number;
} = {}) {
  const diagnostics: ClassificationDiagnostic[] = [];
  const traced: unknown[] = [];
  const traceToolCall: TraceToolCall = async execution => {
    traced.push(execution.input);
    return execution.execute();
  };
  const pending: Promise<{ decision?: CapabilityRouteDecision; error?: { code?: string; message: string } }> = classifyCapabilityWithModel({
    message, model, fallbackModel: extra.fallbackModel, modelBudget: extra.modelBudget, modelCallId: 'run:classifier', deadlineAt: extra.deadlineAt,
    signal: extra.signal ?? new AbortController().signal, onDiagnostic: event => diagnostics.push(event), traceToolCall })
    .then(decision => ({ decision }), (error: { code?: string; message: string }) => ({ error }));
  await vi.advanceTimersByTimeAsync(extra.advanceMs ?? 0);
  const outcome = await pending;
  const lastResort = diagnostics.find(event => event.stage === 'last_resort');
  return { ...outcome, diagnostics, lastResort, traced, calls: model.doGenerateCalls.length,
    fallbackCalls: extra.fallbackModel?.doGenerateCalls.length ?? 0 };
}

// Captured production arguments, trimmed only of user-specific reason text.
const production = {
  // Run be55b423, attempt 1.
  topicResearch: { answerDetail: 'standard', researchBreadth: 'comparative',
    searchQuery: 'MrBeast latest projects and news 2026', visualEvidence: 'none' },
  // Runs 5d3f5302 and 794f5142, attempt 1.
  inspectVideo: (videoId: string) => ({ answerDetail: 'standard',
    reason: 'User requests visual inspection of a single supplied YouTube video; route to inspect_video with required visual evidence.',
    videoId, visualEvidence: 'required', visualRequirements: ['exact frames at the requested timestamps'] }),
  // The same runs' repairs, whose keys carried leaked tool-call markup.
  corruptedRepair: (videoId: string, key: string) => ({ answerDetail: 'standard', [key]: videoId,
    visualEvidence: 'required', visualRequirements: ['exact frames at the requested timestamps'] }),
};
const validTopic = { route: 'topic_research', answerDetail: 'standard', researchBreadth: 'focused',
  searchQuery: 'event sourcing explained', visualEvidence: 'none' };
const framesMessage = (videoId: string) => `Extract exact frames from https://www.youtube.com/watch?v=${videoId} at six timestamps`;

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('classifier fallback order', () => {
  it('accepts a complete first decision without the fallback model or last resort', async () => {
    const fallbackModel = rawClassifier(validTopic);
    const result = await classify('Explain event sourcing', rawClassifier(validTopic), { fallbackModel });
    expect(result.decision).toMatchObject({ route: 'topic_research' });
    expect([result.calls, result.fallbackCalls]).toEqual([1, 0]);
    expect(result.lastResort).toBeUndefined();
  });

  it('keeps model attempts strict: a missing route goes to the repair, not to recovery', async () => {
    const result = await classify('What is Mr beast upto these days', rawClassifier(production.topicResearch, validTopic));
    expect(result.calls).toBe(2);
    expect(result.diagnostics[0]).toMatchObject({ attempt: 1, outcome: 'invalid', defaultedFields: [],
      issues: [expect.objectContaining({ path: 'route' })] });
    expect(result.decision).toMatchObject({ searchQuery: 'event sourcing explained' });
  });

  it('sends attempt 3 to the fallback model with the original prompt after both primary attempts fail', async () => {
    const recordUsage = vi.fn();
    const primary = rawClassifier(production.topicResearch);
    const fallbackModel = rawClassifier({ ...production.topicResearch, route: 'topic_research' });
    const result = await classify('What is Mr beast upto these days', primary, { fallbackModel,
      modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage } });
    expect(result.decision).toMatchObject({ route: 'topic_research', searchQuery: 'MrBeast latest projects and news 2026' });
    expect([result.calls, result.fallbackCalls]).toEqual([2, 1]);
    expect(result.lastResort).toBeUndefined();
    expect(result.diagnostics.at(-1)).toMatchObject({ attempt: 3, stage: 'fallback_model', outcome: 'valid' });
    // A fresh prompt, not a repair of the primary model's candidate.
    expect(JSON.stringify(fallbackModel.doGenerateCalls[0]!.prompt)).not.toContain('classificationRepair');
    expect(recordUsage.mock.calls.map(([entry]) => entry.callId)).toEqual(['run:classifier', 'run:classifier:repair', 'run:classifier:fallback']);
  });

  it('starts the fallback model when the primary attempt is still stalled close to the deadline', async () => {
    const fallbackModel = rawClassifier({ afterMs: 3_000, payload: validTopic });
    const result = await classify('Explain event sourcing', rawClassifier({ afterMs: 60_000 }), { fallbackModel, advanceMs: 15_000 });
    // Original at 0 s, its hedge at 10 s, the fallback at 12 s, answering at 15 s.
    expect(result.decision).toMatchObject({ route: 'topic_research', searchQuery: 'event sourcing explained' });
    expect([result.calls, result.fallbackCalls]).toEqual([2, 1]);
  });

  it('starts the fallback model 8 seconds before the deadline when the repair is still pending', async () => {
    const fallbackModel = rawClassifier(validTopic);
    // Attempt 1 is invalid at 9 s and its repair has not answered by 12 s.
    const primary = rawClassifier({ afterMs: 9_000, payload: production.topicResearch }, { afterMs: 60_000 });
    const result = await classify('What is Mr beast upto these days', primary, { fallbackModel, advanceMs: 12_000 });
    expect(result.decision).toMatchObject({ searchQuery: 'event sourcing explained' });
    expect([result.calls, result.fallbackCalls]).toEqual([2, 1]);
  });

  it('still starts the fallback model when its deadline timer fires late', async () => {
    const schedule = globalThis.setTimeout;
    // Every timer fires 5 ms late, as an overloaded isolate might.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) =>
      schedule(handler, (ms ?? 0) + 5)) as typeof setTimeout);
    const fallbackModel = rawClassifier(validTopic);
    const result = await classify('Explain event sourcing', rawClassifier({ afterMs: 60_000 }), { fallbackModel, advanceMs: 12_000 });
    expect(result.fallbackCalls).toBe(1);
    expect(result.decision).toMatchObject({ searchQuery: 'event sourcing explained' });
  });

  it('skips the fallback model when less than 8 seconds of the phase remain', async () => {
    const fallbackModel = rawClassifier(validTopic);
    const result = await classify('What is Mr beast upto these days', rawClassifier(production.topicResearch),
      { fallbackModel, deadlineAt: Date.now() + 7_000 });
    expect(result.fallbackCalls).toBe(0);
    expect(result.lastResort).toMatchObject({ lastResort: 'route_recovery', defaultedFields: ['route'] });
  });

  it('builds the last resort just before the deadline when the fallback model stalls', async () => {
    const primary = rawClassifier(production.topicResearch);
    const result = await classify('What is Mr beast upto these days', primary,
      { fallbackModel: rawClassifier({ afterMs: 60_000 }), advanceMs: 19_750 });
    expect(result.lastResort).toMatchObject({ lastResort: 'route_recovery', defaultedFields: ['route'] });
    expect(result.decision).toMatchObject({ route: 'topic_research', researchBreadth: 'comparative' });
  });

  it('fails only on an exhausted budget or cancellation', async () => {
    let spent = 0;
    const budget = { limitMicros: 1, currentCostMicros: () => spent, recordUsage: () => { spent = 2; } };
    const exhausted = await classify('What is Mr beast upto these days', rawClassifier(production.topicResearch),
      { fallbackModel: rawClassifier(production.topicResearch), modelBudget: budget });
    expect(exhausted.error?.message).toMatch(/budget/);
    expect(exhausted.lastResort).toBeUndefined();

    const controller = new AbortController();
    const pending = classify('Explain event sourcing', rawClassifier({ afterMs: 60_000 }), { signal: controller.signal, advanceMs: 2_000 });
    controller.abort(new Error('Cancelled by user'));
    expect((await pending).error?.message).toBe('Cancelled by user');
  });
});

describe('classifier last resort', () => {
  it('recovers the production topic research route after the fallback model also omits it', async () => {
    const result = await classify('What is Mr beast upto these days', rawClassifier(production.topicResearch),
      { fallbackModel: rawClassifier(production.topicResearch) });
    expect(result.decision).toMatchObject({ route: 'topic_research', researchBreadth: 'comparative',
      searchQuery: 'MrBeast latest projects and news 2026' });
    expect([result.calls, result.fallbackCalls]).toEqual([2, 1]);
    expect(result.lastResort).toMatchObject({ lastResort: 'route_recovery', defaultedFields: ['route'] });
    // Traces keep what the provider sent, without the recovered route.
    expect(result.traced[0]).toEqual(production.topicResearch);
  });

  it.each([
    ['5d3f5302', 'dQw4w9WgXcQ', 'inspect_video</arg_value><arg_key>videoId'],
    ['794f5142', 'tXcT3OE7G1g', 'inspect_video<arg_key>videoId'],
  ])('recovers run %s from attempt 1 when the repair has corrupted keys and the fallback errors', async (_run, videoId, key) => {
    const result = await classify(framesMessage(videoId),
      rawClassifier(production.inspectVideo(videoId), production.corruptedRepair(videoId, key)),
      { fallbackModel: rawClassifier({ error: 'fallback unavailable' }) });
    expect(result.decision).toMatchObject({ route: 'inspect_video', videoId, visualEvidence: 'required' });
    expect(result.lastResort).toMatchObject({ lastResort: 'route_recovery', defaultedFields: ['route'] });
  });

  it.each([
    'inspect_video</arg_value><arg_key>videoId',
    'inspect_video<arg_key>videoId',
  ])('never reads corrupted keys, and assembles the remaining valid fields: %s', async key => {
    const corrupted = production.corruptedRepair('aaaaaaaaaaa', key);
    const result = await classify(framesMessage('dQw4w9WgXcQ'), rawClassifier(corrupted));
    // The video comes from the request, not from the corrupted key's value.
    expect(result.decision).toMatchObject({ route: 'inspect_video', videoId: 'dQw4w9WgXcQ', visualEvidence: 'required' });
    expect(result.lastResort).toMatchObject({ lastResort: 'assembled' });
    expect(result.lastResort!.defaultedFields).toEqual(expect.arrayContaining(['route', 'videoId']));
  });

  it.each([
    ['an explicit invalid route', { ...production.topicResearch, route: 'research' }],
    ['a null route', { ...production.topicResearch, route: null }],
    ['discovery fields beside a supplied video', { ...production.topicResearch, videoId: 'dQw4w9WgXcQ' }],
    ['discovery fields beside finalization fields', { ...production.topicResearch, responseIntent: 'rejected', reason: 'Unsupported.' }],
    ['a search query without breadth', { answerDetail: 'standard', searchQuery: 'event sourcing explained', visualEvidence: 'none' }],
    ['breadth without a search query', { answerDetail: 'standard', researchBreadth: 'focused', visualEvidence: 'none' }],
    ['comparison subjects alone', { answerDetail: 'standard', comparisonVideoIds: ['dQw4w9WgXcQ', 'tXcT3OE7G1g'], visualEvidence: 'none' }],
    ['a video ID that was never supplied', production.inspectVideo('aaaaaaaaaaa')],
    ['finalization without a reason', { answerDetail: 'standard', responseIntent: 'rejected' }],
    ['a context answer without its scope', { answerDetail: 'standard', responseIntent: 'context_answer', reason: 'Saved context suffices.' }],
    ['finalization that asks for fresh data', { answerDetail: 'standard', responseIntent: 'context_answer', contextScope: 'video',
      reason: 'Saved context suffices.', refreshDynamicData: true }],
  ])('does not infer a route from %s, but still returns a valid decision', async (_case, payload) => {
    const message = 'Explain event sourcing, compare https://www.youtube.com/watch?v=dQw4w9WgXcQ with https://www.youtube.com/watch?v=tXcT3OE7G1g';
    const result = await classify(message, rawClassifier(payload));
    expect(result.calls).toBe(2);
    expect(result.lastResort?.lastResort).not.toBe('route_recovery');
    expect(result.decision?.route).toEqual(expect.any(String));
  });

  it('recovers a finalization route only with its required fields', async () => {
    const result = await classify('Write a sorting function in Python',
      rawClassifier({ answerDetail: 'standard', responseIntent: 'rejected', reason: 'Standalone coding is not supported.' }));
    expect(result.decision).toMatchObject({ route: 'finalize', responseIntent: 'rejected' });
    expect(result.lastResort).toMatchObject({ lastResort: 'route_recovery' });
  });

  it('defaults an incomplete finalization to a clarification', async () => {
    const result = await classify('Compare it with the other one', rawClassifier({ route: 'finalize', answerDetail: 'standard' }));
    expect(result.decision).toMatchObject({ route: 'finalize', responseIntent: 'clarification' });
    expect(result.lastResort!.defaultedFields).toEqual(expect.arrayContaining(['responseIntent', 'reason']));
  });

  it('replaces a search query that changed the request facts with the request itself', async () => {
    const message = 'How do I get the most out of Opus 5.5?';
    const result = await classify(message, rawClassifier({ answerDetail: 'standard', researchBreadth: 'focused',
      searchQuery: 'Opus 4.5 tips and prompting guide', visualEvidence: 'none' }));
    expect(result.decision).toMatchObject({ route: 'topic_research', searchQuery: message, researchBreadth: 'focused' });
    expect(result.lastResort).toMatchObject({ lastResort: 'assembled' });
    expect(result.lastResort!.defaultedFields).toEqual(expect.arrayContaining(['route', 'searchQuery']));
  });

  it('keeps required visuals mandatory, taking the requirements from the request when the model gave none', async () => {
    const message = 'What did the keynote presenters wear?';
    const result = await classify(message, rawClassifier({ answerDetail: 'standard',
      researchBreadth: 'focused', searchQuery: 'keynote presenter outfits', visualEvidence: 'required' }));
    expect(result.decision).toMatchObject({ route: 'topic_research', visualEvidence: 'required', visualRequirements: [message],
      useStoryboard: true, searchQuery: 'keynote presenter outfits' });
    expect(result.lastResort!.defaultedFields).toContain('visualRequirements');
  });

  it('keeps required visuals even when the decision falls back to request defaults', async () => {
    // A corrupted key blocks recovery; the candidate still said the answer needs images.
    const result = await classify('What did the presenter wear in https://youtu.be/dQw4w9WgXcQ?',
      rawClassifier({ answerDetail: 'standard', 'route<arg_key>': 'inspect_video', visualEvidence: 'required',
        visualRequirements: ['presenter clothing'] }));
    expect(result.decision).toMatchObject({ route: 'inspect_video', videoId: 'dQw4w9WgXcQ', visualEvidence: 'required',
      visualRequirements: ['presenter clothing'] });
  });

  it('keeps a fresh-data requirement and chooses an executable route instead of finalizing', async () => {
    // Finalize with a refresh is invalid; the last resort must not drop the refresh to make it valid.
    const stale = { route: 'finalize', answerDetail: 'standard', responseIntent: 'context_answer', contextScope: 'video',
      reason: 'Saved statistics answer this.', refreshDynamicData: true };
    const inspection = await classify('How many likes does https://youtu.be/dQw4w9WgXcQ have right now?', rawClassifier(stale));
    expect(inspection.decision).toMatchObject({ route: 'inspect_video', videoId: 'dQw4w9WgXcQ', refreshDynamicData: true });

    const research = await classify('What are the current view counts for the top MrBeast videos?', rawClassifier(stale));
    expect(research.decision).toMatchObject({ route: 'topic_research', refreshDynamicData: true,
      searchQuery: 'What are the current view counts for the top MrBeast videos?' });
  });

  it.each([
    ['an invalid candidate', [{ answerDetail: 'standard', videoId: 'tXcT3OE7G1g', visualEvidence: 'none', searchQuery: 'compare' }]],
    ['no candidate at all', [{ error: 'provider down' }]],
  ])('keeps both subjects of a follow-up comparison after %s', async (_case, steps) => {
    const message = 'Compare the previous video with https://youtu.be/tXcT3OE7G1g';
    const pending = classifyCapabilityWithModel({ message, model: rawClassifier(...(steps as Step[])),
      conversationHistory: [{ userMessageId: 'u1', agentMessageId: 'a1', resourceIds: ['dQw4w9WgXcQ'],
        user: 'Summarize https://youtu.be/dQw4w9WgXcQ', assistant: 'It is a music video.' }],
      signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    const decision = await pending;
    expect(decision).toMatchObject({ route: 'topic_research', comparisonVideoIds: ['dQw4w9WgXcQ', 'tXcT3OE7G1g'] });
    expect(decision).not.toHaveProperty('searchQuery');
  });

  it('uses request defaults alone when no request produced a candidate', async () => {
    const research = await classify('Find Nikon Z6 III low-light tutorials', rawClassifier({ error: 'provider down' }),
      { fallbackModel: rawClassifier({ error: 'provider down' }) });
    expect(research.decision).toMatchObject({ route: 'topic_research', researchBreadth: 'focused',
      searchQuery: 'Find Nikon Z6 III low-light tutorials', visualEvidence: 'none', answerDetail: 'standard' });
    expect(research.lastResort).toMatchObject({ lastResort: 'defaults' });

    const inspection = await classify(framesMessage('dQw4w9WgXcQ'), rawClassifier({ error: 'provider down' }));
    expect(inspection.decision).toMatchObject({ route: 'inspect_video', videoId: 'dQw4w9WgXcQ', visualEvidence: 'helpful' });
  });

  it('records every defaulted field alongside the recovered route', async () => {
    const result = await classify('What is Mr beast upto these days', rawClassifier({ ...production.topicResearch, answerDetail: 'unknown' }));
    expect(result.decision).toMatchObject({ route: 'topic_research', answerDetail: 'standard' });
    expect(result.lastResort).toMatchObject({ lastResort: 'route_recovery', defaultedFields: ['answerDetail', 'route'] });
    expect(result.traced[0]).toEqual({ ...production.topicResearch, answerDetail: 'unknown' });
  });
});
