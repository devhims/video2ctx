/** Only return to dashboard routes on this origin after authentication. */
export function dashboardReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) return '/dashboard';
  try {
    const url = new URL(value, 'https://video2ctx.local');
    if (url.origin !== 'https://video2ctx.local' || (url.pathname !== '/dashboard' && !url.pathname.startsWith('/dashboard/'))) return '/dashboard';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/dashboard'; }
}

export function loginPath(returnTo: unknown = '/dashboard'): string {
  const path = dashboardReturnTo(returnTo);
  return path === '/dashboard' ? '/login' : `/login?returnTo=${encodeURIComponent(path)}`;
}
