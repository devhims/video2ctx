export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const source = new URL(request.url);
  const target = new URL(`/${path.join('/')}${source.search}`, 'https://platform.internal');
  const headers = new Headers(request.headers);
  headers.delete('host');
  // The local HTTP fallback may transparently decompress an upstream response
  // while preserving its content-encoding header. Request an identity response
  // so the browser does not attempt to decompress the JSON a second time.
  headers.set('accept-encoding', 'identity');
  headers.set('x-forwarded-host', source.host);
  headers.set('x-forwarded-proto', source.protocol.slice(0, -1));
  headers.set('x-forwarded-prefix', '/api/platform');
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    ...(request.body ? { duplex: 'half' } as RequestInit : {}),
  };

  const platformBase =
    process.env.PLATFORM_API_BASE_URL ??
    (process.env.NODE_ENV === 'production' ? 'https://api.video2ctx.dev' : 'http://localhost:8787');
  return fetch(new URL(`${target.pathname}${target.search}`, platformBase), init);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
