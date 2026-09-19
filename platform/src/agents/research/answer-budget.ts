import type { CapabilityRouteDecision } from '../contracts';

/** Research generations and terminal-tool argument repair retain their ceiling. */
export function answerOutputTokenLimit(decision: CapabilityRouteDecision): number {
  return 'answerDetail' in decision && decision.answerDetail === 'detailed' ? 2_500 : 1_500;
}

/** Structured JSON and citations need room beyond the visible answer text. */
export function finalizationOutputTokenLimit(decision: CapabilityRouteDecision, repair = false): number {
  const base = 'answerDetail' in decision && decision.answerDetail === 'detailed' ? 4_000 : 3_000;
  return repair ? base + 1_000 : base;
}

export const FINALIZATION_CONTEXT_TIMEOUT_MS = 10_000;
export const FINALIZATION_REPAIR_RESERVE_MS = 20_000;
