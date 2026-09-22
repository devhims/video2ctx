import type { DashboardSection } from './DashboardSidebar';
export function dashboardPath(section: DashboardSection) { return `/dashboard/${section === 'discover' ? 'sources' : section}`; }
