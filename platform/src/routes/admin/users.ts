import { Hono } from 'hono';
import { z } from 'zod';
import type { App, AppUser } from '../../types';
import { ApiError, body } from '../../lib/http';
import { deleteAccount } from '../../lib/account-deletion';

// Mounted beneath live admin authentication and mutation Origin verification.
export const adminUserRoutes = new Hono<App>();
const searchSchema = z.object({ q: z.string().trim().min(1).max(320), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) });
adminUserRoutes.get('/', async c => {
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'INVALID_USER_QUERY', 'Enter a user ID or email address.');
  const { q, offset } = parsed.data;
  const rows = await c.env.DB.prepare(`SELECT u.id,u.name,u.email,COALESCE(b.plan,'starter') AS plan
    FROM user u LEFT JOIN billing_accounts b ON b.user_id=u.id
    WHERE u.id=? OR instr(lower(u.email),?)>0 ORDER BY u.email,u.id LIMIT 26 OFFSET ?`)
    .bind(q, q.toLowerCase(), offset).all();
  return c.json({ users: rows.results.slice(0,25), nextOffset: rows.results.length>25 ? offset+25 : null });
});
adminUserRoutes.delete('/:userId', async c => {
  const id = z.string().min(1).max(128).safeParse(c.req.param('userId'));
  const confirmation = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).safeParse(await body(c.req.raw));
  if (!id.success || !confirmation.success) throw new ApiError(422, 'INVALID_USER_DELETION', 'Confirm the account email before deleting.');
  if (id.data === c.get('adminUserId')) throw new ApiError(409, 'ADMIN_SELF_DELETE', 'Use account settings to delete your own account.');
  const user = await c.env.DB.prepare('SELECT id,name,email FROM user WHERE id=?').bind(id.data).first<AppUser>();
  if (!user) return c.body(null, 204);
  if (user.email.trim().toLowerCase() !== confirmation.data.email) {
    throw new ApiError(409, 'USER_IDENTITY_CHANGED', 'The account email changed. Search for the user again before deleting.');
  }
  await deleteAccount(c.env, user);
  console.info({ event: 'admin_account_deleted', adminUserId: c.get('adminUserId'), userId: user.id });
  return c.body(null, 204);
});
