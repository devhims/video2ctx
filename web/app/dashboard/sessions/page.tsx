import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchServerAgentAccess } from '../../../lib/server-session';
import SessionsClient from './SessionsClient';

export default async function SessionsPage() {
  await requireDashboardSession();
  if (!await fetchServerAgentAccess(await headers())) notFound();
  return <SessionsClient />;
}
