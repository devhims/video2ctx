import { withRunDeadline } from '../runtime/deadline';
/** Bound the attempt by its overall deadline, including when a provider ignores cancellation. */
export function withFinalizationAttempt<T>(
  deadlineAt: number,
  parentSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withRunDeadline(deadlineAt, parentSignal, work, 'Finalization attempt timeout.');
}
