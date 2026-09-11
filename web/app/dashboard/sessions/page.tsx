import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchServerAgentAccess } from '../../../lib/server-session';
import SessionsClient from './SessionsClient';

export default async function SessionsPage() {
  if (!await fetchServerAgentAccess(await headers())) notFound();
  return <SessionsClient />;
}
