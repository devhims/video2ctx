import type { LanguageModelUsage } from 'ai';

export const AGENT_MODEL_COST_LIMIT_MICROS = 1_000_000;
export const FINALIZATION_COST_RESERVE_MICROS = 100_000;

export interface ModelTokenPricing {
  uncachedInputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export type AgentModelUsageCategory =
  | 'classifier'
  | 'agent_core'
  | 'tool_repair'
  | 'transcript_analyst'
  | 'visual_analyst'
  | 'timeout_finalizer'
  | 'citation_repair';

export interface AgentModelUsageEntry {
  callId: string;
  category: AgentModelUsageCategory;
  usage: LanguageModelUsage;
  modelId?: string;
  pricing?: ModelTokenPricing;
}

export interface AgentModelCostBudget {
  readonly limitMicros: number;
  currentCostMicros(): number;
  recordUsage(entry: AgentModelUsageEntry): void;
}

export function estimateModelCostMicros(
  usage: LanguageModelUsage,
  pricing: ModelTokenPricing,
): number {
  const cachedInputTokens = nonNegative(usage.inputTokenDetails.cacheReadTokens);
  const totalInputTokens = nonNegative(usage.inputTokens);
  const uncachedInputTokens = usage.inputTokenDetails.noCacheTokens === undefined
    ? Math.max(0, totalInputTokens - cachedInputTokens)
    : nonNegative(usage.inputTokenDetails.noCacheTokens);
  const outputTokens = nonNegative(usage.outputTokens);

  return Math.ceil(
    uncachedInputTokens * pricing.uncachedInputUsdPerMillionTokens
    + cachedInputTokens * pricing.cachedInputUsdPerMillionTokens
    + outputTokens * pricing.outputUsdPerMillionTokens,
  );
}

export function shouldReserveCostForFinalization(
  currentCostMicros: number,
  limitMicros = AGENT_MODEL_COST_LIMIT_MICROS,
  reserveMicros = FINALIZATION_COST_RESERVE_MICROS,
): boolean {
  return currentCostMicros >= Math.max(0, limitMicros - reserveMicros);
}

export function assertModelCostAvailable(budget: AgentModelCostBudget | undefined): void {
  if (!budget || budget.currentCostMicros() < budget.limitMicros) return;
  throw new Error('The agent run has exhausted its $1 estimated model-cost budget.');
}

function nonNegative(value: number | undefined): number {
  return Math.max(0, value ?? 0);
}
