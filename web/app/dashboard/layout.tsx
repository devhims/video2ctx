import { headers } from 'next/headers';
import { DashboardSessionProvider } from './DashboardSessionProvider';
import { fetchServerSession, fetchServerAgentAccess, isLocalDashboardDemoEnabled } from '../../lib/server-session';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const demoEnabled = isLocalDashboardDemoEnabled(requestHeaders);
  let session = null;

  try {
    session = await fetchServerSession(requestHeaders);
  } catch (cause) {
    if (process.env.NODE_ENV === 'production') throw cause;
  }

  const agentAccess = session ? await fetchServerAgentAccess(requestHeaders).catch(() => false) : false;

  return <DashboardSessionProvider initialAgentAccess={agentAccess} initialUser={session?.user ?? null} demoEnabled={demoEnabled}>
    {children}
  </DashboardSessionProvider>;
}
