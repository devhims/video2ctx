import { ApiError } from './http';

/** Protect the same role and bootstrap-email identities that grant admin access. */
export function isAdminAccount(env: Pick<Env, 'ADMIN_EMAILS_SECRET'>, user: { email: string; role?: string | null }): boolean {
  if (user.role?.split(',').some(role => role.trim() === 'admin')) return true;
  const email = user.email.trim().toLowerCase();
  return String(env.ADMIN_EMAILS_SECRET ?? '').split(',').some(value => value.trim().length > 0 && value.trim().toLowerCase() === email);
}

export async function assertAccountDeletable(env: Env, userId: string): Promise<void> {
  // Read current privileges instead of trusting a cached login or search result.
  const user = await env.DB.prepare('SELECT email,role FROM user WHERE id=?').bind(userId)
    .first<{ email: string; role: string | null }>();
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'This account no longer exists.');
  if (isAdminAccount(env, user)) throw new ApiError(409, 'ADMIN_ACCOUNT_PROTECTED', 'Admin accounts cannot be deleted.');
}
