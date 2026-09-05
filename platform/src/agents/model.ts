import { createWorkersAI } from 'workers-ai-provider';
import type { LanguageModelUsage } from 'ai';
import { estimateModelCostMicros } from './runtime/model-budget';

export const AGENT_MODEL_ID = '@cf/zai-org/glm-5.3-flash';
export const AGENT_MODEL_PRICING = {
  uncachedInputUsdPerMillionTokens: 0.15,
  cachedInputUsdPerMillionTokens: 0.03,
  outputUsdPerMillionTokens: 0.5,
} as const;

export function estimateAgentModelCostMicros(usage: LanguageModelUsage): number {
  return estimateModelCostMicros(usage, AGENT_MODEL_PRICING);
}

export function createAgentModel(
  env: Env,
  sessionAffinity: string,
  reasoningEffort: 'low' | 'medium' = 'medium',
  metadata?: Record<string, string | number | boolean | null>,
) {
  const gatewayId = env.AI_GATEWAY_ID.trim();
  const workersAI = createWorkersAI({
    binding: env.AI,
    ...(gatewayId ? {
      gateway: {
        id: gatewayId,
        ...(metadata ? { metadata } : {}),
      },
    } : {}),
  });
  return workersAI(AGENT_MODEL_ID, {
    sessionAffinity,
    reasoning_effort: reasoningEffort,
  });
}
