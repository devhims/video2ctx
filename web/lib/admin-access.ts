export type AgentAccessEntry = { email: string; createdAt: number };
export type AgentAccessPage = { entries: AgentAccessEntry[]; total: number; limit: number; offset: number };

export async function adminAccessRequest<T>(query = '', init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/platform/v1/admin/agent-access${query}`, {
    ...init, credentials: 'include', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? 'Could not update Agent access. Please try again.');
  return result as T;
}
