import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import app from '../src/app';
import { createAuthOptions } from '../src/lib/auth';

// Checkout is the only path these tests drive into Polar. Answer it here with a
// server error so no test depends on the live API; every other request passes through.
const passthroughFetch = globalThis.fetch;
let polarCalls = 0;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (/(^|\.)polar\.sh$/.test(url.hostname)) {
    polarCalls += 1;
    return Promise.resolve(new Response(JSON.stringify({ error: 'TestPolarUnavailable', detail: 'Polar is stubbed in tests.' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }));
  }
  return passthroughFetch(input, init);
}) as typeof fetch;

// Billing is unconfigured by default, as in production today. A request can opt
// into a configured Polar setup to exercise checkout against the stub above.
function requestEnv(request: Request, env: Env): Env {
  if (request.headers.get('x-test-polar') !== 'configured') return env;
  return { ...env, POLAR_ACCESS_TOKEN: 'test-only-polar-token', POLAR_ENVIRONMENT: 'sandbox', POLAR_BUILDER_PRODUCT_ID: 'test-builder-product' } as unknown as Env;
}

export default {
  async fetch(request: Request, baseEnv: Env, executionCtx: ExecutionContext): Promise<Response> {
    const env = requestEnv(request, baseEnv);
    const url = new URL(request.url);
    if (url.pathname === '/__test/polar-calls') return Response.json({ count: polarCalls });
    if (request.method === 'POST' && url.pathname === '/__test/session') {
      const input = await request.json().catch(() => ({})) as { email?: string };
      const options = createAuthOptions(env, executionCtx);
      const auth = betterAuth({
        ...options,
        plugins: [...options.plugins, testUtils()],
      });
      const context = await auth.$context;
      const user = context.test.createUser({
        email: input.email ?? `auth-${crypto.randomUUID()}@example.test`,
        name: 'Auth Test User',
        emailVerified: true,
      });
      const savedUser = await context.test.saveUser(user);
      const login = await context.test.login({ userId: savedUser.id });
      return Response.json({
        user: { id: savedUser.id, email: savedUser.email },
        cookie: login.headers.get('cookie'),
      });
    }

    return app.fetch(request, env, executionCtx);
  },
} satisfies ExportedHandler<Env>;
