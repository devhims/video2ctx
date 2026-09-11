import { headers } from 'next/headers';
import { fetchServerAgentAccess } from '../../../../lib/server-session';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import SessionsClient from '../SessionsClient';

export default async function AgentSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  if (!await fetchServerAgentAccess(await headers())) notFound();
  const { sessionId } = await params;
  if (!z.string().uuid().safeParse(sessionId).success) notFound();
  return <SessionsClient key={sessionId} sessionId={sessionId} />;
}
