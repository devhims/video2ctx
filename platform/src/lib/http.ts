import type { Context } from 'hono';

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function jsonError(c: Context, error: unknown): Response {
  const requestId = c.get('requestId' as never) as string | undefined;
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details, requestId } },
      error.status
    );
  }
  console.error('unhandled_request_error', { requestId, error });
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId } },
    500
  );
}

export async function body<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(422, 'INVALID_CONTENT_TYPE', 'Expected application/json.');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(422, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
}

export function text(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export function asId(value: unknown): string {
  const id = text(value, 200);
  if (!/^[A-Za-z0-9_:@.\-]+$/.test(id)) {
    throw new ApiError(422, 'INVALID_ID', 'Invalid entity identifier.');
  }
  return id;
}

export function now(): number {
  return Date.now();
}

export function sha256(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((buffer) =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character] ?? character));
}
