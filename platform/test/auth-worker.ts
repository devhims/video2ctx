import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import app from '../src/app';
import { createAuthOptions } from '../src/lib/auth';

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/__test/session') {
      const options = createAuthOptions(env, executionCtx);
      const auth = betterAuth({
        ...options,
        plugins: [...options.plugins, testUtils()],
      });
      const context = await auth.$context;
      const user = context.test.createUser({
        email: `auth-${crypto.randomUUID()}@example.test`,
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
