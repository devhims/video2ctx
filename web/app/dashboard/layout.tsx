import { requireDashboardSession } from '../../lib/dashboard-auth';
import { headers } from 'next/headers';
import { DashboardSessionProvider } from './DashboardSessionProvider';
import { fetchServerAgentAccess, fetchServerAdminAccess, isLocalDashboardDemoEnabled } from '../../lib/server-session';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const demoEnabled = isLocalDashboardDemoEnabled(requestHeaders);
  const session = await requireDashboardSession();

  const [agentAccess, adminAccess] = session ? await Promise.all([
    fetchServerAgentAccess(requestHeaders).catch(() => false),
    fetchServerAdminAccess(requestHeaders).catch(() => false),
  ]) : [false, false];

  return <DashboardSessionProvider initialAdminAccess={adminAccess} initialAgentAccess={agentAccess} initialUser={session?.user ?? null} demoEnabled={demoEnabled}>
    {children}
  </DashboardSessionProvider>;
}
