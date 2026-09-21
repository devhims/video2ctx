import { isAbortError } from './platform-request.ts';

export type SourceDataResult<T> = { value: T; error?: never } | { value?: never; error: string };

/** A failed fetch says nothing about whether this video's dataset exists. */
export async function loadSourceData<T>(request: () => Promise<T>): Promise<SourceDataResult<T>> {
  try { return { value: await request() }; }
  catch (cause) {
    if (isAbortError(cause)) throw cause;
    return { error: cause instanceof Error ? cause.message : 'The request failed. Please try again.' };
  }
}
