import type { DashboardSection } from './DashboardSidebar';
import type { ProjectItem } from './research-types';
export const SOURCES_HOME_EVENT = 'video2ctx:sources-home';
export function dashboardPath(section: DashboardSection) { return `/dashboard/${section === 'discover' ? 'sources' : section}`; }
export function projectItemPath(projectId: string, item: ProjectItem) {
  return item.source_id
    ? `/dashboard/sources?project=${encodeURIComponent(projectId)}&saved=${encodeURIComponent(item.source_id)}`
    : `/dashboard/sources?type=${item.entity_type}&id=${encodeURIComponent(item.entity_id)}`;
}
