import { Hono } from 'hono';
import { z } from 'zod';
import type { App, AppUser } from '../../types';
import { ApiError, body } from '../../lib/http';
import { isAdminAccount } from '../../lib/admin-identity';
import { deleteAccount } from '../../lib/account-deletion';

// Mounted beneath live admin authentication and mutation Origin verification.
export const adminUserRoutes = new Hono<App>();
const searchSchema = z.object({ q: z.string().trim().min(1).max(320), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) });
adminUserRoutes.get('/', async c => {
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'INVALID_USER_QUERY', 'Enter a user ID or email address.');
  const { q, offset } = parsed.data;
  const rows = await c.env.DB.prepare(`SELECT * FROM (
    SELECT u.id,u.name,u.email,u.role,COALESCE(b.plan,'starter') AS plan,
      'active' AS status,u.createdAt AS signedUpAt,NULL AS deletedAt,
      b.provider_customer_id AS polarCustomerId,COALESCE(a.available_credits,0) AS creditBalance,
      NULL AS deletionSource,NULL AS deletedByUserId
    FROM user u LEFT JOIN billing_accounts b ON b.user_id=u.id
      LEFT JOIN credit_accounts a ON a.user_id=u.id
    UNION ALL
    SELECT user_id AS id,'' AS name,email,NULL AS role,plan,'deleted' AS status,
      signed_up_at AS signedUpAt,deleted_at AS deletedAt,polar_customer_id AS polarCustomerId,
      remaining_credits AS creditBalance,deletion_source AS deletionSource,deleted_by_user_id AS deletedByUserId
    FROM deleted_accounts
    ) WHERE id=? OR instr(lower(email),?)>0
    ORDER BY lower(email),status,deletedAt DESC,id LIMIT 26 OFFSET ?`)
    .bind(q, q.toLowerCase(), offset).all<{
      id: string; name: string; email: string; role: string | null; plan: string;
      status: 'active' | 'deleted'; signedUpAt: number; deletedAt: number | null;
      polarCustomerId: string | null; creditBalance: number;
      deletionSource: 'self' | 'admin' | 'database' | null; deletedByUserId: string | null;
    }>();
  return c.json({ users: rows.results.slice(0,25).map(({ role, ...user }) => ({ ...user,
    isAdmin: user.status === 'active' && isAdminAccount(c.env, { ...user, role }),
  })), nextOffset: rows.results.length>25 ? offset+25 : null });
});
adminUserRoutes.delete('/:userId', async c => {
  const id = z.string().min(1).max(128).safeParse(c.req.param('userId'));
  const confirmation = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).safeParse(await body(c.req.raw));
  if (!id.success || !confirmation.success) throw new ApiError(422, 'INVALID_USER_DELETION', 'Confirm the account email before deleting.');
  if (id.data === c.get('adminUserId')) throw new ApiError(409, 'ADMIN_ACCOUNT_PROTECTED', 'Admin accounts cannot be deleted.');
  const user = await c.env.DB.prepare('SELECT id,name,email FROM user WHERE id=?').bind(id.data).first<AppUser>();
  if (!user) return c.body(null, 204);
  if (user.email.trim().toLowerCase() !== confirmation.data.email) {
    throw new ApiError(409, 'USER_IDENTITY_CHANGED', 'The account email changed. Search for the user again before deleting.');
  }
  const adminUserId = c.get('adminUserId');
  if (!adminUserId) throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication is required.');
  await deleteAccount(c.env, user, { source: 'admin', userId: adminUserId });
  console.info({ event: 'admin_account_deleted', adminUserId: c.get('adminUserId'), userId: user.id });
  return c.body(null, 204);
});
