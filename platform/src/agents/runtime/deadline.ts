export const AGENT_RUN_TIMEOUT_MS = 60_000;

/** One admission-based deadline, including calls that do not honor cancellation. */
export async function withRunDeadline<T>(
  deadlineAt: number,
  parentSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMessage = 'Agent exceeded its 60-second deadline.',
): Promise<T> {
  const controller = new AbortController();
  const timeout = () => controller.abort(new Error(timeoutMessage));
  const cancel = () => controller.abort(parentSignal.reason);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  parentSignal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(timeout, Math.max(0, deadlineAt - Date.now()));
  if (parentSignal.aborted) cancel();
  if (Date.now() >= deadlineAt) timeout();
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort(new Error('Agent run finished.'));
  }
}
