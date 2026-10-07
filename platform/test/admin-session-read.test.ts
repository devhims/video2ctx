vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

import { Hono } from 'hono';
import { agentRoutes } from '../src/routes/agent/agent.index';
import { agentInstanceName, userAccountInstanceName } from '../src/agents/runtime/identity';
import { ApiError } from '../src/lib/http';
import type { App } from '../src/types';

const sessionId = '5a04cf06-ea91-4b07-b892-ce87f63954de';
const runId = '102992fd-7e50-47be-bc96-3508a2a5c9e0';
const version = 'a'.repeat(64);

async function harness() {
  const ownerId = 'session-owner';
  const user = { id: 'viewer', email: 'viewer@example.test', name: 'Viewer', emailVerified: true, role: 'admin', banned: false };
  const liveSession = { user, session: { impersonatedBy: null as string | null } };
  const getSession = vi.fn(async () => liveSession);
  const ownAccount = { getSession: vi.fn(async () => null), pendingAgentRun: vi.fn(async () => null) };
  const summary = { conversationId: sessionId, title: 'Customer session', latestMessagePreview: 'Please debug', lastRunId: runId,
    runCount: 1, createdAt: 100, updatedAt: 200 };
  const ownerAccount = { getSession: vi.fn(async () => summary), pendingAgentRun: vi.fn(async () => null) };
  const run = { conversationId: sessionId, runId, agentMessageId: crypto.randomUUID(), status: 'completed' };
  const runtime = {
    getConversation: vi.fn(async () => ({ messages: [], nextCursor: null })),
    getRun: vi.fn(async () => run), getRunProgress: vi.fn(async () => ({ run: { ...run, sessionId }, phase: 'completed', tools: [] })),
    getSessionAssets: vi.fn(async () => ({ assets: [], memories: [] })), getSessionAsset: vi.fn(async () => ({ text: 'Evidence' })),
    deleteSessionAssets: vi.fn(), deleteSessionMemory: vi.fn(), startRun: vi.fn(),
  };
  const ownerName = await userAccountInstanceName(ownerId);
  const ownerRuntimeName = await agentInstanceName(ownerId, sessionId);
  const getByName = vi.fn((name: string) => name === ownerRuntimeName ? runtime : {
    ...runtime, getConversation: async (): Promise<null> => null, getRun: async (): Promise<null> => null, getRunProgress: async (): Promise<null> => null,
    getSessionAssets: async (): Promise<null> => null, getSessionAsset: async (): Promise<null> => null,
    deleteSessionAssets: async (): Promise<null> => null, deleteSessionMemory: async (): Promise<null> => null,
  });
  const indexedOwners = vi.fn(async () => ({ results: [{ user_id: ownerId }] }));
  const env = {
    AGENT_RUNTIME_ENABLED: 'true', AGENT_ACCESS_MODE: 'all',
    DB: { prepare: (sql: string) => ({ bind: () => ({
      first: async () => ({ email: user.email, emailVerified: 1, agentAllowed: 0 }),
      all: sql.includes('agent_session_owners') ? indexedOwners : async () => { throw new Error(`Unexpected query: ${sql}`); },
    }) }) },
    USER_ACCOUNT: { getByName: vi.fn((name: string) => name === ownerName ? ownerAccount : ownAccount) },
    AGENT_RUNTIME: { getByName },
  } as unknown as Env;
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    c.set('principal', { user, method: c.req.header('x-api-key') ? 'api-key' : 'session', permissions: { data: ['read'] } });
    c.set('auth', { api: { getSession } } as any);
    await next();
  });
  app.onError((error, c) => error instanceof ApiError
    ? c.json({ error: { code: error.code, message: error.message } }, error.status as any) : c.json({ error: error.message }, 500));
  app.route('/v1', agentRoutes);
  const request = (path: string, init: RequestInit = {}) => app.request(`/v1/agent${path}`, {
    ...init, headers: { cookie: 'session=viewer', ...init.headers },
  }, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
  return { request, env, user, liveSession, getSession, ownAccount, ownerAccount, runtime, getByName, ownerRuntimeName, indexedOwners };
}

test('admin opens another user session through its existing link and owner runtime', async () => {
  const h = await harness();
  const response = await h.request(`/sessions/${sessionId}?limit=10`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sessionId, title: 'Customer session', readOnly: true });
  expect(h.getByName).toHaveBeenCalledWith(h.ownerRuntimeName);
  expect(h.runtime.getConversation).toHaveBeenCalledWith(sessionId, 'session-owner', { limit: 10, cursor: undefined });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('admin reads run state, live snapshots, evidence inventory and a saved asset from the same owner', async () => {
  const h = await harness();
  for (const path of [`/${sessionId}/runs/${runId}`, `/${sessionId}/runs/${runId}/events`,
    `/sessions/${sessionId}/assets`, `/sessions/${sessionId}/assets/${version}`]) {
    const response = await h.request(path);
    expect(response.status).toBe(200);
    if (path.endsWith('/events')) expect(await response.text()).toContain('event: snapshot');
    else await response.json();
  }
  expect(h.runtime.getRun).toHaveBeenCalledWith(runId);
  expect(h.runtime.getRunProgress).toHaveBeenCalledWith(runId);
  expect(h.runtime.getSessionAssets).toHaveBeenCalledWith(sessionId, 'session-owner');
  expect(h.runtime.getSessionAsset).toHaveBeenCalledWith(sessionId, 'session-owner', version);
  expect(h.getByName).toHaveBeenCalledWith(h.ownerRuntimeName);
});

test('admin debugging works without an Agent grant while admission and session listing still require that grant', async () => {
  const h = await harness();
  Object.assign(h.env, { AGENT_ACCESS_MODE: 'allowlist' });
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(200);
  expect((await h.request('/access')).status).toBe(403);
  expect((await h.request('/sessions')).status).toBe(403);
  expect((await h.request('', { method: 'POST', body: JSON.stringify({ message: 'Follow up', sessionId }) })).status).toBe(403);
  expect(h.runtime.startRun).not.toHaveBeenCalled();
});

test.each(['role', 'unverified', 'banned', 'impersonated', 'api-key', 'demo-header'])('cross-user reads remain hidden for %s', async scenario => {
  const h = await harness();
  const headers: Record<string, string> = {};
  if (scenario === 'role') h.user.role = 'user';
  if (scenario === 'unverified') h.user.emailVerified = false;
  if (scenario === 'banned') h.user.banned = true;
  if (scenario === 'impersonated') h.liveSession.session.impersonatedBy = 'another-admin';
  if (scenario === 'api-key') headers['x-api-key'] = 'aty_admin-key';
  if (scenario === 'demo-header') headers['x-demo-user'] = 'admin';
  headers['x-admin'] = 'true';
  for (const path of [`/sessions/${sessionId}`, `/${sessionId}/runs/${runId}`, `/${sessionId}/runs/${runId}/events`,
    `/sessions/${sessionId}/assets`, `/sessions/${sessionId}/assets/${version}`]) {
    expect((await h.request(path, { headers })).status).toBe(404);
  }
  expect(h.indexedOwners).not.toHaveBeenCalled();
  expect(h.runtime.getConversation).not.toHaveBeenCalled();
  expect(h.runtime.getRun).not.toHaveBeenCalled();
  expect(h.runtime.getSessionAsset).not.toHaveBeenCalled();
});

test('revoked admin access takes effect on the next read and does not trust cached claims', async () => {
  const h = await harness();
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(200);
  h.user.role = 'user';
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(404);
  expect(h.getSession).toHaveBeenLastCalledWith(expect.objectContaining({ query: { disableCookieCache: true, disableRefresh: true } }));
});

test('existing operator emails use the same live browser-session authorization', async () => {
  const h = await harness();
  h.user.role = 'user';
  h.env.ADMIN_EMAILS_SECRET = ' VIEWER@example.test ';
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(200);
});

test('queued sessions resolve through the owner index without reading the runtime', async () => {
  const h = await harness();
  h.ownerAccount.pendingAgentRun.mockResolvedValue({ run: {
    runId, userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), status: 'pending',
  }, admittedAt: 100, message: 'Waiting for admission' } as any);
  const queued = await h.request(`/sessions/${sessionId}`);
  expect(await queued.json()).toMatchObject({ readOnly: true, messages: [{ role: 'user', content: 'Waiting for admission' }, { role: 'assistant', status: 'pending' }] });
  expect(h.runtime.getConversation).not.toHaveBeenCalled();
});

test('owners read their own sessions without an admin probe, even while live auth is down', async () => {
  const h = await harness();
  h.user.id = 'session-owner';
  h.getSession.mockRejectedValue(new Error('Auth unavailable'));
  const response = await h.request(`/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ readOnly: false });
  for (const path of [`/${sessionId}/runs/${runId}`, `/${sessionId}/runs/${runId}/events`,
    `/sessions/${sessionId}/assets`, `/sessions/${sessionId}/assets/${version}`]) {
    expect((await h.request(path)).status).toBe(200);
  }
  expect(h.getSession).not.toHaveBeenCalled();
  expect(h.indexedOwners).not.toHaveBeenCalled();
});

test('missing, deleted and ambiguous sessions do not expose a runtime', async () => {
  const h = await harness();
  h.indexedOwners.mockResolvedValue({ results: [] });
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(404);
  h.indexedOwners.mockResolvedValue({ results: [{ user_id: 'session-owner' }] });
  h.ownerAccount.getSession.mockResolvedValue(null as any);
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(404);
  h.indexedOwners.mockResolvedValue({ results: [{ user_id: 'session-owner' }, { user_id: 'other-owner' }] });
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(404);
  expect(h.getByName).not.toHaveBeenCalled();
});

test('failed live authorization or owner lookup fails closed with a retryable error', async () => {
  const h = await harness();
  h.getSession.mockRejectedValueOnce(new Error('Auth unavailable'));
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(503);
  h.indexedOwners.mockRejectedValueOnce(new Error('DB unavailable'));
  expect((await h.request(`/sessions/${sessionId}`)).status).toBe(503);
  expect(h.getByName).not.toHaveBeenCalled();
});

test('admin status never redirects deletions to another user', async () => {
  const h = await harness();
  for (const path of [`/sessions/${sessionId}/assets`, `/sessions/${sessionId}/assets/${version}`, `/sessions/${sessionId}/memory/topic`]) {
    expect((await h.request(path, { method: 'DELETE' })).status).toBe(404);
  }
  expect(h.runtime.deleteSessionAssets).not.toHaveBeenCalled();
  expect(h.runtime.deleteSessionMemory).not.toHaveBeenCalled();
  expect(h.indexedOwners).not.toHaveBeenCalled();
});
