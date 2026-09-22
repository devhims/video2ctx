import { Suspense } from 'react';
import { headers } from 'next/headers';
import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { startDashboardData } from '../../../lib/server-dashboard-data';
import { AccountCards, BillingCard, PreferencesCard } from './SettingsCards';
import { BillingSkeleton, PreferencesSkeleton } from './SettingsSkeleton';
import { SettingsShell } from './SettingsShell';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ emailConsent?: string }> }) {
  await requireDashboardSession();
  const seeds = startDashboardData(await headers(), ['billing', 'notificationPreferences']);
  const params = await searchParams;
  return <SettingsShell>
    <Suspense fallback={<BillingSkeleton />}><BillingCard promise={seeds.billing!} /></Suspense>
    <Suspense fallback={<PreferencesSkeleton />}><PreferencesCard promise={seeds.notificationPreferences!} emailConsent={params.emailConsent} /></Suspense>
    <AccountCards />
  </SettingsShell>;
}
