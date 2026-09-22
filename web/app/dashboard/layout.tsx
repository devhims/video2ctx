import { DashboardDataProvider } from './DashboardDataProvider';
import { startDashboardData } from '../../lib/server-dashboard-data';
import { requireDashboardSession } from '../../lib/dashboard-auth';
import { headers } from 'next/headers';
import { DashboardSessionProvider } from './DashboardSessionProvider';
import { fetchServerAgentAccess, fetchServerAdminAccess, isLocalDashboardDemoEnabled } from '../../lib/server-session';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const demoEnabled = isLocalDashboardDemoEnabled(requestHeaders);
  const session = await requireDashboardSession();

  const seeds = startDashboardData(requestHeaders);
  const access = session ? await Promise.allSettled([
    fetchServerAgentAccess(requestHeaders),
    fetchServerAdminAccess(requestHeaders),
  ]) : [];
  const [agent, admin] = access;
  const failure = access.find(result => result.status === 'rejected');
  const accessError = failure?.status === 'rejected' ? (failure.reason instanceof Error ? failure.reason.message : 'Access could not be checked.') : '';
  const agentAccess = agent?.status === 'fulfilled' && agent.value;
  const adminAccess = admin?.status === 'fulfilled' && admin.value;

  return <DashboardSessionProvider initialAccessError={accessError} initialAdminAccess={adminAccess} initialAgentAccess={agentAccess} initialUser={session?.user ?? null} demoEnabled={demoEnabled}>
    <DashboardDataProvider key={session?.user.id ?? 'demo'} seeds={seeds}>{children}</DashboardDataProvider>
  </DashboardSessionProvider>;
}
