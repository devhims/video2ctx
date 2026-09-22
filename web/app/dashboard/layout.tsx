import { ResearchHost } from './ResearchHost';
import { Suspense } from 'react';
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

  const accessSeed = Promise.allSettled(
    session ? [fetchServerAgentAccess(requestHeaders), fetchServerAdminAccess(requestHeaders)] : [],
  ).then(([agent, admin]) => {
    const failure = [agent, admin].find((result) => result?.status === 'rejected');
    return {
      agentAccess: agent?.status === 'fulfilled' ? agent.value : undefined,
      adminAccess: admin?.status === 'fulfilled' ? admin.value : undefined,
      error:
        failure?.status === 'rejected'
          ? failure.reason instanceof Error
            ? failure.reason.message
            : 'Access could not be checked.'
          : '',
    };
  });
  return (
    <DashboardSessionProvider
      key={session?.user.id ?? 'demo'}
      accessSeed={accessSeed}
      initialUser={session?.user ?? null}
      demoEnabled={demoEnabled}
    >
      <DashboardDataProvider key={session?.user.id ?? 'demo'} seeds={seeds}>
        {children}
        <Suspense fallback={null}>
          <ResearchHost />
        </Suspense>
      </DashboardDataProvider>
    </DashboardSessionProvider>
  );
}
