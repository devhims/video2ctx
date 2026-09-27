import type { DashboardSection } from './DashboardSidebar';
export const SOURCES_HOME_EVENT = 'video2ctx:sources-home';
export function dashboardPath(section: DashboardSection) { return `/dashboard/${section === 'discover' ? 'sources' : section}`; }
