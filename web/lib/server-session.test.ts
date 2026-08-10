import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchServerSession, isLocalDashboardRequest } from './server-session.ts';

describe('server dashboard session', () => {
  test('skips the platform request when there is no session cookie', async () => {
    let requested = false;
    const session = await fetchServerSession(new Headers(), {
      fetch: async () => {
        requested = true;
        return new Response(null, { status: 500 });
      },
    });

    assert.equal(session, null);
    assert.equal(requested, false);
  });

  test('forwards the browser cookie and origin to Better Auth', async () => {
    const session = await fetchServerSession(new Headers({
      cookie: 'better-auth.session_token=secret',
      host: 'app.video2ctx.dev',
      'x-forwarded-proto': 'https',
    }), {
      platformBaseUrl: 'https://platform.example',
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://platform.example/api/auth/get-session');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('cookie'), 'better-auth.session_token=secret');
        assert.equal(headers.get('origin'), 'https://app.video2ctx.dev');
        assert.equal(init?.cache, 'no-store');
        return Response.json({
          user: { id: 'user-1', email: 'user@example.com', name: 'User' },
          session: { id: 'session-1' },
        });
      },
    });

    assert.equal(session?.user.email, 'user@example.com');
  });

  test('recognizes only the existing localhost demo hosts', () => {
    assert.equal(isLocalDashboardRequest(new Headers({ host: 'localhost:3000' })), true);
    assert.equal(isLocalDashboardRequest(new Headers({ host: '127.0.0.1:3000' })), true);
    assert.equal(isLocalDashboardRequest(new Headers({ host: 'app.video2ctx.dev' })), false);
  });
});
