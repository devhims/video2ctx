import { z } from 'zod';

const statusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
const summarySchema = z.object({
  sessionId: z.string().uuid(), title: z.string(), latestMessagePreview: z.string(),
  lastRunId: z.string().uuid(), runCount: z.number(), createdAt: z.number(), updatedAt: z.number(),
});
export const agentSessionListSchema = z.object({ sessions: z.array(summarySchema), nextCursor: z.string().nullable() });
const messageSchema = z.object({
  messageId: z.string().uuid(), runId: z.string().uuid(), parentMessageId: z.string().uuid().nullable(),
  conversationTurn: z.number(), role: z.enum(['user', 'assistant']), status: statusSchema,
  content: z.string(), createdAt: z.number(), updatedAt: z.number(),
});
export const agentSessionDetailSchema = summarySchema.extend({ messages: z.array(messageSchema), nextCursor: z.string().nullable() });
export const agentRunSchema = z.object({
  sessionId: z.string().uuid(), runId: z.string().uuid(), status: statusSchema,
  request: z.object({ message: z.string() }).optional(), error: z.string().optional(),
  result: z.object({
    outcome: z.string(), answer: z.string(),
    sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string().optional() })),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    coverage: z.object({ reviewedVideos: z.number(), targetVideos: z.number() }).optional(),
  }).optional(),
  billing: z.object({ creditsCharged: z.number(), creditsRemaining: z.number() }).optional(),
});
export type AgentSessionList = z.infer<typeof agentSessionListSchema>;
export type AgentSessionDetail = z.infer<typeof agentSessionDetailSchema>;
export type AgentMessage = z.infer<typeof messageSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentProgressSchema = z.object({
  run: agentRunSchema,
  phase: z.enum(['queued', 'classification', 'research', 'finalization', 'completed', 'failed', 'cancelled']),
  tools: z.array(z.object({
    toolCallId: z.string(), name: z.string(), operation: z.string(),
    status: z.enum(['running', 'completed', 'failed']), startedAt: z.number(), finishedAt: z.number().optional(),
    input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])),
    output: z.object({ sourceCount: z.number(), excerptCount: z.number(),
      sources: z.array(z.object({ title: z.string().optional(), videoId: z.string().optional(), channelId: z.string().optional() })),
      warningCodes: z.array(z.string()),
    }).optional(),
  })),
});
export type AgentProgress = z.infer<typeof agentProgressSchema>;
const admissionSchema = agentRunSchema.extend({ assistantMessageId: z.string().uuid(),
  diagnostics: z.object({ userMessageId: z.string().uuid(), conversationTurn: z.number() }),
});
export type AgentAdmission = z.infer<typeof admissionSchema>;

export class AgentSendError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

export async function sendAgentMessage(message: string, idempotencyKey: string, sessionId?: string): Promise<AgentAdmission> {
  try {
    const response = await fetch('/api/platform/v1/agent?include=diagnostics', {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'Please sign in again before sending a message.', 403: 'Your account does not currently have agent access.',
        402: 'You do not have enough credits to start a run.',
        409: 'A run is already active in this session. Refresh the session and wait for it to finish.',
        422: 'This message could not be accepted. Check the request and try again.',
        429: 'Too many requests. Wait a moment, then retry.',
      };
      throw new AgentSendError(messages[response.status] ?? 'Sending could not be confirmed. Retry to check the same request.', response.status >= 500 || response.status === 429);
    }
    return admissionSchema.parse(await response.json());
  } catch (cause) {
    if (cause instanceof AgentSendError) throw cause;
    throw new AgentSendError('Sending could not be confirmed. Retry to check the same request without starting it twice.', true);
  }
}

// SSE blocks can span network chunks (including multibyte characters). Accept
// both LF and CRLF; schemas keep invalid stream content out of the view.
export async function consumeAgentStream(response: Response, receive: (value: AgentProgress) => void): Promise<boolean> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error(response.status === 401 || response.status === 403 ? 'Your account no longer has access to this session.' : 'Could not connect to live updates.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 512_000) throw new Error('The live update was too large. Reconnect to resume.');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = block.split(/\r?\n/);
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (event === 'unavailable') throw new Error('Live updates were interrupted. Reconnect to resume the saved run.');
        if (event !== 'snapshot') continue;
        const snapshot = agentProgressSchema.parse(JSON.parse(data));
        receive(snapshot);
        if (!isActiveAgentRun(snapshot.run.status)) return true;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function watchAgentRun(sessionId: string, runId: string, signal: AbortSignal,
  receive: (value: AgentProgress) => void): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(`/api/platform/v1/agent/${sessionId}/runs/${runId}/events`, {
        credentials: 'include', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      });
      if ([401, 403, 404].includes(response.status)) throw new AgentSendError('This run is no longer accessible to your account.', false);
      let received = false;
      if (await consumeAgentStream(response, snapshot => {
        if (snapshot.run.sessionId !== sessionId || snapshot.run.runId !== runId) throw new Error('Live update does not match this run.');
        received = true; receive(snapshot);
      })) return;
      if (!received) throw new Error('Live updates ended without a run snapshot.');
      failures = 0;
    } catch (cause) {
      if (signal.aborted) return;
      if ((cause instanceof AgentSendError && !cause.retryable) || ++failures >= 3) throw cause;
    }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, failures ? failures * 1_000 : 500);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}

export async function fetchAgentData<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/platform/v1/agent${path}`, { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Your account does not currently have access to agent sessions.');
    if (response.status === 404) throw new Error('This session or run was not found in your account.');
    throw new Error('Could not load agent sessions. Please try again.');
  }
  return schema.parse(await response.json());
}

export function mergeAgentMessages(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const messages = new Map(current.map(message => [message.messageId, message]));
  for (const message of incoming) messages.set(message.messageId, message);
  return [...messages.values()].sort((a, b) => a.conversationTurn - b.conversationTurn || (a.role === 'user' ? -1 : 1));
}

export function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return; }
}

export function isActiveAgentRun(status: string) { return status === 'pending' || status === 'running'; }
