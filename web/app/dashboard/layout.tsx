import { headers } from 'next/headers';
import { DashboardSessionProvider } from './DashboardSessionProvider';
import { fetchServerSession, isLocalDashboardRequest } from '../../lib/server-session';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const demoEnabled = isLocalDashboardRequest(requestHeaders);
  let session = null;

  try {
    session = await fetchServerSession(requestHeaders);
  } catch (cause) {
    if (process.env.NODE_ENV === 'production') throw cause;
  }

  return <DashboardSessionProvider initialUser={session?.user ?? null} demoEnabled={demoEnabled}>
    {children}
  </DashboardSessionProvider>;
}
