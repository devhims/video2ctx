import { AGENT_VISUAL_ANALYSIS_TIMEOUT_MS } from './deadline';

// Includes saved-image reads, analyst attempt and fallback, validation and handoff.
export const STORYBOARD_COMPLETION_RESERVE_MS = AGENT_VISUAL_ANALYSIS_TIMEOUT_MS + 15_000;
export const STORYBOARD_RETRIEVAL_MAX_MS = 45_000;
export const STORYBOARD_RETRIEVAL_MIN_MS = 5_000;
// Keep time to validate saved assets and publish completed findings before research aborts.
export const STORYBOARD_ANALYSIS_HANDOFF_MS = 5_000;
export const STORYBOARD_ANALYSIS_MIN_MS = 25_000;

export function storyboardRetrievalBudget(deadlineAt?: number): number {
  return Math.max(0, Math.min(STORYBOARD_RETRIEVAL_MAX_MS,
    deadlineAt === undefined ? STORYBOARD_RETRIEVAL_MAX_MS : deadlineAt - Date.now() - STORYBOARD_COMPLETION_RESERVE_MS));
}

export function canAnalyzeStoryboard(deadlineAt?: number): boolean {
  return deadlineAt === undefined || deadlineAt - Date.now() >= STORYBOARD_ANALYSIS_MIN_MS;
}
