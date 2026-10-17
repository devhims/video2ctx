import 'server-only';
import { agentSessionDetailSchema, type AgentSessionSeed } from './agent-sessions';

// Start the first page of a conversation while the page checks access, so the thread renders
// with it instead of requesting it after hydration. Any failure resolves to null and the
// client falls back to its own request, which reports errors as usual.
export function startAgentSessionSeed(requestHeaders: Headers, sessionId: string): AgentSessionSeed {
  const base = process.env.PLATFORM_API_BASE_URL ?? (process.env.NODE_ENV === 'production' ? 'https://api.video2ctx.dev' : 'http://localhost:8787');
  return fetch(new URL(`/v1/agent/sessions/${sessionId}?limit=10`, base), {
    cache: 'no-store',
    headers: { accept: 'application/json', cookie: requestHeaders.get('cookie') ?? '' },
  }).then(async response => response.ok ? agentSessionDetailSchema.parse(await response.json()) : null)
    .catch(() => null);
}
