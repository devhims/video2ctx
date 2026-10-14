import { BodyTooLargeError, EmptyBodyError, readBoundedBytes } from './bounded-body';

export async function boundedContainerJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    const bytes = await readBoundedBytes(response.body, 12 * 1024 * 1024, signal);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new Error('Oversized container response.');
    if (error instanceof EmptyBodyError) throw new Error('Empty container response.');
    throw error;
  }
}

/** Bound an uncooperative binding without leaving a diagnostic attempt open forever. */
export async function abortableContainerFetch(signal: AbortSignal, work: () => Promise<Response>): Promise<Response> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
