import { requireDashboardSession } from '../../lib/dashboard-auth';
import { redirect } from 'next/navigation';
import { dashboardPath } from './dashboard-routes';
import type { DashboardSection } from './DashboardSidebar';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireDashboardSession();
  const params = await searchParams;
  const valid = ['trends', 'discover', 'projects', 'monitors', 'settings'];
  const section =
    typeof params.section === 'string' && valid.includes(params.section)
      ? (params.section as DashboardSection)
      : 'trends';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'section' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  redirect(`${dashboardPath(section)}${query.size ? `?${query}` : ''}`);
}
