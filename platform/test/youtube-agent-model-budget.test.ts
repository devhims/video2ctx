import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MODEL_COST_LIMIT_MICROS,
  shouldReserveCostForFinalization,
} from '../src/agents/runtime/model-budget';
import { estimateAgentModelCostMicros } from '../src/agents/model';

describe('YouTube agent model-cost budget', () => {
  it('prices uncached input, cached input, and output tokens separately', () => {
    expect(estimateAgentModelCostMicros(usage({
      inputTokens: 2_000_000,
      noCacheTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    }))).toBe(680_000);
  });

  it('treats input as uncached when the provider omits token details', () => {
    expect(estimateAgentModelCostMicros(usage({
      inputTokens: 1_000_000,
      outputTokens: 0,
    }))).toBe(150_000);
  });

  it('reserves the last ten cents for finalization', () => {
    expect(shouldReserveCostForFinalization(899_999)).toBe(false);
    expect(shouldReserveCostForFinalization(900_000)).toBe(true);
    expect(AGENT_MODEL_COST_LIMIT_MICROS).toBe(1_000_000);
  });
});

function usage(input: {
  inputTokens: number;
  noCacheTokens?: number;
  cacheReadTokens?: number;
  outputTokens: number;
}): LanguageModelUsage {
  return {
    inputTokens: input.inputTokens,
    inputTokenDetails: {
      noCacheTokens: input.noCacheTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: undefined,
    },
    outputTokens: input.outputTokens,
    outputTokenDetails: {
      textTokens: input.outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: input.inputTokens + input.outputTokens,
  };
}
