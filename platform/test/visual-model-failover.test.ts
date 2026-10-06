import { generateText } from 'ai';
import { createAgentModel, FIREWORKS_GLM_MODEL_ID } from '../src/agents/model';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import type { ModelFailoverState } from '../src/agents/runtime/model-failover';

const deepseek = 'accounts/fireworks/models/deepseek-v4p1-flash';
const env = { AI_GATEWAY_ID: '', FIREWORKS_API_KEY: 'test-key', AGENT_GLM_PROVIDER: 'fireworks',
  AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_REASONING_EFFORT: 'medium' } as unknown as Env;
const images = ['/9j/2Q==', '/9j/3Q=='];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([['frames', false], ['frames', true], ['storyboard', false], ['storyboard', true]] as const)('takes over %s images with prior research fallback %s', async (kind, priorFallback) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const requests: Array<{ model: string; messages: unknown; service_tier: string; reasoning_effort: string; response_format: unknown }> = [];
  const output = { findings: [{ observation: 'Two colored boxes are visible.',
    ...(kind === 'frames' ? { timestampsMs: [1000, 5000] } : { frameIndexes: [0, 10] }) }], warnings: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.model === FIREWORKS_GLM_MODEL_ID) return new Promise(() => {});
    return Response.json({ id: 'backup', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
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
  await vi.advanceTimersByTimeAsync(8_001);
  expect(await task).toEqual(output);
  expect(requests.map(request => request.model)).toEqual(priorFallback ? [FIREWORKS_GLM_MODEL_ID, deepseek, deepseek] : [FIREWORKS_GLM_MODEL_ID, deepseek]);
  if (!priorFallback) expect(requests[1]!.messages).toEqual(requests[0]!.messages);
  expect(requests.at(-1)).toMatchObject({ service_tier: 'priority', reasoning_effort: 'none', response_format: { type: 'json_schema' } });
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
