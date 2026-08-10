export type DashboardUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
};

export type DashboardSession = {
  user: DashboardUser;
  session: Record<string, unknown>;
};

type ServerSessionOptions = {
  fetch?: typeof fetch;
  platformBaseUrl?: string;
};

export async function fetchServerSession(
  requestHeaders: Headers,
  options: ServerSessionOptions = {},
): Promise<DashboardSession | null> {
  const cookie = requestHeaders.get('cookie');
  if (!cookie) return null;

  const platformBaseUrl = options.platformBaseUrl ?? process.env.PLATFORM_API_BASE_URL ??
    (process.env.NODE_ENV === 'production' ? 'https://api.video2ctx.dev' : 'http://localhost:8787');
  const requestOrigin = getRequestOrigin(requestHeaders);
  const response = await (options.fetch ?? fetch)(new URL('/api/auth/get-session', platformBaseUrl), {
    method: 'GET',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      cookie,
      ...(requestOrigin ? { origin: requestOrigin } : {}),
    },
  });

  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Session lookup failed (${response.status})`);

  const session = await response.json() as DashboardSession | null;
  return session?.user ? session : null;
}

export function isLocalDashboardRequest(requestHeaders: Headers): boolean {
  const hostname = (requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? '')
    .split(':')[0]
    .toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function getRequestOrigin(requestHeaders: Headers): string | undefined {
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  if (!host) return requestHeaders.get('origin') ?? undefined;
  const protocol = requestHeaders.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${protocol}://${host}`;
}
