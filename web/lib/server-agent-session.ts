import 'server-only';
import type { z } from 'zod';
import { agentSessionDetailSchema, agentSessionListSchema, type AgentSessionListSeed, type AgentSessionSeed } from './agent-sessions';

// Start Agent reads while the page checks access, so the page renders with them instead of the
// browser requesting them after hydration. Any failure resolves to null and the client falls
// back to its own request, which reports errors as usual.
function readAgent<T>(requestHeaders: Headers, path: string, schema: z.ZodType<T>): Promise<T | null> {
  const base = process.env.PLATFORM_API_BASE_URL ?? (process.env.NODE_ENV === 'production' ? 'https://api.video2ctx.dev' : 'http://localhost:8787');
  return fetch(new URL(`/v1/agent${path}`, base), {
    cache: 'no-store',
    headers: { accept: 'application/json', cookie: requestHeaders.get('cookie') ?? '' },
  }).then(async response => response.ok ? schema.parse(await response.json()) : null)
    .catch(() => null);
}

export function startAgentSessionSeed(requestHeaders: Headers, sessionId: string): AgentSessionSeed {
  return readAgent(requestHeaders, `/sessions/${sessionId}?limit=10`, agentSessionDetailSchema);
}

/** The first page of recent sessions, matching the browser cache's default list. */
export async function startAgentSessionListSeed(requestHeaders: Headers): Promise<AgentSessionListSeed | null> {
  const list = await readAgent(requestHeaders, `/sessions?${new URLSearchParams({ q: '', limit: '20' })}`, agentSessionListSchema);
  return list && { list, readId: crypto.randomUUID() };
}
