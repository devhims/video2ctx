import { publishCreditBalance } from './dashboard-data.ts';

export class PlatformApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message); this.name = 'PlatformApiError'; this.status = status; this.code = code;
  }
}

export function isAbortError(cause: unknown) {
  return cause instanceof Error && cause.name === 'AbortError';
}

/** Keep the API's explanation, including for auth, credits, throttling and timeouts. */
export async function platformResponseError(response: Response, fallback = `Request failed (${response.status}).`): Promise<PlatformApiError> {
  const payload = await response.json().catch(() => null);
  const error = payload?.error;
  return new PlatformApiError(response.status, typeof error?.code === 'string' ? error.code : undefined,
    typeof error?.message === 'string' && error.message ? error.message : fallback);
}

/** The API owns operation deadlines. Only caller cancellation aborts a request here. */
export async function platformFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)) headers.set('x-demo-user', 'local-beta');
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  try {
    const response = await fetch(`/api/platform${path}`, { ...options, headers, credentials: 'include' });
    publishCreditBalance(response.headers);
    return response;
  } catch (cause) {
    if (options.signal?.aborted || isAbortError(cause)) throw cause;
    throw new Error('The connection was lost before the API response arrived. Please try again.', { cause });
  }
}

export async function platformRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await platformFetch(path, options);
  if (!response.ok) {
    const error = await platformResponseError(response);
    options.signal?.throwIfAborted();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch (cause) {
    if (options.signal?.aborted || isAbortError(cause)) throw cause;
    throw new Error(cause instanceof SyntaxError
      ? 'The API returned an invalid response. Please try again.'
      : 'The connection was lost while reading the API response. Please try again.', { cause });
  }
}
