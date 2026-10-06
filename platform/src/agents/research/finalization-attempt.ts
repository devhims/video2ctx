import { withRunDeadline } from '../runtime/deadline';
import { FINALIZATION_STALL_TIMEOUT_MS } from './answer-budget';

export class FinalizationStallError extends Error {
  override readonly name = 'TimeoutError';
  constructor() { super('Finalization stalled: no model output before the idle timeout.'); }
}

/** Race both clocks, including when a provider ignores its abort signal. Only
 * content advances the idle clock; headers and heartbeats are not progress. */
export async function withFinalizationAttempt<T>(
  deadlineAt: number,
  parentSignal: AbortSignal,
  streaming: boolean,
  work: (signal: AbortSignal, progress: () => void) => Promise<T>,
): Promise<T> {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.any([parentSignal, idle.signal]);
  const reset = () => {
    clearTimeout(timer);
    if (streaming) timer = setTimeout(() => idle.abort(new FinalizationStallError()), FINALIZATION_STALL_TIMEOUT_MS);
  };
  try {
    return await withRunDeadline(deadlineAt, signal, async attemptSignal => {
      reset();
      return work(attemptSignal, () => {
        // Late SDK chunks after cancellation must neither throw nor arm a timer.
        if (!attemptSignal.aborted) reset();
      });
    }, 'Finalization attempt timeout.');
  } finally { clearTimeout(timer); }
}
