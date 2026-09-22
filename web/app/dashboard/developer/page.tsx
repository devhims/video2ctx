import {Suspense} from 'react';
import {headers} from 'next/headers';
import {requireDashboardSession} from '../../../lib/dashboard-auth';
import {startDashboardData} from '../../../lib/server-dashboard-data';
import DeveloperSettingsClient from './DeveloperSettingsClient';
import DeveloperLoading from './loading';
export default async function Page() {
 await requireDashboardSession();
 const seeds=startDashboardData(await headers(),['apiKeys']);
 return <Suspense fallback={<DeveloperLoading/>}><DeveloperSettingsClient promise={seeds.apiKeys!}/></Suspense>;
}
