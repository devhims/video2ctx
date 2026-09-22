import 'server-only';
import { ACCOUNT_PATHS, readAccountResource, type AccountResource, type AccountSeeds } from './dashboard-cache';
import { platformResponseError } from './platform-request';

// Start independent reads during server rendering; never await the whole account.
// Resolved promises stream to the client cache, which handles subsequent mutations.
export function startDashboardData(requestHeaders: Headers, requestedResources?: AccountResource[]): AccountSeeds {
  const base = process.env.PLATFORM_API_BASE_URL ?? (process.env.NODE_ENV === 'production' ? 'https://api.video2ctx.dev' : 'http://localhost:8787');
  const request = async (path: string) => {
    const response = await fetch(new URL(path, base), {
      cache: 'no-store',
      headers: { accept: 'application/json', cookie: requestHeaders.get('cookie') ?? '' },
    });
    if (!response.ok) throw await platformResponseError(response);
    return response.json();
  };
  const url = new URL(requestHeaders.get('x-dashboard-path') ?? '/dashboard', 'https://dashboard.internal');
  const legacySettings = url.pathname === '/dashboard' && url.searchParams.get('section') === 'settings';
  const resources: AccountResource[] = requestedResources ?? (legacySettings ? [] : url.pathname === '/dashboard' ? ['projects', 'monitors', 'usage', 'notifications', 'notificationPreferences'] : ['projects', 'usage']);
  return Object.fromEntries(resources.map(key => [key,
    readAccountResource(key, request).then(data => ({ data, updatedAt: Date.now() }), cause => ({ error: cause instanceof Error ? cause.message : 'Could not load account data.' })),
  ])) as AccountSeeds;
}
