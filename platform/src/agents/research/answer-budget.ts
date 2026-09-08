import type { CapabilityRouteDecision } from '../contracts';

/** Shared by natural tool answers, reserved synthesis, and answer-argument repair. */
export function answerOutputTokenLimit(decision: CapabilityRouteDecision): number {
  return 'answerDetail' in decision && decision.answerDetail === 'detailed' ? 2_500 : 1_500;
}
