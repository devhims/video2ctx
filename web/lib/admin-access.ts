import { platformRequest } from './platform-request.ts';
export type AgentAccessEntry = { email: string; createdAt: number };
export type AgentAccessPage = { entries: AgentAccessEntry[]; total: number; limit: number; offset: number };

export async function adminAccessRequest<T>(query = '', init: RequestInit = {}): Promise<T> {
  return platformRequest(`/v1/admin/agent-access${query}`, { ...init, cache: 'no-store' });
}
