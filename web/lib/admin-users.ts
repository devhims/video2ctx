import { isAbortError, PlatformApiError, platformRequest } from './platform-request.ts';
export type AdminUser = { id: string; name: string; email: string; plan: 'starter' | 'builder'; isAdmin: boolean;
  status: 'active' | 'deleted'; signedUpAt: number; deletedAt: number | null;
  polarCustomerId: string | null; creditBalance: number;
  deletionSource: 'self' | 'admin' | 'database' | null; deletedByUserId: string | null;
};
export type AdminUserResults = { users: AdminUser[]; nextOffset: number | null };
export function searchAdminUsers(query: string, offset = 0, signal?: AbortSignal) {
  return platformRequest<AdminUserResults>(`/v1/admin/users?${new URLSearchParams({ q: query, offset: String(offset) })}`, { cache: 'no-store', signal });
}
export async function deleteAdminUser(user: AdminUser, options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {}) {
  const deadline = Date.now() + 120_000;
  // DELETE is idempotent for this immutable user ID. A repeated request either
  // observes the existing deletion, resumes failed cleanup, or confirms 204.
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await platformRequest<void>(`/v1/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'DELETE', cache: 'no-store', body: JSON.stringify({ email: user.email }), signal: options.signal,
      });
    } catch (cause) {
      if (options.signal?.aborted || isAbortError(cause)) throw cause;
      const inProgress = cause instanceof PlatformApiError && cause.code === 'ACCOUNT_DELETION_IN_PROGRESS';
      const lostResponse = cause instanceof PlatformApiError
        ? !cause.code && [502, 503, 504].includes(cause.status)
        : cause instanceof Error && cause.cause instanceof TypeError;
      if (!inProgress && !lostResponse) throw cause;
      if (attempt >= 60 || Date.now() >= deadline) {
        throw new Error('Deletion has not been confirmed yet. Search for the account before retrying.', { cause });
      }
      options.onProgress?.(inProgress
        ? 'Account deletion is still running. Waiting for cleanup to finish…'
        : 'The response was interrupted. Checking whether account deletion finished…');
      await waitForDeletionRetry(options.signal);
    }
  }
}

function waitForDeletionRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 2000);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
