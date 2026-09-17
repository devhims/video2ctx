import { headers } from 'next/headers';
import { DashboardSessionProvider } from './DashboardSessionProvider';
import { fetchServerSession, fetchServerAgentAccess, fetchServerAdminAccess, isLocalDashboardDemoEnabled } from '../../lib/server-session';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const demoEnabled = isLocalDashboardDemoEnabled(requestHeaders);
  let session = null;

  try {
    session = await fetchServerSession(requestHeaders);
  } catch (cause) {
    if (process.env.NODE_ENV === 'production') throw cause;
  }

  const [agentAccess, adminAccess] = session ? await Promise.all([
    fetchServerAgentAccess(requestHeaders).catch(() => false),
    fetchServerAdminAccess(requestHeaders).catch(() => false),
  ]) : [false, false];

  return <DashboardSessionProvider initialAdminAccess={adminAccess} initialAgentAccess={agentAccess} initialUser={session?.user ?? null} demoEnabled={demoEnabled}>
    {children}
  </DashboardSessionProvider>;
}
