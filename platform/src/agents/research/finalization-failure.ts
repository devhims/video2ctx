import { ApiError } from '../../lib/http';

/** Keep safe failure reasons outside the deadline race so a repair timeout does
 * not erase the first attempt's output-limit failure. Never expose model output. */
export function finalizationFailure(error: unknown, attemptCodes: readonly string[]): ApiError {
  const timedOut = error instanceof Error && (error.name === 'TimeoutError'
    || /(?:timed?\s*out|timeout)/iu.test(error.message));
  const tokenLimit = attemptCodes.includes('ANSWER_TOKEN_LIMIT');
  const reason = tokenLimit && timedOut
    ? 'The answer reached its output limit, and the repair attempt timed out.'
    : tokenLimit ? 'The answer reached its output limit and could not be completed after repair.'
    : timedOut ? 'Finalization timed out before the answer could be completed.'
    : attemptCodes.some(code => ['INVALID_ANSWER_STRUCTURE', 'UNGROUNDED_ANSWER', 'INVALID_AGENT_CITATION', 'AGENT_CITATION_REQUIRED'].includes(code))
      ? 'The generated answer could not pass the answer validation checks after repair.'
      : 'The final answer could not be completed because answer generation failed.';
  return new ApiError(502, 'FINAL_SYNTHESIS_UNAVAILABLE',
    `${reason} Any successfully saved evidence remains available in this session. Retry the question to use it again.`);
}
