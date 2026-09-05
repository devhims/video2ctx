export const AGENT_RESEARCH_TIMEOUT_MS = 40_000;
export const AGENT_FINALIZATION_TIMEOUT_MS = 40_000;
export const AGENT_PERSISTENCE_TIMEOUT_MS = 30_000;
export const AGENT_RUN_TIMEOUT_MS = AGENT_RESEARCH_TIMEOUT_MS + AGENT_FINALIZATION_TIMEOUT_MS;

/** Bounds a phase even when work ignores cancellation. Terminal saving can leave
 * this clock; its caller must apply a separate persistence timeout. Failed
 * validation restores the original deadline, so repair cannot gain model time. */
export async function withRunDeadline<T>(
  deadlineAt: number,
  parentSignal: AbortSignal,
  work: (signal: AbortSignal, persist: <R>(save: () => Promise<R>) => Promise<R>) => Promise<T>,
  timeoutMessage = 'Agent processing deadline exceeded.',
): Promise<T> {
  const controller = new AbortController();
  const timeout = () => controller.abort(new Error(timeoutMessage));
  const cancel = () => controller.abort(parentSignal.reason);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  parentSignal.addEventListener('abort', cancel, { once: true });
  let timer = setTimeout(timeout, Math.max(0, deadlineAt - Date.now()));
  const persist = async <R>(save: () => Promise<R>): Promise<R> => {
    controller.signal.throwIfAborted();
    clearTimeout(timer);
    try { return await save(); }
    catch (error) {
      // Validation failure may require another model call, using the original deadline.
      timer = setTimeout(timeout, Math.max(0, deadlineAt - Date.now()));
      if (Date.now() >= deadlineAt) timeout();
      throw error;
    }
  };
  if (parentSignal.aborted) cancel();
  if (Date.now() >= deadlineAt) timeout();
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal, persist);
    })]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort(new Error('Agent run finished.'));
  }
}
