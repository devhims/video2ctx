import { Suspense } from 'react';
import { headers } from 'next/headers';
import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { startDashboardData } from '../../../lib/server-dashboard-data';
import { WorkspaceShell } from '../WorkspaceShell';
import { AccountSectionSkeleton } from '../AccountSectionSkeleton';
import { ProjectsClient } from './ProjectsClient';
export default async function Page() {
  // Start the read alongside the sign-in check instead of after it.
  const seeds = startDashboardData(await headers(), ['projects']);
  await requireDashboardSession();
  return (
    <WorkspaceShell section='projects' title='Projects'>
      <Suspense fallback={<AccountSectionSkeleton section='projects' />}>
        <ProjectsClient promise={seeds.projects!} />
      </Suspense>
    </WorkspaceShell>
  );
}
