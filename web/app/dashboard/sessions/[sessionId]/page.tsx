import { requireDashboardSession } from '../../../../lib/dashboard-auth';
import { headers } from 'next/headers';
import { fetchServerSessionReadAccess } from '../../../../lib/server-session';
import { startAgentSessionSeed } from '../../../../lib/server-agent-session';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import SessionsClient from '../SessionsClient';

export default async function AgentSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const valid = z.string().uuid().safeParse(sessionId).success;
  const requestHeaders = await headers();
  // Read the conversation alongside the sign-in and access checks rather than after hydration.
  const sessionSeed = valid ? startAgentSessionSeed(requestHeaders, sessionId) : undefined;
  await requireDashboardSession();
  const access = await fetchServerSessionReadAccess(requestHeaders);
  if (!access || !sessionSeed) notFound();
  return <SessionsClient key={sessionId} sessionId={sessionId} sessionSeed={sessionSeed} serverAccess={access} />;
}
