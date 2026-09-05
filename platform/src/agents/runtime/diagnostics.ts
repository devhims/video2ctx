/** Allowlisted diagnostics only. Never serialize errors, prompts, bodies, or headers. */
export function failureDetails(error: unknown, signal?: AbortSignal) {
  const value = error as { statusCode?: unknown; isRetryable?: unknown; name?: unknown; responseHeaders?: Record<string, string> } | null;
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : '';
  return {
    errorType: typeof value?.name === 'string' && ['AI_APICallError', 'AI_NoObjectGeneratedError', 'TranscriptAnalysisInvalidReferenceError', 'ZodError', 'TimeoutError', 'AbortError'].includes(value.name) ? value.name : undefined,
    providerRequestId: safeRequestId(value?.responseHeaders?.['cf-ray'] ?? value?.responseHeaders?.['x-request-id']),
    failureKind: signal?.aborted ? 'canceled' : 'error',
    cancellationReason: !signal?.aborted ? undefined
      : message === 'Research phase timeout.' ? 'research_deadline'
      : message === 'Finalization phase timeout.' ? 'finalization_deadline'
      : message === 'Agent processing deadline exceeded.' ? 'run_deadline'
      : reason instanceof Error && reason.name === 'TimeoutError' ? 'sdk_timeout'
      : message === 'Persistence phase timeout.' ? 'persistence_deadline'
      : 'other_abort',
    statusCode: typeof value?.statusCode === 'number' ? value.statusCode : undefined,
    retryable: typeof value?.isRetryable === 'boolean' ? value.isRetryable : undefined,
  };
}

export async function observeAgentOperation<T>(
  fields: Record<string, string | number | boolean | null | undefined>,
  signal: AbortSignal | undefined,
  work: () => PromiseLike<T>,
): Promise<T> {
  const startedAt = Date.now();
  let ended = false;
  const finish = (outcome: string, extra = {}) => {
    if (ended) return;
    ended = true;
    console.log(JSON.stringify({ event: 'agent_operation', ...fields, outcome,
      elapsedMs: Date.now() - startedAt, ...extra }));
  };
  const abort = () => finish('canceled', failureDetails(undefined, signal));
  console.log(JSON.stringify({ event: 'agent_operation', ...fields, outcome: 'started' }));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) { abort(); signal.throwIfAborted(); }
    const result = await work();
    finish('succeeded');
    return result;
  } catch (error) {
    finish('failed', failureDetails(error, signal));
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
