import type { DashboardSection } from './DashboardSidebar';
import type { ProjectItem } from './research-types';
export const SOURCES_HOME_EVENT = 'video2ctx:sources-home';
export function dashboardPath(section: DashboardSection) { return `/dashboard/${section === 'discover' ? 'sources' : section}`; }
export function projectItemPath(projectId: string, item: ProjectItem) {
  return `/dashboard/sources?openProject=${encodeURIComponent(projectId)}&saved=${encodeURIComponent(item.id)}`;
}
