import { requireDashboardSession } from '../../../lib/dashboard-auth';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchServerAgentAccess } from '../../../lib/server-session';
import { startAgentSessionListSeed } from '../../../lib/server-agent-session';
import SessionsClient from './SessionsClient';

export default async function SessionsPage() {
  const requestHeaders = await headers();
  // Read recent sessions alongside the sign-in and access checks, which also run together.
  const listSeed = startAgentSessionListSeed(requestHeaders);
  const [, agentAccess] = await Promise.all([requireDashboardSession(), fetchServerAgentAccess(requestHeaders)]);
  if (!agentAccess) notFound();
  return <SessionsClient initialList={await listSeed ?? undefined} serverAccess='agent' />;
}
