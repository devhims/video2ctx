vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

import type { UserSessionPage, UserSessionSummary } from '../src/durable-objects/user-account';
import type { AgentConversationPage } from '../src/agents/runtime/conversation-restoration';
import type { AgentAdmission } from '../src/agents/contracts';

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
import { withSessionId } from '../src/agents/response';

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
    '/v1/agent', '/v1/agent/access', '/v1/agent/sessions',
    '/v1/agent/f1611a8b-cb84-4305-a365-328bd06bedac/runs/cd056140-7d4c-4516-bb9e-c97914439553/events',
    '/v1/agent/sessions/f1611a8b-cb84-4305-a365-328bd06bedac',
    '/v1/agent/f1611a8b-cb84-4305-a365-328bd06bedac/runs/cd056140-7d4c-4516-bb9e-c97914439553',
  ])('denies unlisted accounts before work or data access at %s', async (path) => {
    const harness = agentHarness();
    harness.accessUser.mockResolvedValue({ email: 'other@example.com', emailVerified: 1 });
    const response = await app.request(path, { method: path === '/v1/agent' ? 'POST' : 'GET',
      headers: { 'x-admin': 'true', 'x-user-email': 'agent@example.com' } }, harness.env, executionContext);
    expect(response.status).toBe(403);
    expect(harness.getByName).not.toHaveBeenCalled();
    expect(harness.accountGetByName).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  test('exposes access eligibility without starting work or exposing the allowlist', async () => {
    const harness = agentHarness();
    const response = await app.request('/v1/agent/access', {}, harness.env, executionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(harness.accessUser).toHaveBeenCalledOnce();
    expect(harness.getByName).not.toHaveBeenCalled();
    expect(harness.accountGetByName).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  test.each([
    { AGENT_RUNTIME_ENABLED: 'false' },
    { AGENT_ACCESS_MODE: 'invalid' },
  ])('fails closed on access discovery with %o', async configuration => {
    const harness = agentHarness();
    Object.assign(harness.env, configuration);
    const response = await app.request('/v1/agent/access', {}, harness.env, executionContext);
    expect([403, 503]).toContain(response.status);
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  test('accepts sessionId for follow-ups and preserves the existing durable identity', async () => {
    const harness = agentHarness();
    const sessionId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
    const response = await postAgent(harness.env, { message: 'Continue', sessionId });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ sessionId });
    expect(harness.startRun.mock.calls[0]?.[0]).toMatchObject({ conversationId: sessionId });
    expect(harness.startRun.mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
    await postAgent(harness.env, { message: 'Continue', conversationId: sessionId });
    expect(harness.instanceNames[0]).toBe(harness.instanceNames[1]);
  });

  test('rejects conflicting session aliases before admission or billing', async () => {
    const harness = agentHarness();
    const response = await postAgent(harness.env, {
      message: 'Continue', sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(422);
    expect(harness.startRun).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
  });

  test('requires a verified email even for an allowlisted account', async () => {
    const harness = agentHarness();
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 0 });
    expect((await postAgent(harness.env, { message: 'Research' })).status).toBe(403);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test.each([undefined, 'allowlist', 'admins', 'invalid'])('fails closed for access mode %s', async (mode) => {
    const harness = agentHarness();
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 1, agentAllowed: 0 });
    Object.assign(harness.env, { AGENT_ACCESS_MODE: mode });
    const response = await postAgent(harness.env, { message: 'Research' });
    expect([403, 503]).toContain(response.status);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('supports an explicit rollout to authenticated non-admin users', async () => {
    const harness = agentHarness();
    Object.assign(harness.env, { AGENT_ACCESS_MODE: 'all' });
    expect((await postAgent(harness.env, { message: 'Research' })).status).toBe(202);
    expect(harness.accessUser).not.toHaveBeenCalled();
  });

  test('fails closed when the current access record cannot be checked', async () => {
    const harness = agentHarness();
    harness.accessUser.mockRejectedValue(new Error('Database unavailable'));
    expect((await postAgent(harness.env, { message: 'Research' })).status).toBe(503);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('D1 grants and revocations take effect on the next request with the same credentials', async () => {
    const harness = agentHarness();
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 1, agentAllowed: 0 });
    const check = () => app.request('/v1/agent/access', {}, harness.env, executionContext);
    expect((await check()).status).toBe(403);
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 1, agentAllowed: 1 });
    expect((await check()).status).toBe(200);
    expect((await postAgent(harness.env, { message: 'Research' })).status).toBe(202);
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 1, agentAllowed: 0 });
    expect((await check()).status).toBe(403);
  });

  test.each([undefined, 'allowlist', 'admins'])('admin membership alone never grants Agent access in mode %s', async mode => {
    const harness = agentHarness();
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 1, agentAllowed: 0 });
    Object.assign(harness.env, { AGENT_ACCESS_MODE: mode, ADMIN_EMAILS_SECRET: 'agent@example.com' });
    const response = await app.request('/v1/agent/access', {}, harness.env, executionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_ACCESS_REQUIRED' } });
  });

  test('Agent access does not grant administrative job access', async () => {
    const harness = agentHarness();
    Object.assign(harness.env, { ADMIN_EMAILS_SECRET: 'operator@example.com' });
    expect((await app.request('/v1/agent/access', {}, harness.env, executionContext)).status).toBe(200);
    const response = await app.request('/v1/admin/jobs', {}, harness.env, executionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } });
  });

  test('D1 membership still requires a verified current email', async () => {
    const harness = agentHarness();
    harness.accessUser.mockResolvedValue({ email: 'agent@example.com', emailVerified: 0, agentAllowed: 1 });
    expect((await postAgent(harness.env, { message: 'Research' })).status).toBe(403);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('does not start a run when its deletion registry cannot be written', async () => {
    const harness = agentHarness();
    harness.registerConversation.mockRejectedValueOnce(new Error('Account deletion is in progress.'));
    const response = await postAgent(harness.env, { message: 'Research' });
    expect(response.status).toBe(503);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('routes independent admissions to different conversation Durable Objects', async () => {
    const harness = agentHarness();
    const first = await postAgent(harness.env, { message: 'Research topic one' });
    const second = await postAgent(harness.env, { message: 'Research topic two' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstReceipt = await first.json<{ sessionId: string }>();
    const secondReceipt = await second.json<{ sessionId: string }>();
    expect(firstReceipt.sessionId).not.toBe(secondReceipt.sessionId);
    expect(harness.instanceNames[0]).not.toBe(harness.instanceNames[1]);
  });

  test('records an admitted conversation in the authenticated user account', async () => {
    const harness = agentHarness();
    const response = await postAgent(harness.env, {
      message: 'Research durable agent memory',
    });

    expect(response.status).toBe(202);
    const receipt = await response.json<{ sessionId: string; runId: string }>();
    expect(harness.accountInstanceNames).toHaveLength(1);
    expect(harness.registerConversation.mock.invocationCallOrder[0]).toBeLessThan(harness.startRun.mock.invocationCallOrder[0]!);
    expect(harness.recordSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: receipt.sessionId,
      runId: receipt.runId,
      message: 'Research durable agent memory',
    }));
  });

  test('returns stable message identities, conversation turn, and zero execution counts at admission', async () => {
    const harness = agentHarness();
    const response = await postAgent(harness.env, {
      message: 'Research durable turn identities',
    });

    expect(response.status).toBe(202);
    const receipt = await response.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({
      userMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      agentMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      conversationTurn: 1,
      modelStepCount: 0,
      toolCallCount: 0,
      status: 'pending',
    });
    expect(receipt).not.toHaveProperty('turnOrdinal');
    const timing = response.headers.get('Server-Timing');
    for (const stage of ['preflight', 'credits', 'register', 'start_run', 'session']) expect(timing).toContain(`${stage};dur=`);
    expect(timing).not.toContain('stable-turn-identities');
  });

  test('defaults to compact admission identities without changing the run request', async () => {
    const harness = agentHarness();
    const response = await app.request('/v1/agent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Research design' }),
    }, harness.env, executionContext);
    expect(response.status).toBe(202);
    const receipt = await response.json<Record<string, unknown>>();
    expect(Object.keys(receipt).sort()).toEqual(['agentMessageId', 'request', 'runId', 'sessionId', 'status']);
    expect(receipt).toHaveProperty('request.message', 'Research design');
    expect(harness.startRun.mock.calls[0]?.[0]).not.toHaveProperty('responseFormat');
  });

  test('projects the same stored run in either format without starting work', async () => {
    const harness = agentHarness();
    const stored = { runId: '102992fd-7e50-47be-bc96-3508a2a5c9e0', conversationId: '5a04cf06-ea91-4b07-b892-ce87f63954de',
      agentMessageId: 'cd056140-7d4c-4516-bb9e-c97914439553', userMessageId: 'f1611a8b-cb84-4305-a365-328bd06bedac',
      status: 'running', conversationTurn: 1, modelStepCount: 2, toolCallCount: 3, request: { message: 'Compare models' } };
    harness.getRun.mockResolvedValue(stored);
    const path = `/v1/agent/${stored.conversationId}/runs/${stored.runId}`;
    const legacy = await app.request(`${path}?responseFormat=legacy`, {}, harness.env, executionContext);
    expect(await legacy.json()).toEqual(withSessionId(stored));
    const compact = await app.request(`${path}?responseFormat=compact&include=diagnostics`, {}, harness.env, executionContext);
    expect(compact.status).toBe(200);
    expect(await compact.json()).toMatchObject({ status: 'running', request: { message: 'Compare models' }, diagnostics: { toolCallCount: 3 } });
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
    expect(page.sessions[0]).toHaveProperty('sessionId', conversationId);
    expect(page.sessions[0]).not.toHaveProperty('conversationId');
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
    const agentMessageId = '03fab2db-c1ea-44c6-a79a-243e66d788d9';
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
          messageId: agentMessageId,
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
    expect(restored).toHaveProperty('sessionId', conversationId);
    expect(restored).not.toHaveProperty('conversationId');
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

  test('returns recovery IDs after catalog failure when no retry key was supplied', async () => {
    const harness = agentHarness();
    harness.recordSession.mockRejectedValueOnce(new Error('catalog unavailable'));
    const response = await postAgent(harness.env, { message: 'Research session catalogs' });
    expect(response.status).toBe(503);
    const result = await response.json<{ error: { message: string; details: { sessionId: string; runId: string } } }>();
    const admitted = await harness.startRun.mock.results[0]!.value;
    expect(result.error.details).toEqual({ sessionId: admitted.conversationId, runId: admitted.runId });
    expect(result.error.message).toContain('Retrieve the existing run');
    expect(result.error.message).not.toContain('Idempotency-Key');
    harness.getRun.mockResolvedValue(admitted);
    const poll = await app.request(`/v1/agent/${result.error.details.sessionId}/runs/${result.error.details.runId}`, {}, harness.env, executionContext);
    expect(poll.status).toBe(200);
    expect(harness.startRun).toHaveBeenCalledOnce();
  });

  test('routes follow-up admissions for one conversation to the same Durable Object', async () => {
    const harness = agentHarness();
    const conversationId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';

    await postAgent(harness.env, { message: 'First message', conversationId });
    await postAgent(harness.env, { message: 'Follow-up message', conversationId });

    expect(harness.instanceNames).toHaveLength(2);
    expect(harness.instanceNames[0]).toBe(harness.instanceNames[1]);
    expect(harness.startRun.mock.calls[0]?.[0]).toMatchObject({ conversationId });
    expect(harness.startRun.mock.calls[1]?.[0]).toMatchObject({ conversationId });
  });

  test('forwards an explicit parent message for a branched follow-up', async () => {
    const harness = agentHarness();
    const conversationId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
    const parentMessageId = '8a8671bd-5387-43dc-9031-65a69af2a40e';

    const response = await postAgent(harness.env, {
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

    const response = await postAgent(harness.env, {
      message: 'Continue the active conversation',
      conversationId: 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AGENT_CONVERSATION_BUSY' },
    });
  });

  test('streams the saved terminal snapshot, isolates ownership, and never starts work', async () => {
    const harness = agentHarness();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const snapshot = { run: { sessionId, runId, agentMessageId: crypto.randomUUID(), status: 'failed', error: 'Classification failed' }, phase: 'failed', tools: [] };
    harness.getRunProgress.mockResolvedValue(snapshot);
    const path = `/v1/agent/${sessionId}/runs/${runId}/events`;
    const response = await app.request(path, {}, harness.env, executionContext);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(await response.text()).toBe(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    expect(harness.startRun).not.toHaveBeenCalled();
    expect(creditBalance).not.toHaveBeenCalled();
    expect(harness.instanceNames[0]).toBe(await (await import('../src/agents/runtime/identity')).agentInstanceName('agent-user', sessionId));
    harness.getRunProgress.mockResolvedValue(null);
    expect((await app.request(path, {}, harness.env, executionContext)).status).toBe(404);
  });

  test('disconnecting the observer stops reads without cancelling or restarting execution', async () => {
    const harness = agentHarness();
    const sessionId = crypto.randomUUID(), runId = crypto.randomUUID();
    harness.getRunProgress.mockResolvedValue({ run: { sessionId, runId, status: 'running' }, phase: 'research', tools: [] });
    const response = await app.request(`/v1/agent/${sessionId}/runs/${runId}/events`, {}, harness.env, executionContext);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot');
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(harness.getRunProgress).toHaveBeenCalledTimes(1);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  test('stream errors expose a recoverable event without raw upstream errors', async () => {
    const harness = agentHarness();
    const sessionId = crypto.randomUUID(), runId = crypto.randomUUID();
    harness.getRunProgress.mockResolvedValueOnce({ run: { sessionId, runId, status: 'running' }, phase: 'research', tools: [] })
      .mockRejectedValue(new Error('secret upstream diagnostic'));
    const response = await app.request(`/v1/agent/${sessionId}/runs/${runId}/events`, {}, harness.env, executionContext);
    const events = await response.text();
    expect(events).toContain('event: snapshot');
    expect(events).toContain('event: unavailable');
    expect(events).not.toContain('secret upstream');
  });

  test('creates separate sessions for identical submissions without an idempotency key', async () => {
    const harness = agentHarness();
    const input = { message: 'Research this' };
    const first = await postAgent(harness.env, input);
    const second = await postAgent(harness.env, input);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstReceipt = await first.json<{ sessionId: string; runId: string }>();
    const secondReceipt = await second.json<{ sessionId: string; runId: string }>();
    expect(firstReceipt.sessionId).not.toBe(secondReceipt.sessionId);
    expect(firstReceipt.runId).not.toBe(secondReceipt.runId);
    expect(harness.instanceNames[0]).not.toBe(harness.instanceNames[1]);
    expect(harness.recordSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: firstReceipt.sessionId, runId: firstReceipt.runId, message: input.message,
    }));
  });

  test('ignores the removed key header instead of deduplicating submissions', async () => {
    const harness = agentHarness();
    const submit = () => app.request('/v1/agent?responseFormat=legacy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'x' },
      body: JSON.stringify({ message: 'Research this' }),
    }, harness.env, executionContext);
    const first = await submit();
    const second = await submit();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = await first.json<{ sessionId: string; runId: string }>();
    const b = await second.json<{ sessionId: string; runId: string }>();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.runId).not.toBe(b.runId);
    for (const call of harness.startRun.mock.calls) expect(call[1]).not.toHaveProperty('idempotencyKey');
  });

  test('continues a session without a key and preserves active-run conflicts', async () => {
    const harness = agentHarness();
    const sessionId = crypto.randomUUID();
    const first = await postAgent(harness.env, { message: 'Compare the videos', sessionId });
    const second = await postAgent(harness.env, { message: 'Compare the videos', sessionId });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstReceipt = await first.json<{ sessionId: string; runId: string }>();
    const secondReceipt = await second.json<{ sessionId: string; runId: string }>();
    expect(firstReceipt.sessionId).toBe(sessionId);
    expect(secondReceipt.sessionId).toBe(sessionId);
    expect(firstReceipt.runId).not.toBe(secondReceipt.runId);
    expect(harness.instanceNames[0]).toBe(harness.instanceNames[1]);
    expect(harness.enqueueAgentRun).not.toHaveBeenCalled();
    const admissions = harness.startRun.mock.calls;
    expect(admissions[0]?.[1]).not.toHaveProperty('idempotencyKey');
    expect(admissions[1]?.[1]).not.toHaveProperty('idempotencyKey');

    harness.pendingAgentRun.mockResolvedValue({ run: { status: 'pending' } });
    const busy = await postAgent(harness.env, { message: 'More detail', sessionId });
    expect(busy.status).toBe(409);
    expect(harness.startRun).toHaveBeenCalledTimes(2);
  });

  test('validates the request body even without an idempotency key', async () => {
    const harness = agentHarness();
    const invalidBody = await postAgent(harness.env, { message: '' });
    expect(invalidBody.status).toBe(422);
    await expect(invalidBody.json()).resolves.toMatchObject({ error: { code: 'INVALID_AGENT_REQUEST' } });
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  test('honors the feature flag and available-credit admission checks', async () => {
    const disabled = agentHarness('false');
    const disabledResponse = await postAgent(disabled.env, { message: 'Research this' });
    expect(disabledResponse.status).toBe(503);
    await expect(disabledResponse.json()).resolves.toMatchObject({ error: { code: 'AGENT_DISABLED' } });
    expect(disabled.getByName).not.toHaveBeenCalled();

    const enabled = agentHarness();
    creditBalance.mockResolvedValueOnce(0);
    const noCredits = await postAgent(enabled.env, { message: 'Research this' });
    expect(noCredits.status).toBe(402);
    await expect(noCredits.json()).resolves.toMatchObject({ error: { code: 'INSUFFICIENT_CREDITS' } });
    expect(noCredits.headers.get('X-Credits-Charged')).toBe('0');
    expect(enabled.getByName).not.toHaveBeenCalled();
  });

  test('returns and polls a durable receipt without waiting on runtime startup', async () => {
    const harness = agentHarness();
    const receipt = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), conversationTurn: 1, modelStepCount: 0, toolCallCount: 0, status: 'pending' };
    harness.enqueueAgentRun.mockResolvedValue({ receipt });
    harness.startRun.mockImplementation(() => new Promise(() => {}));
    const response = await postAgent(harness.env, { message: 'Research' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(withSessionId(receipt));
    expect(harness.startRun).not.toHaveBeenCalled();
    expect(harness.registerConversation).not.toHaveBeenCalled();
    expect(harness.accessUser).toHaveBeenCalledTimes(1);
    expect(harness.enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Research' }),
      expect.objectContaining({ userId: 'agent-user', creditsRemaining: 500 }),
    );
    expect(harness.enqueueAgentRun.mock.calls[0]?.[1]).not.toHaveProperty('idempotencyKey');
    harness.pendingAgentRun.mockResolvedValue({ run: receipt, message: 'Research', admittedAt: 123 });
    const poll = await app.request(`/v1/agent/${receipt.conversationId}/runs/${receipt.runId}?responseFormat=legacy`, {}, harness.env, executionContext);
    expect(await poll.json()).toEqual(withSessionId(receipt));
    expect(harness.getRun).not.toHaveBeenCalled();
    const followup = await postAgent(harness.env, { conversationId: receipt.conversationId, message: 'More detail' });
    expect(followup.status).toBe(409);
  });

  test('retrieves a run from its conversation Durable Object', async () => {
    const conversationId = 'f1611a8b-cb84-4305-a365-328bd06bedac';
    const runId = 'cd056140-7d4c-4516-bb9e-c97914439553';
    const harness = agentHarness();
    harness.getRun.mockResolvedValueOnce({
      runId,
      conversationId,
      agentMessageId: 'ee25e9fd-edad-468d-8941-16cfdb0ba4f2',
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
      sessionId: conversationId,
      agentMessageId: 'ee25e9fd-edad-468d-8941-16cfdb0ba4f2',
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

function postAgent(env: Env, input: Record<string, unknown>) {
  return app.request('/v1/agent?responseFormat=legacy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  }, env, executionContext);
}

function agentHarness(enabled = 'true') {
  const accessUser = vi.fn(async (): Promise<{ email: string; emailVerified: number; agentAllowed?: number } | null> => ({ email: 'agent@example.com', emailVerified: 1, agentAllowed: 1 }));
  const instanceNames: string[] = [];
  let conversationTurn = 0;
  const startRun = vi.fn(async (request: { conversationId: string; message: string }, _admission: AgentAdmission) => {
    conversationTurn += 1;
    return {
      request: { message: request.message },
      runId: crypto.randomUUID(),
      conversationId: request.conversationId,
      userMessageId: crypto.randomUUID(),
      agentMessageId: crypto.randomUUID(),
      conversationTurn,
      modelStepCount: 0,
      toolCallCount: 0,
      status: 'pending' as const,
    };
  });
  const getRun = vi.fn(async () => null as unknown);
  const getRunProgress = vi.fn(async () => null as unknown);
  const getConversation = vi.fn(async (): Promise<AgentConversationPage | null> => null);
  const registerConversation = vi.fn(async () => undefined);
  const recordSession = vi.fn(async () => undefined);
  const listSessions = vi.fn(async (): Promise<UserSessionPage> => ({ sessions: [], nextCursor: null }));
  const getSession = vi.fn(async (): Promise<UserSessionSummary | null> => null);
  const getByName = vi.fn((name: string) => {
    instanceNames.push(name);
    return { startRun, getRun, getRunProgress, getConversation };
  });
  const accountInstanceNames: string[] = [];
  const enqueueAgentRun = vi.fn().mockResolvedValue({ legacy: true });
  const pendingAgentRun = vi.fn().mockResolvedValue(null);
  const accountGetByName = vi.fn((name: string) => {
    accountInstanceNames.push(name);
    return { registerConversation, recordSession, listSessions, getSession, enqueueAgentRun, pendingAgentRun };
  });
  return {
    env: {
      AGENT_RUNTIME_ENABLED: enabled,
      AGENT_ACCESS_MODE: 'allowlist',
      DB: { prepare: () => ({ bind: () => ({ first: accessUser }) }) },
      AGENT_RUNTIME: { getByName },
      USER_ACCOUNT: { getByName: accountGetByName },
    } as unknown as Env,
    getByName,
    instanceNames,
    accessUser,
    startRun,
    getRun, getRunProgress,
    getConversation,
    accountGetByName,
    enqueueAgentRun, pendingAgentRun,
    accountInstanceNames,
    registerConversation,
    recordSession,
    listSessions,
    getSession,
  };
}
