import { headers } from 'next/headers';
import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { startDashboardData } from '../../../lib/server-dashboard-data';
import { WorkspaceShell } from '../WorkspaceShell';
import { MonitorsClient } from './MonitorsClient';
export default async function Page() {
  await requireDashboardSession();
  const seeds = startDashboardData(await headers(), ['monitors']);
  return (
    <WorkspaceShell section='monitors' title='Monitors'>
      <MonitorsClient promise={seeds.monitors!} />
    </WorkspaceShell>
  );
}
