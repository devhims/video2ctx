import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { fetchServerSession } from './server-session';
import { loginPath } from './login-redirect';

export const requireDashboardSession = cache(async () => {
  const requestHeaders = await headers();
  const session = await fetchServerSession(requestHeaders);
  if (!session) redirect(loginPath(requestHeaders.get('x-dashboard-path')));
  return session;
});
