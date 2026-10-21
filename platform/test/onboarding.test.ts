import { Hono } from 'hono';
import type { App, AuthPrincipal } from '../src/types';
import { jsonError } from '../src/lib/http';
import { parseOnboardingAnswers } from '../src/lib/onboarding';
import { sessionRoutes } from '../src/routes/session/session.index';

const user = { id: 'user-1', email: 'user@example.com', name: 'User' };
const browserPrincipal: AuthPrincipal = { user, method: 'session', permissions: { data: ['read'], account: ['access'] } };
const cliPrincipal: AuthPrincipal = { user, method: 'cli-session', permissions: { data: ['read'], account: ['access'] } };

function onboardingApp(principal: AuthPrincipal) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => { statements.push({ sql, values }); return { success: true }; },
      }),
    }),
  };
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'request-1');
    c.set('principal', principal);
    c.set('user', principal.user);
    await next();
  });
  app.route('/', sessionRoutes);
  app.onError((error, c) => jsonError(c, error));
  const request = (payload: unknown) => app.request('/onboarding', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, { DB } as unknown as Env);
  return { request, statements };
}

describe('onboarding answers', () => {
  test('saves the signed-in account answers in a fixed agent order', async () => {
    const { request, statements } = onboardingApp(browserPrincipal);
    const response = await request({ agents: ['codex', 'claude-code'], goal: '  A channel digest  ' });

    expect(response.status).toBe(204);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('ON CONFLICT(user_id) DO UPDATE');
    expect(statements[0]?.values.slice(0, 3)).toEqual(['user-1', '["claude-code","codex"]', 'A channel digest']);
  });

  test('stores a blank or missing goal as null', () => {
    expect(parseOnboardingAnswers({ agents: ['other'], goal: '   ' })).toEqual({ agents: ['other'], goal: null });
    expect(parseOnboardingAnswers({ agents: ['cursor'] })).toEqual({ agents: ['cursor'], goal: null });
  });

  test.each([
    { agents: [] },
    { agents: ['windsurf'] },
    { agents: ['codex', 'codex'] },
    { agents: ['codex'], goal: 'x'.repeat(501) },
    { agents: ['codex'], userId: 'someone-else' },
  ])('rejects invalid answers: %j', async (payload) => {
    const { request, statements } = onboardingApp(browserPrincipal);
    const response = await request(payload);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_ONBOARDING_ANSWERS' } });
    expect(statements).toHaveLength(0);
  });

  test('accepts only browser sessions', async () => {
    const { request, statements } = onboardingApp(cliPrincipal);
    const response = await request({ agents: ['codex'] });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    expect(statements).toHaveLength(0);
  });
});
