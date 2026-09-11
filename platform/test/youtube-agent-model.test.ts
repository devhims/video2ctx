import { generateText, APICallError, Output, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { finalizationOutputSchema } from '../src/agents/structured-answer';
import { fireworksFinalizerProfile, fireworksModelPricing } from '../src/agents/fireworks-finalizer';
const workersAI = vi.hoisted(() => {
  const selectedModel = { specificationVersion: 'v4', provider: 'test', modelId: 'glm', supportedUrls: {}, doGenerate: vi.fn(), doStream: vi.fn() };
  const select = vi.fn(() => selectedModel);
  const create = vi.fn(() => select);
  return { create, select, selectedModel };
});

vi.mock('workers-ai-provider', () => ({ createWorkersAI: workersAI.create }));

import {
  AGENT_MODEL_ID,
  AGENT_MODEL_PRICING,
  FIREWORKS_GLM_MODEL_ID,
  createAgentModel,
} from '../src/agents/model';

describe('YouTube agent model', () => {
  test('defaults GLM to Fireworks and requires its secret without silently falling back', () => {
    const env = { AI_GATEWAY_ID: '', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    expect(createAgentModel(env, 'session', 'low', { model_role: 'classifier' }).modelId).toBe(FIREWORKS_GLM_MODEL_ID);
    expect(workersAI.create).not.toHaveBeenCalled();
    expect(() => createAgentModel({ ...env, FIREWORKS_API_KEY: undefined } as unknown as Env, 'session')).toThrow(/secret/);
  });

  test.each(['classifier', 'agent_core', 'transcript_analyst', 'visual_analyst'])('routes %s to Fireworks GLM with native low reasoning and the unchanged research ceiling', async role => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', AGENT_FINALIZER_PROVIDER: 'fireworks',
      AGENT_FINALIZER_MODEL: 'deepseek-v4-flash-0731', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(FIREWORKS_GLM_MODEL_ID);
      expect(body.max_tokens).toBe(1600);
      expect(body.reasoning_effort).toBe('low');
      expect(body.reasoning_history).toBe('interleaved');
      expect(body.prompt_cache_key).toBe('test-session');
      expect(body).not.toHaveProperty('thinking');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))).toBe(true);
      return Response.json({ id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"visible":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    });
    try {
      await generateText({ model: createAgentModel(env, 'test-session', 'low', { model_role: role }),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect this frame.' },
          { type: 'file', data: '/9j/2Q==', mediaType: 'image/jpeg' }] }],
        output: Output.object({ schema: z.object({ visible: z.boolean() }) }), maxOutputTokens: 1600 });
      expect(workersAI.create).not.toHaveBeenCalled();
      expect(createAgentModel(env, 'test-session', 'low', { model_role: 'finalizer' }).modelId)
        .toBe('accounts/fireworks/models/deepseek-v4-flash-0731');
    } finally { fetchMock.mockRestore(); }
  });

  test('preserves reasoning and native tool results across Fireworks research steps', async () => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls++;
      if (calls === 2) {
        expect(body.messages.find((m: any) => m.role === 'assistant').reasoning_content).toBe('Inspect a sampled frame.');
        expect(body.messages.some((m: any) => m.role === 'tool')).toBe(true);
      }
      return Response.json({ id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: calls === 1 ? 'tool_calls' : 'stop', message: calls === 1
          ? { role: 'assistant', content: null, reasoning_content: 'Inspect a sampled frame.', tool_calls: [{ id: 'inspect-1', type: 'function', function: { name: 'inspect', arguments: '{"timestampMs":905000}' } }] }
          : { role: 'assistant', content: 'The presenter is on the right.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    });
    try {
      const execute = vi.fn(async () => ({ visible: 'presenter on right' }));
      await generateText({ model: createAgentModel(env, 'tools', 'low', { model_role: 'agent_core' }), prompt: 'Inspect 15:05',
        tools: { inspect: tool({ inputSchema: z.object({ timestampMs: z.number() }), execute }) }, stopWhen: isStepCount(2) });
      expect(calls).toBe(2); expect(execute).toHaveBeenCalledOnce();
    } finally { fetchMock.mockRestore(); }
  });

  test('fails explicitly for missing GLM credentials or an unknown provider', () => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks' } as unknown as Env;
    expect(() => createAgentModel(env, 'test', 'low', { model_role: 'classifier' })).toThrow(/secret/);
    Object.assign(env, { AGENT_GLM_PROVIDER: 'unknown' });
    expect(() => createAgentModel(env, 'test')).toThrow(/Unsupported agent GLM provider/);
  });
  test.each(['gpt-oss-120b', 'deepseek-v4-flash-0731'])('uses native settings and prices for %s', async name => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'workers-ai', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    Object.assign(env, { AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: name });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(`accounts/fireworks/models/${name}`);
      expect(body.max_tokens).toBe(3524);
      if (name === 'gpt-oss-120b') {
        expect(body.reasoning_effort).toBe('low');
        expect(body).not.toHaveProperty('thinking');
      } else {
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
        expect(body).not.toHaveProperty('reasoning_effort');
      }
      return Response.json({ id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } });
    });
    try {
      await generateText({ model: createAgentModel(env, 'session', 'low', { model_role: 'finalizer' }),
        prompt: 'Public evidence', maxOutputTokens: 2500 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fireworksModelPricing(`accounts/fireworks/models/${name}`)?.outputUsdPerMillionTokens)
        .toBe(name === 'gpt-oss-120b' ? 0.6 : 0.66);
      expect(createAgentModel(env, 'session', 'low', { model_role: 'classifier' }).modelId).toBe('glm');
    } finally { fetchMock.mockRestore(); }
  });

  test('rejects unknown model profiles and does not invent their pricing', () => {
    expect(() => fireworksFinalizerProfile('unknown')).toThrow(/Unsupported/);
    expect(() => fireworksFinalizerProfile('toString')).toThrow(/Unsupported/);
    expect(fireworksModelPricing('unknown')).toBeUndefined();
  });

  test('sends native bounded thinking and a combined budget only for the Fireworks finalizer', async () => {
    const env = { AI_GATEWAY_ID: 'all-things-youtube', AGENT_GLM_PROVIDER: 'workers-ai', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    Object.assign(env, { AGENT_FINALIZER_PROVIDER: 'fireworks' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(3524);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body.response_format.type).toBe('json_schema');
      return Response.json({ id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
          confidence: 'medium', warnings: [], blocks: [{ text: 'Supported answer.', evidenceIds: ['ref_1'] }],
        }) } }], usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } });
    });
    try {
      const model = createAgentModel(env, 'session', 'low', { model_role: 'finalizer' });
      await generateText({ model, prompt: 'Public evidence', output: Output.object({ schema: finalizationOutputSchema }), maxOutputTokens: 2500 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const research = createAgentModel(env, 'session', 'low', { model_role: 'agent_core' });
      expect(research.modelId).toBe('glm');
    } finally { fetchMock.mockRestore(); }
  });

  test('fails explicitly when the selected Fireworks provider has no secret', () => {
    const env = { AI_GATEWAY_ID: 'all-things-youtube' } as Env;
    Object.assign(env, { AGENT_FINALIZER_PROVIDER: 'fireworks' });
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'finalizer' })).toThrow(/secret/);
  });
  beforeEach(() => {
    workersAI.create.mockClear();
    workersAI.select.mockClear();
  });

  test('uses GLM 5.3 Flash and its published Workers AI token prices', () => {
    expect(AGENT_MODEL_ID).toBe('@cf/zai-org/glm-5.3-flash');
    expect(AGENT_MODEL_PRICING).toEqual({
      uncachedInputUsdPerMillionTokens: 0.15,
      cachedInputUsdPerMillionTokens: 0.03,
      outputUsdPerMillionTokens: 0.5,
    });
  });

  test('uses direct Workers AI when no gateway is configured', () => {
    const binding = {} as Ai;
    const model = createAgentModel(
      { AI: binding, AGENT_GLM_PROVIDER: 'workers-ai', AI_GATEWAY_ID: '  ' } as unknown as Env,
      'conversation-1',
      'low',
    );

    expect(model.modelId).toBe('glm');
    expect(workersAI.create).toHaveBeenCalledWith({ binding });
    expect(workersAI.select).toHaveBeenCalledWith(AGENT_MODEL_ID, {
      sessionAffinity: 'conversation-1',
      reasoning_effort: 'low',
    });
  });

  test('uses the configured AI Gateway when its identifier is present', () => {
    const binding = {} as Ai;
    createAgentModel(
      { AI: binding, AGENT_GLM_PROVIDER: 'workers-ai', AI_GATEWAY_ID: ' agent-gateway ' } as unknown as Env,
      'conversation-2',
    );

    expect(workersAI.create).toHaveBeenCalledWith({
      binding,
      gateway: { id: 'agent-gateway' },
    });
    expect(workersAI.select).toHaveBeenCalledWith(AGENT_MODEL_ID, {
      sessionAffinity: 'conversation-2',
      reasoning_effort: 'medium',
    });
  });
});

 test('logs each SDK retry with run and video correlation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    workersAI.selectedModel.doGenerate
      .mockRejectedValueOnce(new APICallError({ message: 'private body', url: 'https://private', requestBodyValues: {}, statusCode: 503, isRetryable: true }))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] });
    try {
      const model = createAgentModel({ AI: {}, AGENT_GLM_PROVIDER: 'workers-ai', AI_GATEWAY_ID: '' } as unknown as Env, 'session', 'low', { agent_run_id: 'run', model_role: 'transcript_analyst' });
      await generateText({ model, prompt: 'private prompt', maxRetries: 1,
        providerOptions: { agentDiagnostics: { videoId: 'video', modelCallId: 'call', analysisAttempt: 1 } } });
      const records = log.mock.calls.map(([entry]) => JSON.parse(entry));
      expect(records.map(record => record.outcome)).toEqual(['started', 'failed', 'started', 'succeeded']);
      expect(records[1]).toMatchObject({ statusCode: 503, retryable: true, runId: 'run', videoId: 'video', modelCallId: 'call' });
      expect(records[0].attemptId).not.toBe(records[2].attemptId);
      expect(JSON.stringify(records)).not.toContain('private');
    } finally { log.mockRestore(); }
 });
