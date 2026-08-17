import { describe, expect, test, vi } from 'vitest';
import { runCli, type CliDependencies } from './cli';
import type { CredentialStore, StoredProfile } from './auth';

class MemoryCredentialStore implements CredentialStore {
  constructor(public profile: StoredProfile | null = null) {}

  async read(): Promise<StoredProfile | null> { return this.profile; }
  async write(profile: StoredProfile): Promise<void> { this.profile = profile; }
  async delete(): Promise<void> { this.profile = null; }
}

function dependencies(options: {
  responses?: Response[];
  store?: MemoryCredentialStore;
  environment?: Record<string, string | undefined>;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [...(options.responses ?? [])];
  const store = options.store ?? new MemoryCredentialStore();
  const sleep = vi.fn(async () => undefined);
  const deps: CliDependencies = {
    fetch: vi.fn(async (input, init) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return response;
    }),
    store,
    environment: options.environment ?? {},
    openBrowser: vi.fn(async () => undefined),
    now: () => 0,
    sleep,
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  };
  return { deps, stdout, stderr, requests, store, sleep };
}

describe('video2ctx CLI authentication', () => {
  test('reports a version for installation checks', async () => {
    const state = dependencies();

    const exitCode = await runCli(['--version'], state.deps);

    expect(exitCode).toBe(0);
    expect(state.stderr).toEqual([]);
    expect(state.stdout).toEqual(['development']);
  });

  test('prints verification instructions before polling and never prints credentials', async () => {
    const state = dependencies({ responses: [
      jsonResponse({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://video2ctx.dev/device',
        verification_uri_complete: 'https://video2ctx.dev/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 1,
      }),
      jsonResponse({
        access_token: 'approved-session-token',
        token_type: 'Bearer',
        expires_in: 604800,
        scope: 'data:read account:access',
      }),
    ] });

    const exitCode = await runCli([
      'auth', 'login', '--no-browser', '--base-url', 'http://127.0.0.1:8787',
    ], state.deps);

    expect(exitCode).toBe(0);
    expect(state.deps.openBrowser).not.toHaveBeenCalled();
    expect(state.stdout).toEqual([
      'Open https://video2ctx.dev/device',
      'Enter code: ABCD-EFGH',
      'Authenticated as a CLI session.',
    ]);
    const visibleOutput = [...state.stdout, ...state.stderr].join('\n');
    expect(visibleOutput).not.toContain('device-secret');
    expect(visibleOutput).not.toContain('approved-session-token');
  });

  test.each([
    ['auth status', ['auth', 'status']],
    ['whoami', ['whoami']],
  ])('%s emits structured identity JSON without the token', async (_label, args) => {
    const store = new MemoryCredentialStore(profile());
    const state = dependencies({
      store,
      responses: [jsonResponse({
        user: { id: 'user-1', email: 'user@example.com', name: 'User' },
        authentication: { method: 'cli-session' },
      })],
    });

    const exitCode = await runCli([...args, '--json'], state.deps);

    expect(exitCode).toBe(0);
    expect(state.stderr).toEqual([]);
    expect(state.stdout).toHaveLength(1);
    expect(JSON.parse(state.stdout[0] ?? '')).toMatchObject({
      authenticated: true,
      user: { id: 'user-1', email: 'user@example.com' },
      authentication: { method: 'cli-session' },
    });
    expect(state.stdout[0]).not.toContain('profile-session-token');
  });

  test('revokes the server session and removes the local profile on logout', async () => {
    const store = new MemoryCredentialStore(profile());
    const state = dependencies({ store, responses: [jsonResponse({ success: true })] });

    const exitCode = await runCli(['auth', 'logout', '--json'], state.deps);

    expect(exitCode).toBe(0);
    expect(store.profile).toBeNull();
    expect(JSON.parse(state.stdout[0] ?? '')).toEqual({ loggedOut: true, revoked: true });
    expect(state.requests[0]?.url).toBe('https://api.video2ctx.dev/api/auth/sign-out');
    expect(new Headers(state.requests[0]?.init?.headers).get('authorization')).toBe('Bearer profile-session-token');
    expect(new Headers(state.requests[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(state.requests[0]?.init?.body).toBe('{}');
    expect(state.stdout.join('\n')).not.toContain('profile-session-token');
  });

  test('redacts credentials when a transport error contains one', async () => {
    const store = new MemoryCredentialStore(profile());
    const state = dependencies({ store });
    state.deps.fetch = vi.fn(async () => {
      throw new Error('request failed with profile-session-token');
    });

    const exitCode = await runCli(['whoami'], state.deps);

    expect(exitCode).toBe(1);
    expect(JSON.parse(state.stderr[0] ?? '')).toMatchObject({
      error: { code: 'TRANSPORT_ERROR', retryable: true, message: expect.stringContaining('***') },
    });
    expect(state.stderr.join('\n')).not.toContain('profile-session-token');
  });
});

describe('video2ctx CLI API transport', () => {
  test('uses the environment API key before the stored CLI profile', async () => {
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      environment: { VIDEO2CTX_API_KEY: 'aty_environment' },
      responses: [jsonResponse({ creditBalance: 100 })],
    });

    const exitCode = await runCli(['api', 'GET', '/v1/usage'], state.deps);

    expect(exitCode).toBe(0);
    expect(JSON.parse(state.stdout[0] ?? '')).toEqual({ creditBalance: 100 });
    expect(new Headers(state.requests[0]?.init?.headers).get('authorization')).toBe('Bearer aty_environment');
  });

  test('can include settled credit and request metadata without exposing credentials', async () => {
    const response = jsonResponse({ results: [] });
    response.headers.set('X-Credits-Charged', '2');
    response.headers.set('X-Credits-Remaining', '998');
    response.headers.set('X-Request-Id', 'request-1');
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      responses: [response],
    });

    const exitCode = await runCli([
      'api', 'GET', '/v1/providers/youtube/search?q=test', '--include-meta',
    ], state.deps);

    expect(exitCode).toBe(0);
    expect(JSON.parse(state.stdout[0] ?? '')).toEqual({
      data: { results: [] },
      meta: {
        status: 200,
        requestId: 'request-1',
        creditsCharged: 2,
        creditsRemaining: 998,
      },
    });
    expect(state.stdout[0]).not.toContain('profile-session-token');
  });

  test('retrieves a compact transcript from a YouTube URL in one data request', async () => {
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      responses: [jsonResponse({
        videoId: 'dQw4w9WgXcQ',
        track: { id: 'en', languageCode: 'en', name: 'English' },
        text: 'Never gonna give you up',
        meta: { provider: 'youtube', partial: false, warnings: [] },
      })],
    });

    const exitCode = await runCli([
      'transcript', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      '--format', 'text', '--lang', 'en',
    ], state.deps);

    expect(exitCode).toBe(0);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.url).toBe(
      'https://api.video2ctx.dev/v1/providers/youtube/videos/dQw4w9WgXcQ/transcript?format=text&lang=en',
    );
    expect(JSON.parse(state.stdout[0] ?? '')).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      text: 'Never gonna give you up',
    });
  });

  test('emits a structured API error on stderr with no stdout', async () => {
    const response = jsonResponse({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'More credits are required.',
        requestId: 'request-402',
      },
    }, 402);
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      responses: [response],
    });

    const exitCode = await runCli(['api', 'GET', '/v1/usage'], state.deps);

    expect(exitCode).toBe(1);
    expect(state.stdout).toEqual([]);
    expect(JSON.parse(state.stderr[0] ?? '')).toEqual({
      error: {
        status: 402,
        code: 'INSUFFICIENT_CREDITS',
        message: 'More credits are required.',
        requestId: 'request-402',
        retryable: false,
      },
    });
  });

  test('retries a GET once for 429 and honors Retry-After', async () => {
    const throttled = jsonResponse({ error: { code: 'RATE_LIMITED', message: 'Slow down.' } }, 429);
    throttled.headers.set('Retry-After', '2');
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      responses: [throttled, jsonResponse({ creditBalance: 99 })],
    });

    const exitCode = await runCli(['api', 'GET', '/v1/usage'], state.deps);

    expect(exitCode).toBe(0);
    expect(state.requests).toHaveLength(2);
    expect(state.sleep).toHaveBeenCalledWith(2000);
  });

  test('does not retry mutations or non-transient failures', async () => {
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      responses: [jsonResponse({ error: { code: 'INVALID_INPUT', message: 'Invalid.' } }, 422)],
    });

    const exitCode = await runCli([
      'api', 'POST', '/v1/monitors', '--data', '{"name":"test"}', '--retries', '3',
    ], state.deps);

    expect(exitCode).toBe(1);
    expect(state.requests).toHaveLength(1);
  });

  test('uses the longer data timeout by default and accepts a bounded override', async () => {
    const state = dependencies({
      store: new MemoryCredentialStore(profile()),
      responses: [jsonResponse({ creditBalance: 100 }), jsonResponse({ creditBalance: 100 })],
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    const defaultExitCode = await runCli(['api', 'GET', '/v1/usage'], state.deps);
    const overrideExitCode = await runCli([
      'api', 'GET', '/v1/usage', '--timeout-ms', '180000',
    ], state.deps);

    expect(defaultExitCode).toBe(0);
    expect(overrideExitCode).toBe(0);
    expect(timeout).toHaveBeenNthCalledWith(1, 150000);
    expect(timeout).toHaveBeenNthCalledWith(2, 180000);
    expect(state.requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(state.requests[0]?.init).toMatchObject({ method: 'GET' });
    timeout.mockRestore();
  });
});

function profile(): StoredProfile {
  return {
    version: 1,
    baseUrl: 'https://api.video2ctx.dev',
    token: 'profile-session-token',
    createdAt: '2026-08-15T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
