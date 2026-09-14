export const FRAME_EXTRACTION_MAX_MS = 45_000;
export const FRAME_EXTRACTION_MIN_MS = 5_000;
// 20s analyst, 5s transport/cleanup, 5s preview saving and handoff.
export const FRAME_COMPLETION_RESERVE_MS = 30_000;

export function frameExtractionBudget(deadlineAt?: number): number {
  return Math.max(0, Math.min(FRAME_EXTRACTION_MAX_MS,
    deadlineAt === undefined ? FRAME_EXTRACTION_MAX_MS : deadlineAt - Date.now() - FRAME_COMPLETION_RESERVE_MS));
}
