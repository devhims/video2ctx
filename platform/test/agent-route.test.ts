vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

import type { UserSessionPage, UserSessionSummary } from '../src/durable-objects/user-account';
import type { AgentConversationPage } from '../src/agents/runtime/conversation-restoration';

const creditBalance = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/entitlements', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/entitlements')>(),
  creditBalance,
}));

vi.mock('../src/middlewares/authentication', () => {
  const user = { id: 'agent-user', email: 'agent@example.com', name: 'Agent User' };
  const principal = { user, method: 'api-key' as const, apiKeyId: 'agent-key', permissions: { data: ['read'] } };
  return {
    establishPrincipal: async (c: any, next: () => Promise<void>) => {
      c.set('principal', principal);
      c.set('user', user);
      await next();
    },
    requireAccountPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireDataPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireSessionPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requirePrincipal: () => principal,
    requireUser: () => user,
  };
});

import { app } from '../src/index';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('agent routes', () => {
  beforeEach(() => {
    creditBalance.mockReset();
    creditBalance.mockResolvedValue(500);
  });

  test.each([
    '/v1/agent', '/v1/agent/sessions',
    '/v1/agent/sessions/f1611a8b-cb84-4305-a365-328bd06bedac',
    '/v1/agent/f1611a8b-cb84-4305-a365-328bd06bedac/runs/cd056140-7d4c-4516-bb9e-c97914439553',
  ])('denies non-admins before work or data access at %s', async (path) => {
    const harness = agentHarness();
    harness.adminUser.mockResolvedValue({ email: 'other@example.com', emailVerified: 1 });
    const response = await app.request(path, { method: path === '/v1/agent' ? 'POST' : 'GET',
      headers: { 'x-admin': 'true', 'x-user-email': 'agent@example.com' } }, harness.env, executionContext);
    expect(response.status).toBe(403);
    expect(harness.getByName).not.toHaveBeenCalled();
    expect(harness.accountGetByName).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  test('requires a verified email even for an allowlisted account', async () => {
    const harness = agentHarness();
    harness.adminUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 0 });
    expect((await postAgent(harness.env, 'unverified-admin', { message: 'Research' })).status).toBe(403);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('allows the configured admin email with normalized case and whitespace', async () => {
    const harness = agentHarness();
    Object.assign(harness.env, { ADMIN_EMAILS_SECRET: '  ADMIN@EXAMPLE.COM  ' });
    harness.adminUser.mockResolvedValue({ email: 'admin@example.com', emailVerified: 1 });
    expect((await postAgent(harness.env, 'configured-admin', { message: 'Research' })).status).toBe(202);
  });

  test.each([undefined, 'admins', 'invalid'])('fails closed for access mode %s', async (mode) => {
    const harness = agentHarness();
    Object.assign(harness.env, { AGENT_ACCESS_MODE: mode, ADMIN_EMAILS_SECRET: '' });
    const response = await postAgent(harness.env, 'closed-access-mode', { message: 'Research' });
    expect([403, 503]).toContain(response.status);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('supports an explicit rollout to authenticated non-admin users', async () => {
    const harness = agentHarness();
    Object.assign(harness.env, { AGENT_ACCESS_MODE: 'all', ADMIN_EMAILS_SECRET: '' });
    expect((await postAgent(harness.env, 'public-rollout-test', { message: 'Research' })).status).toBe(202);
    expect(harness.adminUser).not.toHaveBeenCalled();
  });

  test('fails closed when the current admin record cannot be checked', async () => {
    const harness = agentHarness();
    harness.adminUser.mockRejectedValue(new Error('Database unavailable'));
    expect((await postAgent(harness.env, 'unavailable-admin', { message: 'Research' })).status).toBe(503);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('does not start a run when its deletion registry cannot be written', async () => {
    const harness = agentHarness();
    harness.registerConversation.mockRejectedValueOnce(new Error('Account deletion is in progress.'));
    const response = await postAgent(harness.env, 'deleted-account-request', { message: 'Research' });
    expect(response.status).toBe(503);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('routes independent admissions to different conversation Durable Objects', async () => {
    const harness = agentHarness();
    const first = await postAgent(harness.env, 'independent-call-1', { message: 'Research topic one' });
    const second = await postAgent(harness.env, 'independent-call-2', { message: 'Research topic two' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstReceipt = await first.json<{ conversationId: string }>();
    const secondReceipt = await second.json<{ conversationId: string }>();
    expect(firstReceipt.conversationId).not.toBe(secondReceipt.conversationId);
    expect(harness.instanceNames[0]).not.toBe(harness.instanceNames[1]);
  });

  test('records an admitted conversation in the authenticated user account', async () => {
    const harness = agentHarness();
    const response = await postAgent(harness.env, 'catalog-admission-1', {
      message: 'Research durable agent memory',
    });

    expect(response.status).toBe(202);
    const receipt = await response.json<{ conversationId: string; runId: string }>();
    expect(harness.accountInstanceNames).toHaveLength(1);
    expect(harness.registerConversation.mock.invocationCallOrder[0]).toBeLessThan(harness.startRun.mock.invocationCallOrder[0]!);
    expect(harness.recordSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: receipt.conversationId,
      runId: receipt.runId,
      message: 'Research durable agent memory',
    }));
  });

  test('returns stable message identities, conversation turn, and zero execution counts at admission', async () => {
    const harness = agentHarness();
    const response = await postAgent(harness.env, 'stable-turn-identities', {
      message: 'Research durable turn identities',
    });

    expect(response.status).toBe(202);
    const receipt = await response.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({
      userMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      assistantMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      conversationTurn: 1,
      modelStepCount: 0,
      toolCallCount: 0,
      status: 'pending',
    });
    expect(receipt).not.toHaveProperty('turnOrdinal');
  });

  test('defaults to compact admission identities without changing the run request', async () => {
    const harness = agentHarness();
    const response = await app.request('/v1/agent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'compact-admission' },
      body: JSON.stringify({ message: 'Research design' }),
    }, harness.env, executionContext);
    expect(response.status).toBe(202);
    const receipt = await response.json<Record<string, unknown>>();
    expect(Object.keys(receipt).sort()).toEqual(['assistantMessageId', 'conversationId', 'runId', 'status']);
    expect(harness.startRun.mock.calls[0]?.[0]).not.toHaveProperty('responseFormat');
  });

  test('projects the same stored run in either format without starting work', async () => {
    const harness = agentHarness();
    const stored = { runId: '102992fd-7e50-47be-bc96-3508a2a5c9e0', conversationId: '5a04cf06-ea91-4b07-b892-ce87f63954de',
      assistantMessageId: 'cd056140-7d4c-4516-bb9e-c97914439553', userMessageId: 'f1611a8b-cb84-4305-a365-328bd06bedac',
      status: 'running', conversationTurn: 1, modelStepCount: 2, toolCallCount: 3 };
    harness.getRun.mockResolvedValue(stored);
    const path = `/v1/agent/${stored.conversationId}/runs/${stored.runId}`;
    const legacy = await app.request(`${path}?responseFormat=legacy`, {}, harness.env, executionContext);
    expect(await legacy.json()).toEqual(stored);
    const compact = await app.request(`${path}?responseFormat=compact&include=diagnostics`, {}, harness.env, executionContext);
    expect(compact.status).toBe(200);
    expect(await compact.json()).toMatchObject({ status: 'running', diagnostics: { toolCallCount: 3 } });
    expect(compact.headers.get('Cache-Control')).toBe('no-store');
    expect(harness.startRun).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  test.each(['responseFormat=bad', 'responseFormat=legacy&include=artifacts', 'responseFormat=compact&include=bad'])('rejects invalid response options before admission: %s', async query => {
    const harness = agentHarness();
    const response = await app.request(`/v1/agent?${query}`, { method: 'POST' }, harness.env, executionContext);
    expect(response.status).toBe(422);
    expect(harness.startRun).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  test('lists and lexically searches sessions from the authenticated user account', async () => {
    const harness = agentHarness();
    const conversationId = '5a04cf06-ea91-4b07-b892-ce87f63954de';
    const runId = '102992fd-7e50-47be-bc96-3508a2a5c9e0';
    harness.listSessions.mockResolvedValueOnce({
      sessions: [{
        conversationId,
        title: 'Research Durable Objects',
        latestMessagePreview: 'Compare user and conversation objects',
        lastRunId: runId,
        runCount: 2,
        createdAt: 100,
        updatedAt: 200,
      }],
      nextCursor: { updatedAt: 200, conversationId },
    });

    const response = await app.request(
      '/v1/agent/sessions?q=durable%20objects&limit=10',
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(200);
    const page = await response.json<{ sessions: unknown[]; nextCursor: string }>();
    expect(page.sessions).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(harness.listSessions).toHaveBeenCalledWith({
      query: 'durable objects',
      limit: 10,
      cursor: undefined,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('rejects malformed session cursors before calling the user account', async () => {
    const harness = agentHarness();
    const response = await app.request(
      '/v1/agent/sessions?cursor=not-a-cursor',
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_AGENT_SESSION_CURSOR' },
    });
    expect(harness.accountGetByName).not.toHaveBeenCalled();
  });

  test('restores an owned conversation as ordered user and assistant messages', async () => {
    const harness = agentHarness();
    const conversationId = '5a04cf06-ea91-4b07-b892-ce87f63954de';
    const runId = '102992fd-7e50-47be-bc96-3508a2a5c9e0';
    const userMessageId = 'ca71df55-6174-42ef-9458-d4700e5e7b84';
    const assistantMessageId = '03fab2db-c1ea-44c6-a79a-243e66d788d9';
    harness.getSession.mockResolvedValue({
      conversationId,
      title: 'Research Durable Objects',
      latestMessagePreview: 'Compare object storage',
      lastRunId: runId,
      runCount: 1,
      createdAt: 100,
      updatedAt: 200,
    });
    harness.getConversation.mockResolvedValueOnce({
      messages: [
        {
          messageId: userMessageId,
          runId,
          conversationTurn: 1,
          parentMessageId: null,
          role: 'user',
          status: 'completed',
          content: 'Compare object storage',
          createdAt: 100,
          updatedAt: 100,
        },
        {
          messageId: assistantMessageId,
          runId,
          conversationTurn: 1,
          parentMessageId: userMessageId,
          role: 'assistant',
          status: 'completed',
          content: 'Here is the comparison.',
          createdAt: 100,
          updatedAt: 200,
        },
      ],
      nextCursor: { beforeTurnOrdinal: 1 },
    });

    const response = await app.request(
      `/v1/agent/sessions/${conversationId}?limit=25`,
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(200);
    const restored = await response.json<{ messages: Array<{ role: string }>; nextCursor: string }>();
    expect(restored.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(restored.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(restored)).not.toContain('toolCalls');
    expect(harness.getSession).toHaveBeenCalledWith(conversationId);
    expect(harness.getConversation).toHaveBeenCalledWith(conversationId, 'agent-user', {
      limit: 25,
      cursor: undefined,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    harness.getConversation.mockResolvedValueOnce({ messages: [], nextCursor: null });
    const olderPage = await app.request(
      `/v1/agent/sessions/${conversationId}?limit=25&cursor=${encodeURIComponent(restored.nextCursor)}`,
      {},
      harness.env,
      executionContext,
    );
    expect(olderPage.status).toBe(200);
    expect(harness.getConversation).toHaveBeenLastCalledWith(conversationId, 'agent-user', {
      limit: 25,
      cursor: { beforeTurnOrdinal: 1 },
    });
  });

  test('does not read a conversation runtime when the user catalog has no session', async () => {
    const harness = agentHarness();
    const conversationId = '5a04cf06-ea91-4b07-b892-ce87f63954de';
    harness.getSession.mockResolvedValueOnce(null);

    const response = await app.request(
      `/v1/agent/sessions/${conversationId}`,
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'AGENT_SESSION_NOT_FOUND' } });
    expect(harness.getConversation).not.toHaveBeenCalled();
  });

  test('rejects a malformed conversation restoration cursor', async () => {
    const harness = agentHarness();
    const conversationId = '5a04cf06-ea91-4b07-b892-ce87f63954de';
    const response = await app.request(
      `/v1/agent/sessions/${conversationId}?cursor=not-a-cursor`,
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_AGENT_CONVERSATION_CURSOR' },
    });
    expect(harness.accountGetByName).not.toHaveBeenCalled();
  });

  test('asks the caller to retry the same key when catalog recording fails after admission', async () => {
    const harness = agentHarness();
    harness.recordSession.mockRejectedValueOnce(new Error('catalog unavailable'));

    const response = await postAgent(harness.env, 'catalog-failure-1', {
      message: 'Research session catalogs',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'AGENT_SESSION_CATALOG_UNAVAILABLE',
        message: expect.stringContaining('same Idempotency-Key'),
      },
    });
    expect(harness.startRun).toHaveBeenCalledOnce();
  });

  test('routes follow-up admissions for one conversation to the same Durable Object', async () => {
    const harness = agentHarness();
    const conversationId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';

    await postAgent(harness.env, 'conversation-call-1', { message: 'First message', conversationId });
    await postAgent(harness.env, 'conversation-call-2', { message: 'Follow-up message', conversationId });

    expect(harness.instanceNames).toHaveLength(2);
    expect(harness.instanceNames[0]).toBe(harness.instanceNames[1]);
    expect(harness.startRun.mock.calls[0]?.[0]).toMatchObject({ conversationId });
    expect(harness.startRun.mock.calls[1]?.[0]).toMatchObject({ conversationId });
  });

  test('forwards an explicit parent message for a branched follow-up', async () => {
    const harness = agentHarness();
    const conversationId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
    const parentMessageId = '8a8671bd-5387-43dc-9031-65a69af2a40e';

    const response = await postAgent(harness.env, 'branched-follow-up', {
      message: 'Continue from that answer',
      conversationId,
      parentMessageId,
    });

    expect(response.status).toBe(202);
    expect(harness.startRun.mock.calls[0]?.[0]).toMatchObject({ conversationId, parentMessageId });
  });

  test('returns a conversation conflict reported by the Durable Object', async () => {
    const harness = agentHarness();
    harness.startRun.mockResolvedValueOnce({
      rejected: true,
      status: 409,
      code: 'AGENT_CONVERSATION_BUSY',
      message: 'Wait for the active run to finish.',
    } as never);

    const response = await postAgent(harness.env, 'busy-follow-up', {
      message: 'Continue the active conversation',
      conversationId: 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AGENT_CONVERSATION_BUSY' },
    });
  });

  test('derives a stable conversation and Durable Object for an idempotent retry', async () => {
    const harness = agentHarness();

    const first = await postAgent(harness.env, 'retry-admission-1', { message: 'Retry this safely' });
    const second = await postAgent(harness.env, 'retry-admission-1', { message: 'Retry this safely' });

    const firstReceipt = await first.json<{ conversationId: string }>();
    const secondReceipt = await second.json<{ conversationId: string }>();
    expect(firstReceipt.conversationId).toBe(secondReceipt.conversationId);
    expect(harness.instanceNames[0]).toBe(harness.instanceNames[1]);
  });

  test('requires a valid idempotency key and request body', async () => {
    const harness = agentHarness();
    const missingKey = await app.request('/v1/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Research this' }),
    }, harness.env, executionContext);
    expect(missingKey.status).toBe(422);
    await expect(missingKey.json()).resolves.toMatchObject({ error: { code: 'INVALID_IDEMPOTENCY_KEY' } });

    const invalidBody = await postAgent(harness.env, 'invalid-body-key', { message: '' });
    expect(invalidBody.status).toBe(422);
    await expect(invalidBody.json()).resolves.toMatchObject({ error: { code: 'INVALID_AGENT_REQUEST' } });
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  test('honors the feature flag and available-credit admission checks', async () => {
    const disabled = agentHarness('false');
    const disabledResponse = await postAgent(disabled.env, 'disabled-agent-key', { message: 'Research this' });
    expect(disabledResponse.status).toBe(503);
    await expect(disabledResponse.json()).resolves.toMatchObject({ error: { code: 'AGENT_DISABLED' } });
    expect(disabled.getByName).not.toHaveBeenCalled();

    const enabled = agentHarness();
    creditBalance.mockResolvedValueOnce(0);
    const noCredits = await postAgent(enabled.env, 'no-credit-agent', { message: 'Research this' });
    expect(noCredits.status).toBe(402);
    await expect(noCredits.json()).resolves.toMatchObject({ error: { code: 'INSUFFICIENT_CREDITS' } });
    expect(noCredits.headers.get('X-Credits-Charged')).toBe('0');
    expect(enabled.getByName).not.toHaveBeenCalled();
  });

  test('retrieves a run from its conversation Durable Object', async () => {
    const conversationId = 'f1611a8b-cb84-4305-a365-328bd06bedac';
    const runId = 'cd056140-7d4c-4516-bb9e-c97914439553';
    const harness = agentHarness();
    harness.getRun.mockResolvedValueOnce({
      runId,
      conversationId,
      assistantMessageId: 'ee25e9fd-edad-468d-8941-16cfdb0ba4f2',
      conversationTurn: 1,
      modelStepCount: 3,
      toolCallCount: 6,
      status: 'running',
    });

    const response = await app.request(
      `/v1/agent/${conversationId}/runs/${runId}`,
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId,
      conversationId,
      assistantMessageId: 'ee25e9fd-edad-468d-8941-16cfdb0ba4f2',
      status: 'running',
    });
    expect(harness.getRun).toHaveBeenCalledWith(runId);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('returns a stable not-found response for a missing run', async () => {
    const harness = agentHarness();
    harness.getRun.mockResolvedValueOnce(null);
    const response = await app.request(
      '/v1/agent/f1611a8b-cb84-4305-a365-328bd06bedac/runs/cd056140-7d4c-4516-bb9e-c97914439553',
      {},
      harness.env,
      executionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'AGENT_RUN_NOT_FOUND' } });
  });
});

function postAgent(env: Env, idempotencyKey: string, input: Record<string, unknown>) {
  return app.request('/v1/agent?responseFormat=legacy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(input),
  }, env, executionContext);
}

function agentHarness(enabled = 'true') {
  const adminUser = vi.fn(async () => ({ email: 'agent@example.com', emailVerified: 1 }));
  const instanceNames: string[] = [];
  let conversationTurn = 0;
  const startRun = vi.fn(async (request: { conversationId: string }) => {
    conversationTurn += 1;
    return {
      runId: crypto.randomUUID(),
      conversationId: request.conversationId,
      userMessageId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      conversationTurn,
      modelStepCount: 0,
      toolCallCount: 0,
      status: 'pending' as const,
    };
  });
  const getRun = vi.fn(async () => null as unknown);
  const getConversation = vi.fn(async (): Promise<AgentConversationPage | null> => null);
  const registerConversation = vi.fn(async () => undefined);
  const recordSession = vi.fn(async () => undefined);
  const listSessions = vi.fn(async (): Promise<UserSessionPage> => ({ sessions: [], nextCursor: null }));
  const getSession = vi.fn(async (): Promise<UserSessionSummary | null> => null);
  const getByName = vi.fn((name: string) => {
    instanceNames.push(name);
    return { startRun, getRun, getConversation };
  });
  const accountInstanceNames: string[] = [];
  const accountGetByName = vi.fn((name: string) => {
    accountInstanceNames.push(name);
    return { registerConversation, recordSession, listSessions, getSession };
  });
  return {
    env: {
      AGENT_RUNTIME_ENABLED: enabled,
      AGENT_ACCESS_MODE: 'admins',
      ADMIN_EMAILS_SECRET: 'agent@example.com',
      DB: { prepare: () => ({ bind: () => ({ first: adminUser }) }) },
      AGENT_RUNTIME: { getByName },
      USER_ACCOUNT: { getByName: accountGetByName },
    } as unknown as Env,
    getByName,
    instanceNames,
    adminUser,
    startRun,
    getRun,
    getConversation,
    accountGetByName,
    accountInstanceNames,
    registerConversation,
    recordSession,
    listSessions,
    getSession,
  };
}
