import type { CapabilityRouteDecision } from '../contracts';

export const MAX_TOPIC_RESEARCH_TRANSCRIPT_ANALYSES = 8;
export function researchVideoTarget(decision: CapabilityRouteDecision): number {
  if ('comparisonVideoIds' in decision && decision.comparisonVideoIds?.length) return decision.comparisonVideoIds.length;
  if (decision.route === 'inspect_video') return 1;
  if (decision.route !== 'topic_research') return 0;
  // Older persisted decisions predate explicit video counts.
  return decision.researchVideoCount ?? (decision.researchBreadth === 'comparative' ? 4 : 2);
}
