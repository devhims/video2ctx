import {Suspense} from 'react';
import {headers} from 'next/headers';
import {requireDashboardSession} from '../../../lib/dashboard-auth';
import {startDashboardData} from '../../../lib/server-dashboard-data';
import DeveloperSettingsClient from './DeveloperSettingsClient';
import DeveloperLoading from './loading';
export default async function Page() {
 // Start the read alongside the sign-in check instead of after it.
 const seeds=startDashboardData(await headers(),['apiKeys']);
 await requireDashboardSession();
 return <Suspense fallback={<DeveloperLoading/>}><DeveloperSettingsClient promise={seeds.apiKeys!}/></Suspense>;
}
