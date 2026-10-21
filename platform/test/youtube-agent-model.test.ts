import { generateText, streamText, APICallError, Output, tool, isStepCount } from 'ai';
import { withModelStreamFallback, type ModelAttemptDiagnostic } from '../src/agents/runtime/model-failover';
import { z } from 'zod';
import { finalizationOutputSchema } from '../src/agents/structured-answer';
import { fireworksFinalizerProfile, fireworksModelPricing } from '../src/agents/fireworks-finalizer';
import { chatCompletion, streamOf } from './fixtures/model-streams';
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
  FINALIZER_THINKING_TOKENS,
  createAgentModel,
  createClassifierFallbackModel,
} from '../src/agents/model';

describe('YouTube agent model', () => {
  test('sends the classifier fallback to DeepSeek with reasoning disabled, and only with a Fireworks key', async () => {
    // Production GLM settings must not leak into the fallback.
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', AGENT_TEXT_PROVIDER: '', AGENT_TEXT_MODEL: '',
      FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    expect(createClassifierFallbackModel({ ...env, FIREWORKS_API_KEY: '' } as unknown as Env, 'session')).toBeUndefined();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
      expect(body.reasoning_effort).toBe('none');
      expect(body.max_tokens).toBe(1000);
      expect(body.service_tier).toBe('priority');
      expect(body.tools[0].function.name).toBe('classify_request');
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'call', type: 'function', function: { name: 'classify_request', arguments: '{"route":"finalize"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    });
    try {
      const result = await generateText({ model: createClassifierFallbackModel(env, 'session')!, prompt: 'Classify.', maxOutputTokens: 1000,
        tools: { classify_request: tool({ inputSchema: z.object({ route: z.string() }) }) } });
      expect(result.toolCalls[0]?.input).toEqual({ route: 'finalize' });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { fetchMock.mockRestore(); }
  });

  test('defaults GLM to Fireworks and requires its secret without silently falling back', () => {
    const env = { AI_GATEWAY_ID: '', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    expect(createAgentModel(env, 'session', 'low', { model_role: 'classifier' }).modelId).toBe(FIREWORKS_GLM_MODEL_ID);
    expect(workersAI.create).not.toHaveBeenCalled();
    expect(() => createAgentModel({ ...env, FIREWORKS_API_KEY: undefined } as unknown as Env, 'session')).toThrow(/secret/);
  });

  test.each(['classifier', 'agent_core', 'transcript_analyst', 'visual_analyst'])('routes %s to Fireworks GLM with native low reasoning and the unchanged research ceiling', async role => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', AGENT_FINALIZER_PROVIDER: 'fireworks',
      AGENT_FINALIZER_MODEL: 'deepseek-v4p1-flash', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(FIREWORKS_GLM_MODEL_ID);
      expect(body.max_tokens).toBe(1600);
      expect(body.reasoning_effort).toBe('low');
      expect(body.reasoning_history).toBe('interleaved');
      expect(body.service_tier).toBe('priority');
      expect(body.prompt_cache_key).toBe('test-session');
      expect(body).not.toHaveProperty('thinking');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))).toBe(true);
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
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
        .toBe('accounts/fireworks/models/deepseek-v4p1-flash');
    } finally { fetchMock.mockRestore(); }
  });

  test.each(['classifier', 'agent_core', 'transcript_analyst', 'visual_analyst'])('routes production %s to its text or visual model', async role => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', AGENT_TEXT_PROVIDER: 'fireworks',
      AGENT_TEXT_MODEL: 'deepseek-v4p1-flash', AGENT_VISUAL_MODEL: 'kimi-k3', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    const visual = role === 'visual_analyst';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(visual ? 'accounts/fireworks/models/kimi-k3' : 'accounts/fireworks/models/deepseek-v4p1-flash');
      // The reasoning visual model gets reasoning headroom; DeepSeek text extraction has reasoning off.
      expect(body.max_tokens).toBe(visual ? 1600 + FINALIZER_THINKING_TOKENS : 1600);
      expect(body.service_tier).toBe('priority');
      expect(body.prompt_cache_key).toBe('session');
      expect(body.reasoning_history).toBe('interleaved');
      expect(body.response_format.type).toBe('json_schema');
      if (visual) {
        expect(body.reasoning_effort).toBe('low');
        expect(body).not.toHaveProperty('thinking');
        expect(body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))).toBe(true);
      } else {
        expect(body.reasoning_effort).toBe('none');
        expect(body).not.toHaveProperty('thinking');
        expect(JSON.stringify(body.messages)).not.toContain('image_url');
      }
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"supported":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    });
    try {
      await generateText({ model: createAgentModel(env, 'session', 'low', { model_role: role }),
        messages: [{ role: 'user', content: visual
          ? [{ type: 'text', text: 'Inspect this frame.' }, { type: 'file', data: '/9j/2Q==', mediaType: 'image/jpeg' }]
          : [{ type: 'text', text: 'Analyze the supplied text.' }] }],
        output: Output.object({ schema: z.object({ supported: z.boolean() }) }), maxOutputTokens: 1600 });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { fetchMock.mockRestore(); }
  });

  test('retains the native low reasoning profile for GPT-OSS text roles', async () => {
    const env = { AI_GATEWAY_ID: '', AGENT_TEXT_MODEL: 'gpt-oss-120b', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('accounts/fireworks/models/gpt-oss-120b');
      expect(body.reasoning_effort).toBe('low');
      expect(body.max_tokens).toBe(2624);
      expect(body).not.toHaveProperty('thinking');
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    });
    try {
      await generateText({ model: createAgentModel(env, 'session', 'low', { model_role: 'transcript_analyst' }),
        prompt: 'Public evidence', maxOutputTokens: 1600 });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { fetchMock.mockRestore(); }
  });

  test('rejects invalid text model configuration without silently switching models', () => {
    const env = { AI_GATEWAY_ID: '', AGENT_TEXT_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: 'unknown',
      FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'transcript_analyst' })).toThrow(/Unsupported/);
    Object.assign(env, { AGENT_TEXT_MODEL: undefined });
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'classifier' })).toThrow(/not configured/);
    Object.assign(env, { AGENT_TEXT_MODEL: 'deepseek-v4p1-flash', AGENT_TEXT_PROVIDER: 'unknown' });
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'agent_core' })).toThrow(/Unsupported agent text provider/);
    Object.assign(env, { AGENT_TEXT_PROVIDER: 'fireworks', FIREWORKS_API_KEY: undefined });
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'transcript_analyst' })).toThrow(/secret/);
  });

  test.each([undefined, 'deepseek-v4p1-flash'])('preserves reasoning and native tool results across Fireworks research steps for %s', async textModel => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: textModel,
      FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls++;
      if (calls === 2) {
        expect(body.messages.find((m: any) => m.role === 'assistant').reasoning_content).toBe('Inspect a sampled frame.');
        expect(body.messages.some((m: any) => m.role === 'tool')).toBe(true);
      }
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
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
  test.each(['gpt-oss-120b', 'deepseek-v4p1-flash', 'deepseek-v4-flash-0731'])('uses native settings and prices for %s', async name => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'workers-ai', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    Object.assign(env, { AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: name });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(`accounts/fireworks/models/${name}`);
      expect(body.max_tokens).toBe(3524);
      expect(body.service_tier).toBe('priority');
      expect(body.prompt_cache_key).toBe('session');
      if (name === 'gpt-oss-120b') {
        expect(body.reasoning_effort).toBe('low');
        expect(body).not.toHaveProperty('thinking');
      } else {
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
        expect(body).not.toHaveProperty('reasoning_effort');
      }
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } });
    });
    try {
      await generateText({ model: createAgentModel(env, 'session', 'low', { model_role: 'finalizer' }),
        prompt: 'Public evidence', maxOutputTokens: 2500 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fireworksModelPricing(`accounts/fireworks/models/${name}`)?.outputUsdPerMillionTokens)
        .toBe(name === 'gpt-oss-120b' ? 0.72 : name === 'deepseek-v4p1-flash' ? 1.5 : 0.825);
      expect(createAgentModel(env, 'session', 'low', { model_role: 'classifier' }).modelId).toBe('glm');
    } finally { fetchMock.mockRestore(); }
  });

  test.each(['low', 'medium'])('sets GLM finalizer effort to %s without changing research', async effort => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'test-key',
      AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash',
      AGENT_FINALIZER_REASONING_EFFORT: effort } as unknown as Env;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(FIREWORKS_GLM_MODEL_ID);
      expect(body.reasoning_effort).toBe(effort === 'medium' ? 'high' : 'low');
      expect(body.max_tokens).toBe(3524);
      expect(body).not.toHaveProperty('thinking');
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } });
    });
    try {
      await generateText({ model: createAgentModel(env, 'session', 'low', { model_role: 'finalizer' }),
        prompt: 'Public evidence', maxOutputTokens: 2500 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(createAgentModel(env, 'session', 'low', { model_role: 'transcript_analyst' }).modelId)
        .toBe(FIREWORKS_GLM_MODEL_ID);
    } finally { fetchMock.mockRestore(); }
  });

  test('rejects unsupported finalizer effort and applying GLM effort to DeepSeek', () => {
    const env = { AI_GATEWAY_ID: '', FIREWORKS_API_KEY: 'test-key', AGENT_FINALIZER_PROVIDER: 'fireworks',
      AGENT_FINALIZER_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_REASONING_EFFORT: 'max' } as unknown as Env;
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'finalizer' })).toThrow(/Unsupported finalizer reasoning/);
    Object.assign(env, { AGENT_FINALIZER_MODEL: 'deepseek-v4p1-flash', AGENT_FINALIZER_REASONING_EFFORT: 'medium' });
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'finalizer' })).toThrow(/requires GLM/);
  });

  test('routes the visual analyst to GLM Flash when no visual model is configured', () => {
    const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', AGENT_VISUAL_MODEL: '', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    expect(createAgentModel(env, 'session', 'low', { model_role: 'visual_analyst' }).modelId).toBe(FIREWORKS_GLM_MODEL_ID);
    // Other roles never use the visual model.
    Object.assign(env, { AGENT_VISUAL_MODEL: 'kimi-k3' });
    expect(createAgentModel(env, 'session', 'low', { model_role: 'agent_core' }).modelId).toBe(FIREWORKS_GLM_MODEL_ID);
    expect(createAgentModel(env, 'session', 'low', { model_role: 'visual_analyst' }).modelId).toBe('accounts/fireworks/models/kimi-k3');
    Object.assign(env, { AGENT_VISUAL_MODEL: 'unknown-model' });
    expect(() => createAgentModel(env, 'session', 'low', { model_role: 'visual_analyst' })).toThrow(/Unsupported/);
  });

  test('accounts for Kimi K3 Priority prices so visual analysis is not priced as GLM', () => {
    expect(fireworksModelPricing('accounts/fireworks/models/kimi-k3')).toEqual({
      uncachedInputUsdPerMillionTokens: 3.75, cachedInputUsdPerMillionTokens: .375, outputUsdPerMillionTokens: 18.75,
    });
  });

  test('accounts for Priority input, cache, and output prices for both production models', () => {
    expect(fireworksModelPricing(FIREWORKS_GLM_MODEL_ID)).toEqual({
      uncachedInputUsdPerMillionTokens: .1875, cachedInputUsdPerMillionTokens: .0375, outputUsdPerMillionTokens: .625,
    });
    expect(fireworksModelPricing('accounts/fireworks/models/deepseek-v4p1-flash')).toEqual({
      uncachedInputUsdPerMillionTokens: .375, cachedInputUsdPerMillionTokens: .0075, outputUsdPerMillionTokens: 1.5,
    });
  });

  test('rejects unknown model profiles and does not invent their pricing', () => {
    expect(() => fireworksFinalizerProfile('unknown')).toThrow(/Unsupported/);
    expect(() => fireworksFinalizerProfile('toString')).toThrow(/Unsupported/);
    expect(fireworksModelPricing('unknown')).toBeUndefined();
  });

  test('sends native bounded thinking and a combined budget only for the Fireworks finalizer', async () => {
    const env = { AI_GATEWAY_ID: 'all-things-youtube', AGENT_GLM_PROVIDER: 'workers-ai', FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    Object.assign(env, { AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'deepseek-v4p1-flash' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(3524);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
      expect(body.service_tier).toBe('priority');
      expect(body.prompt_cache_key).toBe('session');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body.model).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
      expect(body.response_format.type).toBe('json_schema');
      return chatCompletion(body, { id: 'test', created: 1, model: body.model,
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
    workersAI.selectedModel.doStream
      .mockRejectedValueOnce(new APICallError({ message: 'private body', url: 'https://private', requestBodyValues: {}, statusCode: 503, isRetryable: true }))
      .mockResolvedValueOnce(streamOf({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }));
    try {
      const model = createAgentModel({ AI: {}, AGENT_GLM_PROVIDER: 'workers-ai', AI_GATEWAY_ID: '' } as unknown as Env, 'session', 'low', { agent_run_id: 'run', model_role: 'transcript_analyst' });
      await generateText({ model, prompt: 'private prompt', maxRetries: 1,
        providerOptions: { agentDiagnostics: { videoId: 'video', modelCallId: 'call', analysisAttempt: 1 } } });
      const records = log.mock.calls.map(([entry]) => JSON.parse(entry));
      expect(records.map(record => record.phase)).toEqual(['attempt_started', 'attempt_finished', 'attempt_started', 'attempt_finished']);
      expect(records.filter(record => record.phase === 'attempt_finished').map(record => record.outcome)).toEqual(['failed', 'succeeded']);
      expect(records[1]).toMatchObject({ statusCode: 503, retryable: true, runId: 'run', videoId: 'video', modelCallId: 'call' });
      expect(records[0].attemptId).not.toBe(records[2].attemptId);
      expect(records[0]).toMatchObject({ firstContentTimeoutMs: 10_000, totalTimeoutMs: 30_000 });
      expect(records[0]).not.toHaveProperty('serviceTier');
      expect(JSON.stringify(records)).not.toContain('private');
    } finally { log.mockRestore(); }
 });

it.each(['classifier', 'agent_core', 'transcript_analyst', 'visual_analyst', 'memory_updater', 'finalizer'])('falls back %s to DeepSeek Priority with its own provider options and model identity', async role => {
  const env = { AI_GATEWAY_ID: '', AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'test-key',
    AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_REASONING_EFFORT: 'medium' } as unknown as Env;
  const requests: Record<string, any>[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.model === FIREWORKS_GLM_MODEL_ID) return Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 });
    return chatCompletion(body, { id: 'backup', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  });
  try {
    const model = createAgentModel(env, 'session', 'low', { model_role: role });
    const result = await generateText({ model, prompt: 'test', maxOutputTokens: 100 });
    expect(result.response.modelId).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ model: 'accounts/fireworks/models/deepseek-v4p1-flash', service_tier: 'priority', prompt_cache_key: 'session' });
    if (role === 'finalizer') {
      expect(requests[1]).not.toHaveProperty('reasoning_effort');
      expect(requests[1]?.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    } else expect(requests[1]?.reasoning_effort).toBe('none');
  } finally { fetchMock.mockRestore(); }
});

const timeoutCases = ['glm-5p3-flash', 'deepseek-v4p1-flash', 'gpt-oss-120b', 'workers-ai'].flatMap(name =>
  (['generate', 'stream'] as const).flatMap(mode => (['first_content', 'overall'] as const).map(limit => [name, mode, limit] as const)));

it.each(timeoutCases)('enforces the same %s %s %s timeout through model selection', async (name, mode, limit) => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const signals: AbortSignal[] = [];
  const diagnostics: ModelAttemptDiagnostic[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    signals.push(init!.signal!);
    if (limit === 'first_content') return new Promise(() => {});
    const body = JSON.parse(String(init?.body));
    const chunk = { id: 'chatcmpl-timeout-test', created: 1, model: body.model,
      choices: [{ index: 0, delta: { content: 'Partial answer' } }] };
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  if (name === 'workers-ai') workersAI.selectedModel.doStream.mockImplementation(async (params: { abortSignal: AbortSignal }) => {
    signals.push(params.abortSignal);
    if (limit === 'first_content') return new Promise(() => {});
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'text-start', id: 'answer' });
      controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Partial answer' });
    } }) };
  });
  try {
    const env = { AI_GATEWAY_ID: '', AGENT_FINALIZER_PROVIDER: name === 'workers-ai' ? 'workers-ai' : 'fireworks', AGENT_FINALIZER_MODEL: name,
      FIREWORKS_API_KEY: 'test-key' } as unknown as Env;
    const model = createAgentModel(env, 'timeout-test', 'low', { model_role: 'finalizer' }, {
      fallback: false, deadlineAt: Date.now() + 60_000, onDiagnostic: event => diagnostics.push(event),
    });
    const run = async () => {
      if (mode === 'generate') return generateText({ model, prompt: 'Test', maxRetries: 0 });
      return withModelStreamFallback(async failoverCallId => {
        let error: unknown;
        const result = streamText({ model, prompt: 'Test', maxRetries: 0,
          providerOptions: { agentDiagnostics: { failoverCallId } }, onError: event => { error = event.error; } });
        await result.consumeStream();
        if (error) throw error;
        return result.text;
      });
    };
    const task = run().catch(error => error);
    const elapsedMs = limit === 'first_content' ? 10_000 : 30_000;
    await vi.advanceTimersByTimeAsync(elapsedMs + 1);
    expect(signals[0]?.aborted).toBe(true);
    expect(diagnostics.find(event => event.outcome === 'failed')).toMatchObject({
      modelId: name === 'workers-ai' ? 'glm' : `accounts/fireworks/models/${name}`, role: 'finalizer', elapsedMs,
      reason: limit === 'first_content' ? 'first_content_timeout' : 'attempt_timeout',
      firstContentTimeoutMs: 10_000, totalTimeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await task).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  } finally { workersAI.selectedModel.doStream.mockReset(); fetchMock.mockRestore(); log.mockRestore(); vi.useRealTimers(); }
});
