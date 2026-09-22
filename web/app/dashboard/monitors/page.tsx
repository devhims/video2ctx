import { Suspense } from 'react';
import { headers } from 'next/headers';
import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { startDashboardData } from '../../../lib/server-dashboard-data';
import { WorkspaceShell } from '../WorkspaceShell';
import { AccountSectionSkeleton } from '../AccountSectionSkeleton';
import { MonitorsClient } from './MonitorsClient';
export default async function Page() {
  await requireDashboardSession();
  const seeds = startDashboardData(await headers(), ['monitors']);
  return (
    <WorkspaceShell section='monitors' title='Monitors'>
      <Suspense fallback={<AccountSectionSkeleton section='monitors' />}>
        <MonitorsClient promise={seeds.monitors!} />
      </Suspense>
    </WorkspaceShell>
  );
}
