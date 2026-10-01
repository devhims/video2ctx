// Includes saved-image reads, the 20s analyst, validation and model handoff.
export const STORYBOARD_COMPLETION_RESERVE_MS = 35_000;
export const STORYBOARD_RETRIEVAL_MAX_MS = 45_000;
export const STORYBOARD_RETRIEVAL_MIN_MS = 5_000;
export const STORYBOARD_ANALYSIS_MIN_MS = 25_000;

export function storyboardRetrievalBudget(deadlineAt?: number): number {
  return Math.max(0, Math.min(STORYBOARD_RETRIEVAL_MAX_MS,
    deadlineAt === undefined ? STORYBOARD_RETRIEVAL_MAX_MS : deadlineAt - Date.now() - STORYBOARD_COMPLETION_RESERVE_MS));
}

export function canAnalyzeStoryboard(deadlineAt?: number): boolean {
  return deadlineAt === undefined || deadlineAt - Date.now() >= STORYBOARD_ANALYSIS_MIN_MS;
}
