const workersAI = vi.hoisted(() => {
  const selectedModel = { specificationVersion: 'v3' };
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

    expect(model).toBe(workersAI.selectedModel);
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
