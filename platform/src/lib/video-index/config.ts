import { DEFAULT_CHAPTER_MINUTES } from './chapters';
import { DEFAULT_EVIDENCE_TOKENS } from './pack';

/** full: today's path. shadow: build indexes and log what retrieval would select. index: use it. */
export type TranscriptRetrievalMode = 'full' | 'shadow' | 'index';
export type TranscriptRouter = 'classifier' | 'jev';

interface VideoIndexEnv {
  AGENT_TRANSCRIPT_RETRIEVAL?: string;
  AGENT_INDEX_EVIDENCE_TOKENS?: string;
  AGENT_CHAPTER_MINUTES?: string;
  AGENT_CHAPTER_EXTRACTION_CONCURRENCY?: string;
  AGENT_TRANSCRIPT_ROUTER?: string;
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number, integer = true): number {
  const value = raw?.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) return fallback;
  return Math.min(max, Math.max(min, value));
}

function choice<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = raw?.trim();
  return allowed.includes(value as T) ? value as T : fallback;
}

/** Missing or invalid values use the defaults, so a typo can never enable retrieval. */
export function transcriptRetrievalMode(env: VideoIndexEnv): TranscriptRetrievalMode {
  return choice(env.AGENT_TRANSCRIPT_RETRIEVAL, ['full', 'shadow', 'index'], 'full');
}

export function indexEvidenceTokens(env: VideoIndexEnv): number {
  return bounded(env.AGENT_INDEX_EVIDENCE_TOKENS, DEFAULT_EVIDENCE_TOKENS, 500, 8_000);
}

export function chapterMinutes(env: VideoIndexEnv): number {
  return bounded(env.AGENT_CHAPTER_MINUTES, DEFAULT_CHAPTER_MINUTES, 1, 15, false);
}

export function chapterExtractionConcurrency(env: VideoIndexEnv): number {
  return bounded(env.AGENT_CHAPTER_EXTRACTION_CONCURRENCY, 8, 1, 32);
}

export function transcriptRouter(env: VideoIndexEnv): TranscriptRouter {
  return choice(env.AGENT_TRANSCRIPT_ROUTER, ['classifier', 'jev'], 'classifier');
}
