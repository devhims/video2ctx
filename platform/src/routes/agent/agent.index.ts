import { agentInstanceName, userAccountInstanceName, deterministicConversationId } from '../../agents/runtime/identity';
export { agentInstanceName, userAccountInstanceName, deterministicConversationId } from '../../agents/runtime/identity';
import { Hono, type Context } from 'hono';
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

export const AGENT_ROUTE_PATTERNS = ['/agent', '/agent/*'] as const;
for (const path of AGENT_ROUTE_PATTERNS) {
  agentRoutes.use(path, requireDataPrincipal, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await requireAgentAccess(c);
    await next();
  });
}

const runPathSchema = z.object({
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
});

const sessionListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(500).optional(),
});

const sessionDetailPathSchema = z.object({
  conversationId: z.string().uuid(),
});

const sessionDetailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(500).optional(),
});

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
      sessions: page.sessions,
      nextCursor: page.nextCursor ? encodeSessionCursor(page.nextCursor) : null,
    });
  } catch {
    throw new ApiError(503, 'AGENT_SESSION_CATALOG_UNAVAILABLE', 'The agent session catalog is temporarily unavailable.');
  }
});

agentRoutes.get('/agent/sessions/:conversationId', async (c) => {
  const principal = requireUser(c);
  const path = sessionDetailPathSchema.safeParse({
    conversationId: c.req.param('conversationId'),
  });
  const query = sessionDetailQuerySchema.safeParse({
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!path.success || !query.success) {
    throw new ApiError(
      422,
      'INVALID_AGENT_SESSION_REQUEST',
      'The conversation identifier or restoration query is invalid.',
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
    session = await account.getSession(path.data.conversationId);
  } catch {
    throw new ApiError(503, 'AGENT_SESSION_CATALOG_UNAVAILABLE', 'The agent session catalog is temporarily unavailable.');
  }
  if (!session) throw new ApiError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found.');

  const agent = await agentForConversation(c.env, principal.id, path.data.conversationId);
  let page;
  try {
    page = await agent.getConversation(path.data.conversationId, principal.id, {
      limit: query.data.limit,
      cursor,
    });
  } catch {
    throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.');
  }
  if (!page) throw new ApiError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent session not found.');

  return c.json({
    ...session,
    messages: page.messages,
    nextCursor: page.nextCursor ? encodeConversationCursor(page.nextCursor) : null,
  });
});

agentRoutes.post('/agent', async (c) => {
  const principal = requireUser(c);
  const idempotencyKey = requireIdempotencyKey(c.req.header('idempotency-key'));
  const parsedRequest = parseAgentRequest(await body<unknown>(c.req.raw));
  const conversationId = parsedRequest.conversationId
    ?? await deterministicConversationId(principal.id, idempotencyKey);
  const request: AgentRequest = { ...parsedRequest, conversationId };
  const creditsRemaining = await creditBalance(c.env, principal.id);

  c.header('Cache-Control', 'no-store');
  c.header('X-Credits-Charged', '0');
  c.header('X-Credits-Remaining', String(creditsRemaining));
  if (creditsRemaining <= 0) {
    throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits to start an agent run.');
  }

  const agent = await agentForConversation(c.env, principal.id, conversationId);
  try {
    const account = await userAccountForUser(c.env, principal.id);
    const receipt = await agent.startRun(request, {
      userId: principal.id,
      idempotencyKey,
      creditsRemaining,
    });
    if ('rejected' in receipt) {
      throw new ApiError(receipt.status, receipt.code, receipt.message);
    }
    try {
      await account.recordSession({
        conversationId: receipt.conversationId,
        runId: receipt.runId,
        message: request.message,
        updatedAt: Date.now(),
      });
    } catch {
      throw new ApiError(
        503,
        'AGENT_SESSION_CATALOG_UNAVAILABLE',
        'The run was admitted, but its session catalog entry could not be recorded. Retry with the same Idempotency-Key.',
      );
    }
    return c.json(agentRunReceiptSchema.parse(receipt), 202);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.');
  }
});

agentRoutes.get('/agent/:conversationId/runs/:runId', async (c) => {
  const principal = requireUser(c);
  const path = runPathSchema.safeParse({
    conversationId: c.req.param('conversationId'),
    runId: c.req.param('runId'),
  });
  if (!path.success) {
    throw new ApiError(422, 'INVALID_AGENT_RUN_PATH', 'The conversation and run identifiers must be UUIDs.');
  }

  c.header('Cache-Control', 'no-store');
  const agent = await agentForConversation(c.env, principal.id, path.data.conversationId);
  let run;
  try {
    run = await agent.getRun(path.data.runId);
  } catch {
    throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The agent runtime is temporarily unavailable.');
  }
  if (!run) throw new ApiError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found.');
  return c.json(run);
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
    user = await c.env.DB.prepare('SELECT email, emailVerified FROM user WHERE id = ?')
      .bind(requireUser(c).id).first<{ email: string; emailVerified: number }>();
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

function parseAgentRequest(value: unknown): AgentRequest {
  const parsed = agentRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      'INVALID_AGENT_REQUEST',
      'The agent request is invalid.',
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

async function agentForConversation(env: Env, userId: string, conversationId: string) {
  const instanceName = await agentInstanceName(userId, conversationId);
  return env.AGENT_RUNTIME.getByName(instanceName);
}

async function userAccountForUser(env: Env, userId: string) {
  const instanceName = await userAccountInstanceName(userId);
  return env.USER_ACCOUNT.getByName(instanceName);
}

