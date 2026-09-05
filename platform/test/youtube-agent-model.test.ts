import { generateText, APICallError } from 'ai';
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
  createAgentModel,
} from '../src/agents/model';

describe('YouTube agent model', () => {
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
      { AI: binding, AI_GATEWAY_ID: '  ' } as unknown as Env,
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
      { AI: binding, AI_GATEWAY_ID: ' agent-gateway ' } as unknown as Env,
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
      const model = createAgentModel({ AI: {}, AI_GATEWAY_ID: '' } as unknown as Env, 'session', 'low', { agent_run_id: 'run', model_role: 'transcript_analyst' });
      await generateText({ model, prompt: 'private prompt', maxRetries: 1,
        providerOptions: { agentDiagnostics: { videoId: 'video', modelCallId: 'call', analysisAttempt: 1 } } });
      const records = log.mock.calls.map(([entry]) => JSON.parse(entry));
      expect(records.map(record => record.outcome)).toEqual(['started', 'failed', 'started', 'succeeded']);
      expect(records[1]).toMatchObject({ statusCode: 503, retryable: true, runId: 'run', videoId: 'video', modelCallId: 'call' });
      expect(records[0].attemptId).not.toBe(records[2].attemptId);
      expect(JSON.stringify(records)).not.toContain('private');
    } finally { log.mockRestore(); }
 });
