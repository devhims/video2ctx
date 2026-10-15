import { AGENT_VISUAL_ANALYSIS_TIMEOUT_MS } from './deadline';

export const FRAME_EXTRACTION_MAX_MS = 45_000;
export const FRAME_EXTRACTION_MIN_MS = 5_000;
// Analyst attempt and fallback, plus transport, preview saving and handoff.
export const FRAME_COMPLETION_RESERVE_MS = AGENT_VISUAL_ANALYSIS_TIMEOUT_MS + 10_000;

export function frameExtractionBudget(deadlineAt?: number): number {
  return Math.max(0, Math.min(FRAME_EXTRACTION_MAX_MS,
    deadlineAt === undefined ? FRAME_EXTRACTION_MAX_MS : deadlineAt - Date.now() - FRAME_COMPLETION_RESERVE_MS));
}
