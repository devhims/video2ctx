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

/** Recognize only unambiguous video inputs; the platform validates the actual reads. */
export function videoIdFromInput(input: string): string | undefined {
  const value = input.trim();
  const valid = (id: string | null | undefined) => id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
  if (valid(value)) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return;
    if (url.hostname === 'youtu.be') return valid(url.pathname.slice(1));
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return;
    const id = url.searchParams.get('v');
    if (id) return valid(id);
    if (url.searchParams.get('list')) return;
    const [kind, pathId] = url.pathname.split('/').filter(Boolean);
    if (kind === 'shorts' || kind === 'live') return valid(pathId);
  } catch { /* Search text and other inputs use the platform resolver. */ }
}
