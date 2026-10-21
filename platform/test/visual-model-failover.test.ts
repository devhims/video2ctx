import { MockLanguageModelV4 } from 'ai/test';
import { withModelFailover } from '../src/agents/runtime/model-failover';
import { withRunDeadline } from '../src/agents/runtime/deadline';
import { streamOf } from './fixtures/model-streams';
import { generateText } from 'ai';
import { createAgentModel, FIREWORKS_GLM_MODEL_ID } from '../src/agents/model';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import type { ModelFailoverState } from '../src/agents/runtime/model-failover';
import { sseResponse } from './fixtures/model-streams';

const deepseek = 'accounts/fireworks/models/deepseek-v4p1-flash';
const env = { AI_GATEWAY_ID: '', FIREWORKS_API_KEY: 'test-key', AGENT_GLM_PROVIDER: 'fireworks',
  AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_REASONING_EFFORT: 'medium' } as unknown as Env;
const images = ['/9j/2Q==', '/9j/3Q=='];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([['frames', false], ['frames', true], ['storyboard', false], ['storyboard', true]] as const)('takes over %s images with prior research fallback %s', async (kind, priorFallback) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const requests: Array<{ model: string; messages: unknown; service_tier: string; reasoning_effort: string; response_format: unknown; stream: boolean }> = [];
  // One frame-specific finding and one finding shared by both images, in the analyst's current contract.
  const output = kind === 'frames'
    ? { findings: [{ observation: 'Two colored boxes are visible.', timestampsMs: [1000] }],
      sharedFindings: [{ observation: 'A white background is visible.', timestampsMs: [1000, 5000] }], warnings: [] }
    : { findings: [{ observation: 'Two colored boxes are visible.', frameIndexes: [0] }],
      sharedFindings: [{ observation: 'A white background is visible.', frameIndexes: [0, 10] }], warnings: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.model === FIREWORKS_GLM_MODEL_ID) return new Promise(() => {});
    return sseResponse(body.model, JSON.stringify(output));
  });
  const state: ModelFailoverState = { fallback: false };
  if (priorFallback) {
    const research = generateText({ model: createAgentModel(env, 'visual', 'low', { model_role: 'agent_core' }, state), prompt: 'research' });
    await vi.advanceTimersByTimeAsync(10_001);
    await research;
  }
  const recordUsage = vi.fn();
  const budget = { limitMicros: 1000000, currentCostMicros: () => 0, recordUsage };
  const model = createAgentModel(env, 'visual', 'low', { model_role: 'visual_analyst' }, state);
  const analyze = () => kind === 'frames'
    ? createFrameAnalyst(model, budget)({ signal: new AbortController().signal, modelCallId: 'frames', focus: 'Describe the boxes',
      frames: { videoId: 'abcdefghijk', frames: images.map((imageBase64, index) => ({ imageBase64,
        timestampMs: index ? 5000 : 1000, mimeType: 'image/jpeg', width: 200, height: 100 })), failures: [], meta: { partial: false, warnings: [] } } })
    : createVisualAnalyst(model, budget)({ signal: new AbortController().signal, modelCallId: 'storyboard', focus: 'Describe the boxes',
      storyboard: { videoId: 'abcdefghijk', frameCount: 11, intervalMs: 1000,
        sheets: images.map((imageBase64, index) => ({ imageBase64, firstFrameIndex: index ? 10 : 0,
          frameCount: 1, tileWidth: 200, tileHeight: 100, rows: 1, columns: 1, intervalMs: 1000 })), meta: { partial: true, warnings: [] } } });
  const task = analyze();
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await task).toEqual(output);
  expect(requests.map(request => request.model)).toEqual(priorFallback ? [FIREWORKS_GLM_MODEL_ID, deepseek, deepseek] : [FIREWORKS_GLM_MODEL_ID, deepseek]);
  if (!priorFallback) expect(requests[1]!.messages).toEqual(requests[0]!.messages);
  expect(requests.at(-1)).toMatchObject({ service_tier: 'priority', reasoning_effort: 'none', response_format: { type: 'json_schema' }, stream: true });
  for (const image of images) expect(JSON.stringify(requests.at(-1)!.messages)).toContain(`data:image/jpeg;base64,${image}`);
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ modelId: deepseek }));

  // The same switch applies in both directions, to new images and every other role.
  await analyze();
  for (const role of ['classifier', 'agent_core', 'transcript_analyst', 'memory_updater', 'finalizer']) {
    await generateText({ model: createAgentModel(env, 'visual', 'low', { model_role: role }, state), prompt: 'continue' });
  }
  expect(requests.slice(1).every(request => request.model === deepseek)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

// Exercise both analyst wrappers, including their outer budget, with real SDK streaming.
it.each(['frames', 'storyboard'] as const)('%s allows active output, fallback and research cancellation', async kind => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const output = { findings: [], sharedFindings: [], warnings: [] };
  const completed = () => streamOf({ content: [{ type: 'text', text: JSON.stringify(output) }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 } } });
  const active = (finishMs?: number) => new MockLanguageModelV4({ doStream: async () => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'reasoning-start', id: 'r' });
      controller.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'Inspecting images' });
      if (finishMs !== undefined) {
        const timer = setTimeout(async () => {
          controller.enqueue({ type: 'reasoning-end', id: 'r' });
          const reader = completed().stream.getReader();
          while (true) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); }
          controller.close();
        }, finishMs);
        this.cancel = () => clearTimeout(timer);
      }
    } }),
  }) });
  const analyze = async (model: ReturnType<typeof withModelFailover>, signal: AbortSignal) => kind === 'frames'
    ? createFrameAnalyst(model)({ signal, modelCallId: 'frames', focus: 'Inspect', frames: {
      videoId: 'abcdefghijk', frames: [{ imageBase64: images[0]!, timestampMs: 1000,
        mimeType: 'image/jpeg', width: 200, height: 100 }], failures: [], meta: { partial: false, warnings: [] } } })
    : createVisualAnalyst(model)({ signal, modelCallId: 'storyboard', focus: 'Inspect', storyboard: {
      videoId: 'abcdefghijk', frameCount: 1, intervalMs: 1000, sheets: [{ imageBase64: images[0]!,
        firstFrameIndex: 0, frameCount: 1, tileWidth: 200, tileHeight: 100, rows: 1, columns: 1,
        intervalMs: 1000 }], meta: { partial: false, warnings: [] } } });
  for (const scenario of ['success', 'fallback', 'deadline'] as const) {
    const primary = active(scenario === 'success' ? 25_000 : undefined);
    const fallback = active(scenario === 'deadline' ? undefined : 15_000);
    const deadlineAt = Date.now() + (scenario === 'deadline' ? 35_000 : 120_000);
    const model = withModelFailover({ primary, fallback, role: 'visual_analyst', state: { fallback: false, deadlineAt } });
    const pending = withRunDeadline(deadlineAt, new AbortController().signal,
      signal => analyze(model, signal), 'Research deadline reached').catch(error => error);
    await vi.advanceTimersByTimeAsync(scenario === 'success' ? 25_001 : scenario === 'fallback' ? 45_001 : 35_001);
    const result = await pending;
    if (scenario === 'deadline') expect(result).toBeInstanceOf(Error);
    else expect(result).toEqual(output);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(fallback.doStreamCalls).toHaveLength(scenario === 'success' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  }
});

describe('configured visual model', () => {
  const kimi = 'accounts/fireworks/models/kimi-k3';
  const kimiEnv = { ...env, AGENT_VISUAL_MODEL: 'kimi-k3' } as unknown as Env;
  const output = { findings: [{ observation: 'Two colored boxes are visible.', timestampsMs: [1000] }], sharedFindings: [], warnings: [] };
  const analyzeFrames = (state: ModelFailoverState) => createFrameAnalyst(createAgentModel(kimiEnv, 'visual', 'low', { model_role: 'visual_analyst' }, state))({
    signal: new AbortController().signal, modelCallId: 'frames', focus: 'Describe the boxes',
    frames: { videoId: 'abcdefghijk', frames: [{ imageBase64: images[0]!, timestampMs: 1000, mimeType: 'image/jpeg', width: 200, height: 100 }],
      failures: [], meta: { partial: false, warnings: [] } } });
  const respond = (stalled: string, requests: Array<{ model: string; reasoning_effort?: string; service_tier?: string }>) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (body.model === stalled) return new Promise(() => {});
      return sseResponse(body.model, JSON.stringify(output));
    });

  it('moves only visual analysis to DeepSeek when the visual model stalls, for the rest of the run', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requests: Array<{ model: string; reasoning_effort?: string; service_tier?: string }> = [];
    respond(kimi, requests);
    const state: ModelFailoverState = { fallback: false };
    const first = analyzeFrames(state);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await first).toEqual(output);
    expect(requests.map(request => request.model)).toEqual([kimi, deepseek]);
    expect(requests[0]).toMatchObject({ reasoning_effort: 'low', service_tier: 'priority' });
    // Research keeps GLM; the run-level switch belongs to the visual model alone.
    await generateText({ model: createAgentModel(kimiEnv, 'visual', 'low', { model_role: 'agent_core' }, state), prompt: 'continue' });
    expect(requests.at(-1)!.model).toBe(FIREWORKS_GLM_MODEL_ID);
    expect(state.fallback).toBe(false);
    // A later analysis in the same run goes straight to the backup instead of waiting on the stalled model again.
    expect(await analyzeFrames(state)).toEqual(output);
    expect(requests.at(-1)!.model).toBe(deepseek);
    expect(requests.filter(request => request.model === kimi)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the visual model during a GLM outage and shares the run deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requests: Array<{ model: string }> = [];
    respond(FIREWORKS_GLM_MODEL_ID, requests);
    const state: ModelFailoverState = { fallback: false };
    const research = generateText({ model: createAgentModel(kimiEnv, 'visual', 'low', { model_role: 'agent_core' }, state), prompt: 'research' });
    await vi.advanceTimersByTimeAsync(10_001);
    await research;
    expect(state.fallback).toBe(true);
    expect(await analyzeFrames(state)).toEqual(output);
    expect(requests.at(-1)!.model).toBe(kimi);
    // An expired run deadline stops the visual model as it stops every other role.
    state.deadlineAt = Date.now() - 1;
    await expect(analyzeFrames(state)).rejects.toThrow();
    expect(requests.at(-1)!.model).toBe(kimi);
    expect(vi.getTimerCount()).toBe(0);
  });
});
