import { platformRequest } from './platform-request';
export type AdminUser = { id: string; name: string; email: string; plan: 'starter' | 'builder'; isAdmin: boolean;
  status: 'active' | 'deleted'; signedUpAt: number; deletedAt: number | null;
  polarCustomerId: string | null; creditBalance: number;
  deletionSource: 'self' | 'admin' | 'database' | null; deletedByUserId: string | null;
};
export type AdminUserResults = { users: AdminUser[]; nextOffset: number | null };
export function searchAdminUsers(query: string, offset = 0, signal?: AbortSignal) {
  return platformRequest<AdminUserResults>(`/v1/admin/users?${new URLSearchParams({ q: query, offset: String(offset) })}`, { cache: 'no-store', signal });
}
export function deleteAdminUser(user: AdminUser) {
  return platformRequest<void>(`/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', cache: 'no-store', body: JSON.stringify({ email: user.email }) });
}
