import { headers } from 'next/headers';
import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { startDashboardData } from '../../../lib/server-dashboard-data';
import { WorkspaceShell } from '../WorkspaceShell';
import { MonitorsClient } from './MonitorsClient';
export default async function Page() {
  // Start the read alongside the sign-in check instead of after it.
  const seeds = startDashboardData(await headers(), ['monitors']);
  await requireDashboardSession();
  return (
    <WorkspaceShell section='monitors' title='Monitors'>
      <MonitorsClient promise={seeds.monitors!} />
    </WorkspaceShell>
  );
}
