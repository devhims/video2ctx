import { headers } from 'next/headers';
import { fetchServerSession } from '../../lib/server-session';
import DeviceAuthorizationClient from './DeviceAuthorizationClient';

export default async function DeviceAuthorizationPage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const requestHeaders = await headers();
  const params = await searchParams;
  let session = null;
  try {
    session = await fetchServerSession(requestHeaders);
  } catch (cause) {
    if (process.env.NODE_ENV === 'production') throw cause;
  }

  return <DeviceAuthorizationClient
    initialUser={session?.user ?? null}
    initialUserCode={params.user_code ?? ''}
  />;
}
