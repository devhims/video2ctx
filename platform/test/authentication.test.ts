import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { App } from '../src/types';
import { jsonError } from '../src/lib/http';

const authState = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/lib/auth', () => ({
  createAuth: vi.fn(() => ({
    api: {
      verifyApiKey: authState.verifyApiKey,
      getSession: authState.getSession,
    },
  })),
}));

import {
  establishPrincipal,
  requireAccountPrincipal,
  requireDataPrincipal,
  requirePrincipal,
  requireSessionPrincipal,
} from '../src/middlewares/authentication';

const testApp = new Hono<App>();
testApp.use('*', async (c, next) => { c.set('requestId', 'request-1'); await next(); });
testApp.use('*', establishPrincipal);
testApp.use('/data', requireDataPrincipal);
testApp.get('/data', (c) => c.json(requirePrincipal(c)));
testApp.use('/account-data', requireAccountPrincipal);
testApp.get('/account-data', (c) => c.json(requirePrincipal(c)));
testApp.use('/session', requireSessionPrincipal);
testApp.get('/session', (c) => c.json(requirePrincipal(c)));
testApp.onError((error, c) => jsonError(c, error));

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('request authentication', () => {
  beforeEach(() => {
    authState.verifyApiKey.mockReset();
    authState.getSession.mockReset();
  });

  test('accepts a Bearer API key and gives it precedence over a session cookie', async () => {
    authState.verifyApiKey.mockResolvedValue(validKey());
    authState.getSession.mockResolvedValue(session());

    const response = await request('/data', {
      authorization: 'Bearer aty_secret',
      cookie: 'better-auth.session_token=session-token',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ method: 'api-key', apiKeyId: 'key-1' });
    expect(authState.verifyApiKey).toHaveBeenCalledWith({ body: { key: 'aty_secret' } });
    expect(authState.getSession).not.toHaveBeenCalled();
  });

  test('does not fall back to a cookie when a supplied key is invalid', async () => {
    authState.verifyApiKey.mockResolvedValue({
      valid: false, key: null, error: { code: 'KEY_NOT_FOUND', message: 'missing' },
    });

    const response = await request('/data', {
      'x-api-key': 'aty_invalid',
      cookie: 'better-auth.session_token=session-token',
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_API_KEY' } });
    expect(authState.getSession).not.toHaveBeenCalled();
  });

  test('does not fall back to a cookie when a Bearer key is invalid', async () => {
    authState.verifyApiKey.mockResolvedValue({
      valid: false, key: null, error: { code: 'KEY_NOT_FOUND', message: 'missing' },
    });

    const response = await request('/data', {
      authorization: 'Bearer aty_invalid',
      cookie: 'better-auth.session_token=session-token',
    });

    expect(response.status).toBe(401);
    expect(authState.getSession).not.toHaveBeenCalled();
  });

  test('rejects ambiguous or malformed Authorization credentials', async () => {
    const conflicting = await request('/data', {
      authorization: 'Bearer aty_one',
      'x-api-key': 'aty_two',
    });
    expect(conflicting.status).toBe(401);
    await expect(conflicting.json()).resolves.toMatchObject({
      error: { code: 'CONFLICTING_API_KEY_CREDENTIALS' },
    });
    expect(authState.verifyApiKey).not.toHaveBeenCalled();

    const malformed = await request('/data', { authorization: 'Basic abc123' });
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'INVALID_AUTHORIZATION' } });
  });

  test('does not let empty credential headers fall back to a session cookie', async () => {
    const emptyBearer = await request('/data', {
      authorization: '',
      cookie: 'better-auth.session_token=session-token',
    });
    expect(emptyBearer.status).toBe(401);
    await expect(emptyBearer.json()).resolves.toMatchObject({ error: { code: 'INVALID_AUTHORIZATION' } });

    const emptyLegacy = await request('/data', {
      'x-api-key': '',
      cookie: 'better-auth.session_token=session-token',
    });
    expect(emptyLegacy.status).toBe(401);
    await expect(emptyLegacy.json()).resolves.toMatchObject({ error: { code: 'INVALID_API_KEY' } });
    expect(authState.getSession).not.toHaveBeenCalled();
  });

  test('maps API-key rate limits and infrastructure failures to stable statuses', async () => {
    authState.verifyApiKey.mockResolvedValueOnce({
      valid: false, key: null, error: { code: 'RATE_LIMITED', message: 'limited' },
    });
    const limited = await request('/data', { 'x-api-key': 'aty_limited' });
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'API_KEY_RATE_LIMITED' } });

    authState.verifyApiKey.mockRejectedValueOnce(new Error('D1 unavailable'));
    const unavailable = await request('/data', { 'x-api-key': 'aty_error' });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });
  });

  test('accepts sessions for data and rejects API keys on session-only routes', async () => {
    authState.getSession.mockResolvedValue(session());
    const sessionResponse = await request('/data', { cookie: 'better-auth.session_token=session-token' });
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({ method: 'session' });

    authState.verifyApiKey.mockResolvedValue(validKey());
    const keyResponse = await request('/session', { 'x-api-key': 'aty_secret' });
    expect(keyResponse.status).toBe(403);
    await expect(keyResponse.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
  });

  test('classifies a non-API-key Bearer token as a restricted CLI session', async () => {
    authState.getSession.mockResolvedValue(session());

    const dataResponse = await request('/data', { authorization: 'Bearer cli-session-token' });
    expect(dataResponse.status).toBe(200);
    await expect(dataResponse.json()).resolves.toMatchObject({
      method: 'cli-session',
      permissions: { data: ['read'], account: ['access'] },
    });

    const accountResponse = await request('/account-data', { authorization: 'Bearer cli-session-token' });
    expect(accountResponse.status).toBe(200);

    const sessionOnlyResponse = await request('/session', { authorization: 'Bearer cli-session-token' });
    expect(sessionOnlyResponse.status).toBe(403);
    await expect(sessionOnlyResponse.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    expect(authState.verifyApiKey).not.toHaveBeenCalled();
  });

  test('does not let an invalid CLI Bearer token fall back to a browser cookie', async () => {
    authState.getSession.mockResolvedValue(null);

    const response = await request('/data', {
      authorization: 'Bearer invalid-cli-session',
      cookie: 'better-auth.session_token=valid-browser-session',
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_SESSION_TOKEN' } });
    expect(authState.getSession).toHaveBeenCalledOnce();
  });

  test('returns 403 when a valid API key lacks the route permission', async () => {
    authState.verifyApiKey.mockResolvedValue({
      ...validKey(),
      key: { ...validKey().key, permissions: {} },
    });

    const response = await request('/data', { 'x-api-key': 'aty_restricted' });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'API_KEY_PERMISSION_REQUIRED' } });
  });

  test('allows personal keys to access routine account data with account permission', async () => {
    authState.verifyApiKey.mockResolvedValue(validKey());
    const allowed = await request('/account-data', { authorization: 'Bearer aty_personal' });
    expect(allowed.status).toBe(200);

    authState.verifyApiKey.mockResolvedValue({
      ...validKey(),
      key: { ...validKey().key, permissions: { data: ['read'] } },
    });
    const restricted = await request('/account-data', { authorization: 'Bearer aty_data_only' });
    expect(restricted.status).toBe(403);
    await expect(restricted.json()).resolves.toMatchObject({ error: { code: 'API_KEY_PERMISSION_REQUIRED' } });
  });

  test('rejects demo authentication in production', async () => {
    const response = await request('/data', { 'x-demo-user': 'local-beta' }, 'production');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'DEMO_AUTH_DISABLED' } });
  });
});

describe('API key migration', () => {
  test('uses the Better Auth 1.6 config/reference schema and hashed-key display fields', () => {
    const sql = readFileSync(new URL('../migrations/0002_api_keys.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE apikey');
    expect(sql).toContain('configId TEXT NOT NULL');
    expect(sql).toContain('referenceId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE');
    expect(sql).toContain('key TEXT NOT NULL');
    expect(sql).toContain('start TEXT');
    expect(sql).toContain('rateLimitMax INTEGER DEFAULT 60');
  });

  test('expands existing personal keys to routine account operations', () => {
    const sql = readFileSync(new URL('../migrations/0003_expand_api_key_permissions.sql', import.meta.url), 'utf8');
    expect(sql).toContain('UPDATE apikey');
    expect(sql).toContain('{"data":["read"],"account":["access"]}');
  });

  test('removes the superseded D1 response-cache table', () => {
    const sql = readFileSync(new URL('../migrations/0004_remove_d1_response_cache.sql', import.meta.url), 'utf8');
    expect(sql).toContain('DROP TABLE entity_snapshots');
  });

  test('adds cascading ownership constraints to private documents', () => {
    const sql = readFileSync(new URL('../migrations/0005_documents_foreign_keys.sql', import.meta.url), 'utf8');
    expect(sql).toContain('user_id TEXT REFERENCES user(id) ON DELETE CASCADE');
    expect(sql).toContain('project_id TEXT REFERENCES projects(id) ON DELETE CASCADE');
    expect(sql).toContain('search_item_id TEXT');
  });

  test('adds the Better Auth device authorization schema', () => {
    const sql = readFileSync(new URL('../migrations/0013_device_authorization.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE deviceCode');
    expect(sql).toContain('deviceCode TEXT NOT NULL UNIQUE');
    expect(sql).toContain('userCode TEXT NOT NULL UNIQUE');
    expect(sql).toContain('userId TEXT REFERENCES user(id) ON DELETE CASCADE');
    expect(sql).toContain('pollingInterval INTEGER');
    expect(sql).toContain('clientId TEXT');
    expect(sql).toContain('scope TEXT');
  });
});

async function request(path: string, headers: Record<string, string>, environment = 'development') {
  const env = {
    ENVIRONMENT: environment,
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({ id: 'user-1', email: 'user@example.com', name: 'User' })),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    },
  } as unknown as Env;
  return testApp.request(path, { headers }, env, executionContext);
}

function validKey() {
  return {
    valid: true,
    error: null,
    key: {
      id: 'key-1',
      referenceId: 'user-1',
      permissions: { data: ['read'], account: ['access'] },
    },
  };
}

function session() {
  return { user: { id: 'user-1', email: 'user@example.com', name: 'User' }, session: { id: 'session-1' } };
}
