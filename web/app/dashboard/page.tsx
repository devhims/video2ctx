import { redirect } from 'next/navigation';
import { requireDashboardSession } from '../../lib/dashboard-auth';
import WorkspaceClient from './WorkspaceClient';
import type { DashboardSection } from './DashboardSidebar';

const DASHBOARD_SECTIONS = new Set<DashboardSection>(['trends', 'discover', 'projects', 'monitors', 'settings']);

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.section === 'settings') {
    await requireDashboardSession();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === 'section' || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
    }
    redirect(`/dashboard/settings${query.size ? `?${query}` : ''}`);
  }
  const requestedSection = typeof params.section === 'string' ? params.section : undefined;
  const initialSection = requestedSection && DASHBOARD_SECTIONS.has(requestedSection as DashboardSection)
    ? requestedSection as DashboardSection
    : 'trends';

  return <WorkspaceClient initialSection={initialSection} />;
}
