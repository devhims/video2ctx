import { requireDashboardSession } from '../../../../lib/dashboard-auth';
import { headers } from 'next/headers';
import { fetchServerSessionReadAccess } from '../../../../lib/server-session';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import SessionsClient from '../SessionsClient';

export default async function AgentSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  await requireDashboardSession();
  if (!await fetchServerSessionReadAccess(await headers())) notFound();
  const { sessionId } = await params;
  if (!z.string().uuid().safeParse(sessionId).success) notFound();
  return <SessionsClient key={sessionId} sessionId={sessionId} />;
}
