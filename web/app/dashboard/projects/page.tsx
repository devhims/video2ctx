import { Suspense } from 'react';
import { headers } from 'next/headers';
import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { startDashboardData } from '../../../lib/server-dashboard-data';
import { WorkspaceShell } from '../WorkspaceShell';
import { AccountSectionSkeleton } from '../AccountSectionSkeleton';
import { ProjectsClient } from './ProjectsClient';
export default async function Page() {
  await requireDashboardSession();
  const seeds = startDashboardData(await headers(), ['projects']);
  return (
    <WorkspaceShell section='projects' title='Projects'>
      <Suspense fallback={<AccountSectionSkeleton section='projects' />}>
        <ProjectsClient promise={seeds.projects!} />
      </Suspense>
    </WorkspaceShell>
  );
}
