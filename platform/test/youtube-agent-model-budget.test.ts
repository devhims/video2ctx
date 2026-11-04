import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MODEL_COST_LIMIT_MICROS,
  estimateModelCostMicros,
  shouldReserveCostForFinalization,
} from '../src/agents/runtime/model-budget';
import { agentModelPricing, estimateAgentModelCostMicros, TERRA_VISUAL_MODEL } from '../src/agents/model';

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

  it('bills Terra cache writes at the write rate', () => {
    // Usage from a live six-frame Terra call: nearly all input is reported as cache writes.
    expect(estimateModelCostMicros(usage({
      inputTokens: 16_070,
      noCacheTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 16_067,
      outputTokens: 204,
    }), agentModelPricing(TERRA_VISUAL_MODEL)!)).toBe(21_107);
  });

  it('bills cache writes as uncached input without a separate rate, and never twice', () => {
    const pricing = { uncachedInputUsdPerMillionTokens: 1, cachedInputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0 };
    expect(estimateModelCostMicros(usage({ inputTokens: 1_000, noCacheTokens: 400, cacheWriteTokens: 600, outputTokens: 0 }), pricing)).toBe(1_000);
    expect(estimateModelCostMicros(usage({ inputTokens: 1_000, cacheReadTokens: 100, cacheWriteTokens: 600, outputTokens: 0 }), pricing)).toBe(910);
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
  cacheWriteTokens?: number;
  outputTokens: number;
}): LanguageModelUsage {
  return {
    inputTokens: input.inputTokens,
    inputTokenDetails: {
      noCacheTokens: input.noCacheTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    },
    outputTokens: input.outputTokens,
    outputTokenDetails: {
      textTokens: input.outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: input.inputTokens + input.outputTokens,
  };
}
