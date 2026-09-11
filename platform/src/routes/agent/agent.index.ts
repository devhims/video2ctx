import { timeAgentAdmission } from '../../lib/agent-admission-timing';
import { agentInstanceName, userAccountInstanceName, deterministicConversationId } from '../../agents/runtime/identity';
export { agentInstanceName, userAccountInstanceName, deterministicConversationId } from '../../agents/runtime/identity';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { agentResponseOptionsSchema, compactAgentRun, legacyAgentRun, withSessionId } from '../../agents/response';
import { z } from 'zod';
import {
  agentRunReceiptSchema,
  agentRequestSchema,
  type AgentRequest,
} from '../../agents/contracts';
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from '../../agents/runtime/conversation-restoration';
import {
  decodeSessionCursor,
  encodeSessionCursor,
} from '../../durable-objects/user-account';
import { ApiError, body } from '../../lib/http';
import { creditBalance } from '../../lib/entitlements';
import { requireDataPrincipal, requireUser } from '../../middlewares/authentication';
import type { App } from '../../types';

export const agentRoutes = new Hono<App>();

export const AGENT_ROUTE_PATTERNS = ['/agent/*'] as const;
for (const path of AGENT_ROUTE_PATTERNS) {
  agentRoutes.use(path, requireDataPrincipal, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await requireAgentAccess(c);
    await next();
  });
}

const runPathSchema = z.object({
  sessionId: z.string().uuid(),
  runId: z.string().uuid(),
});

const sessionListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(500).optional(),
});

const sessionDetailPathSchema = z.object({
  sessionId: z.string().uuid(),
});

const sessionDetailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(500).optional(),
});

// Uses the same authentication and verified-email gate as every agent route.
agentRoutes.get('/agent/access', (c) => c.json({ enabled: true }));

agentRoutes.get('/agent/sessions', async (c) => {
  const principal = requireUser(c);
  const query = sessionListQuerySchema.safeParse({
    q: c.req.query('q'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!query.success) {
    throw new ApiError(
      422,
      'INVALID_AGENT_SESSION_QUERY',
      'The session search query is invalid.',
      query.error.flatten(),
    );
  }

  let cursor;
  try {
    cursor = query.data.cursor ? decodeSessionCursor(query.data.cursor) : undefined;
  } catch {
    throw new ApiError(422, 'INVALID_AGENT_SESSION_CURSOR', 'The session cursor is invalid.');
  }

  c.header('Cache-Control', 'no-store');
  const account = await userAccountForUser(c.env, principal.id);
  try {
    const page = await account.listSessions({
      query: query.data.q,
      limit: query.data.limit,
      cursor,
    });
    return c.json({
      sessions: page.sessions.map(withSessionId),
      nextCursor: page.nextCursor ? encodeSessionCursor(page.nextCursor) : null,
    });
  } catch {
    throw new ApiError(503, 'AGENT_SESSION_CATALOG_UNAVAILABLE', 'The agent session catalog is temporarily unavailable.');
  }
});

agentRoutes.get('/agent/sessions/:sessionId', async (c) => {
  const principal = requireUser(c);
  const path = sessionDetailPathSchema.safeParse({
    sessionId: c.req.param('sessionId'),
  });
  const query = sessionDetailQuerySchema.safeParse({
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!path.success || !query.success) {
    throw new ApiError(
      422,
      'INVALID_AGENT_SESSION_REQUEST',
      'The session identifier or restoration query is invalid.',
      {
        path: path.success ? undefined : path.error.flatten(),
        query: query.success ? undefined : query.error.flatten(),
      },
    );
  }

  let cursor;
  try {
    cursor = query.data.cursor ? decodeConversationCursor(query.data.cursor) : undefined;
  } catch {
    throw new ApiError(422, 'INVALID_AGENT_CONVERSATION_CURSOR', 'The conversation cursor is invalid.');
  }

  c.header('Cache-Control', 'no-store');
  const account = await userAccountForUser(c.env, principal.id);
  let session;
  try {
    session = await account.getSession(path.data.sessionId);
  } catch {
    throw new ApiError(503, 'AGENT_SESSION_CATALOG_UNAVAILABLE', 'The agent session catalog is temporarily unavailable.');
  }
  if (!session) throw new ApiError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found.');

  const agent = await agentForConversation(c.env, principal.id, path.data.sessionId);
  let page;
  try {
    const pending = await account.pendingAgentRun(path.data.sessionId);
    if (pending) {
      const common = { runId: pending.run.runId, conversationTurn: 1, createdAt: pending.admittedAt, updatedAt: pending.admittedAt };
      return c.json({ ...withSessionId(session), messages: cursor ? [] : [
        { ...common, messageId: pending.run.userMessageId, parentMessageId: null, role: 'user', status: 'completed', content: pending.message },
        { ...common, messageId: pending.run.assistantMessageId, parentMessageId: pending.run.userMessageId, role: 'assistant', status: pending.run.status, content: '' },
      ], nextCursor: null });
    }
    page = await agent.getConversation(path.data.sessionId, principal.id, {
      limit: query.data.limit,
      cursor,
    });
  } catch {
    throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.');
  }
  if (!page) throw new ApiError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found.');

  return c.json({
    ...withSessionId(session),
    messages: page.messages,
    nextCursor: page.nextCursor ? encodeConversationCursor(page.nextCursor) : null,
  });
});

agentRoutes.post('/agent', async (c) => {
  const principal = requireUser(c);
  const startedAt = c.get('requestStartedAt');
  if (startedAt !== undefined) c.get('agentAdmissionTimings')?.push({ stage: 'preflight', durationMs: Date.now() - startedAt });
  const responseOptions = parseResponseOptions(c);
  const idempotencyKey = requireIdempotencyKey(c.req.header('idempotency-key'));
  const parsedRequest = parseAgentRequest(await body<unknown>(c.req.raw));
  const conversationId = parsedRequest.conversationId
    ?? await deterministicConversationId(principal.id, idempotencyKey);
  const request: AgentRequest = { ...parsedRequest, conversationId };
  const creditsRemaining = await timeAgentAdmission(c, 'credits', () => creditBalance(c.env, principal.id));

  c.header('Cache-Control', 'no-store');
  c.header('X-Credits-Charged', '0');
  c.header('X-Credits-Remaining', String(creditsRemaining));
  if (creditsRemaining <= 0) {
    throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits to start an agent run.');
  }

  const agent = await agentForConversation(c.env, principal.id, conversationId);
  try {
    const account = await userAccountForUser(c.env, principal.id);
    if (!parsedRequest.conversationId && !parsedRequest.parentMessageId) {
      const queued = await timeAgentAdmission(c, 'enqueue', async () => await account.enqueueAgentRun(request, { userId: principal.id, idempotencyKey, creditsRemaining }));
      if (queued.receipt) return c.json(responseOptions.responseFormat === 'compact'
        ? compactAgentRun(queued.receipt, responseOptions.include) : withSessionId(agentRunReceiptSchema.parse(queued.receipt)), 202);
    }
    if (await account.pendingAgentRun(conversationId)) {
      throw new ApiError(409, 'AGENT_CONVERSATION_BUSY', 'The conversation is still starting. Poll the admitted run before sending a follow-up.');
    }
    await timeAgentAdmission(c, 'register', () => account.registerConversation(conversationId));
    const receipt = await timeAgentAdmission(c, 'start_run', async () => await agent.startRun(request, {
      userId: principal.id,
      idempotencyKey,
      creditsRemaining,
    }));
    if ('rejected' in receipt) {
      throw new ApiError(receipt.status, receipt.code, receipt.message);
    }
    try {
      await timeAgentAdmission(c, 'session', () => account.recordSession({
        conversationId: receipt.conversationId,
        runId: receipt.runId,
        message: request.message,
        updatedAt: Date.now(),
      }));
    } catch {
      throw new ApiError(
        503,
        'AGENT_SESSION_CATALOG_UNAVAILABLE',
        'The run was admitted, but its session catalog entry could not be recorded. Retry with the same Idempotency-Key.',
      );
    }
    return c.json(responseOptions.responseFormat === 'compact'
      ? compactAgentRun(receipt, responseOptions.include) : withSessionId(agentRunReceiptSchema.parse(receipt)), 202);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.');
  }
});

agentRoutes.get('/agent/:sessionId/runs/:runId', async (c) => {
  const principal = requireUser(c);
  const responseOptions = parseResponseOptions(c);
  const path = runPathSchema.safeParse({
    sessionId: c.req.param('sessionId'),
    runId: c.req.param('runId'),
  });
  if (!path.success) {
    throw new ApiError(422, 'INVALID_AGENT_RUN_PATH', 'The session and run identifiers must be UUIDs.');
  }

  c.header('Cache-Control', 'no-store');
  const agent = await agentForConversation(c.env, principal.id, path.data.sessionId);
  let run;
  try {
    const account = await userAccountForUser(c.env, principal.id);
    const pending = await account.pendingAgentRun(path.data.sessionId, path.data.runId);
    run = pending?.run ?? await agent.getRun(path.data.runId);
  } catch {
    throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.');
  }
  if (!run) throw new ApiError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found.');
  return c.json(responseOptions.responseFormat === 'compact' ? compactAgentRun(run, responseOptions.include) : legacyAgentRun(run));
});

// Each connection starts with a complete persisted snapshot. Reconnecting needs
// no in-memory cursor and never starts another run or replays billable tools.
agentRoutes.get('/agent/:sessionId/runs/:runId/events', async (c) => {
  const principal = requireUser(c);
  const path = runPathSchema.safeParse(c.req.param());
  if (!path.success) throw new ApiError(422, 'INVALID_AGENT_RUN_PATH', 'The session and run identifiers must be UUIDs.');
  const account = await userAccountForUser(c.env, principal.id);
  const agent = await agentForConversation(c.env, principal.id, path.data.sessionId);
  const read = async () => {
    const pending = await account.pendingAgentRun(path.data.sessionId, path.data.runId);
    return pending ? { run: compactAgentRun(pending.run, []), phase: 'queued', tools: [] }
      : await agent.getRunProgress(path.data.runId);
  };
  let initial;
  try { initial = await read(); }
  catch { throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.'); }
  if (!initial) throw new ApiError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found.');
  c.header('Cache-Control', 'no-store, no-transform');
  c.header('X-Accel-Buffering', 'no');
  const response = streamSSE(c, async stream => {
    try {
      let snapshot: Awaited<ReturnType<typeof read>> = initial;
      let previous = '';
      // Rotate the read connection so authorization is checked again on reconnect.
      // This is an observation interval, independent of durable execution deadlines.
      const until = Date.now() + 25_000;
      let heartbeatAt = Date.now();
      while (!stream.aborted) {
        if (!snapshot) {
          await stream.writeSSE({ event: 'unavailable', data: JSON.stringify({ message: 'This run is no longer available.' }) });
          return;
        }
        const data = JSON.stringify(snapshot);
        if (data !== previous) { await stream.writeSSE({ event: 'snapshot', data }); previous = data; }
        if (!['pending', 'running'].includes(snapshot.run.status)) return;
        if (Date.now() >= until) return;
        if (Date.now() - heartbeatAt >= 10_000) { await stream.writeSSE({ event: 'heartbeat', data: '{}' }); heartbeatAt = Date.now(); }
        await stream.sleep(1_000);
        if (stream.aborted) return;
        snapshot = await read();
      }
    } catch {
      if (!stream.aborted) await stream.writeSSE({ event: 'unavailable', data: JSON.stringify({ message: 'Live updates are temporarily unavailable. Reconnect to resume.' }) });
    }
  });
  c.header('Cache-Control', 'no-store, no-transform');
  return response;
});

async function requireAgentAccess(c: Context<App>): Promise<void> {
  if (String(c.env.AGENT_RUNTIME_ENABLED) !== 'true') {
    throw new ApiError(503, 'AGENT_DISABLED', 'The agent endpoint is not enabled.');
  }
  const accessMode = String(c.env.AGENT_ACCESS_MODE ?? 'admins');
  if (accessMode === 'all') return; // Authentication and credential scopes still apply.
  if (accessMode !== 'admins') {
    throw new ApiError(503, 'AGENT_DISABLED', 'The agent access configuration is invalid.');
  }
  const allowed = new Set(String(c.env.ADMIN_EMAILS_SECRET ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) throw new ApiError(403, 'ADMIN_REQUIRED', 'Agent access is currently restricted to admins.');
  // Read Better Auth's current user record, not cached session fields or request-supplied email.
  // This also covers API keys: requireUser resolves their authenticated account owner.
  let user;
  try {
    user = await timeAgentAdmission(c, 'admin_check', () => c.env.DB.prepare('SELECT email, emailVerified FROM user WHERE id = ?')
      .bind(requireUser(c).id).first<{ email: string; emailVerified: number }>());
  } catch {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Admin access could not be verified.');
  }
  if (!user || user.emailVerified !== 1 || !allowed.has(user.email.trim().toLowerCase())) {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'Agent access is currently restricted to admins.');
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (key.length < 8 || key.length > 200) {
    throw new ApiError(
      422,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain between 8 and 200 characters.',
    );
  }
  return key;
}

const publicAgentRequestSchema = agentRequestSchema.extend({
  sessionId: z.string().uuid().optional(),
}).superRefine((input, ctx) => {
  if (input.sessionId && input.conversationId && input.sessionId !== input.conversationId) {
    ctx.addIssue({ code: 'custom', path: ['sessionId'], message: 'sessionId and the deprecated conversationId must match when both are supplied.' });
  }
});

function parseAgentRequest(value: unknown): AgentRequest {
  const parsed = publicAgentRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      'INVALID_AGENT_REQUEST',
      'The agent request is invalid.',
      parsed.error.flatten(),
    );
  }
  const { sessionId, ...request } = parsed.data;
  return { ...request, conversationId: sessionId ?? request.conversationId };
}

async function agentForConversation(env: Env, userId: string, conversationId: string) {
  const instanceName = await agentInstanceName(userId, conversationId);
  return env.AGENT_RUNTIME.getByName(instanceName);
}

async function userAccountForUser(env: Env, userId: string) {
  const instanceName = await userAccountInstanceName(userId);
  return env.USER_ACCOUNT.getByName(instanceName);
}

function parseResponseOptions(c: Context<App>) {
  const parsed = agentResponseOptionsSchema.safeParse({ responseFormat: c.req.query('responseFormat'), include: c.req.query('include') });
  if (!parsed.success) throw new ApiError(422, 'INVALID_AGENT_RESPONSE_OPTIONS', 'The agent response options are invalid.', parsed.error.flatten());
  return parsed.data;
}
