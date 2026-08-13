import WorkspaceClient from './WorkspaceClient';
import type { DashboardSection } from './DashboardSidebar';

const DASHBOARD_SECTIONS = new Set<DashboardSection>(['trends', 'discover', 'projects', 'monitors', 'settings']);

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ section?: string; emailConsent?: string }> }) {
  const params = await searchParams;
  const requestedSection = params.section;
  const initialSection = requestedSection && DASHBOARD_SECTIONS.has(requestedSection as DashboardSection)
    ? requestedSection as DashboardSection
    : 'trends';

  return <WorkspaceClient initialSection={initialSection} emailConsent={params.emailConsent} />;
}
