import { ApiError } from '../../lib/http';

const WORKERS_AI_CAPACITY_PATTERN = /(?:\b3040\b|capacity (?:is )?temporarily exceeded)/iu;

export function normalizeAgentExecutionError(error: unknown): unknown {
  if (!isWorkersAiCapacityError(error)) return error;
  return new ApiError(
    503,
    'WORKERS_AI_CAPACITY_EXCEEDED',
    'Workers AI capacity is temporarily exceeded. Retry the request.',
  );
}

export function isWorkersAiCapacityError(error: unknown): boolean {
  return error instanceof Error && WORKERS_AI_CAPACITY_PATTERN.test(error.message);
}
