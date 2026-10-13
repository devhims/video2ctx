import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../types';
import { ApiError, body } from '../../lib/http';

// Mounted beneath the shared live-admin-session and Origin middleware.
export const adminCreditRoutes = new Hono<App>();
const lookupSchema = z.object({ user: z.string().trim().min(1).max(320) });
const grantSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  requestId: z.string().uuid(),
  credits: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().max(500).default(''),
});
type CreditUser = { id: string; name: string; email: string; creditBalance: number | null };
type Grant = { id: string; userId: string; credits: number; reason: string; adminUserId: string; createdAt: number };
const userSelect = `SELECT u.id, u.name, u.email, a.available_credits AS creditBalance
  FROM user u LEFT JOIN credit_accounts a ON a.user_id = u.id`;
const grantSelect = `SELECT id, user_id AS userId, credits,
  json_extract(metadata_json, '$.reason') AS reason,
  json_extract(metadata_json, '$.adminUserId') AS adminUserId, created_at AS createdAt
  FROM credit_ledger`;

function requireAccount(user: CreditUser | undefined | null) {
  if (!user) throw new ApiError(404, 'CREDIT_USER_NOT_FOUND', 'No account matches that user ID or email.');
  if (typeof user.creditBalance !== 'number') {
    throw new ApiError(503, 'CREDIT_ACCOUNT_UNAVAILABLE', 'This account’s credit balance is unavailable.');
  }
  return user;
}

adminCreditRoutes.get('/', async c => {
  const parsed = lookupSchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'INVALID_CREDIT_USER', 'Enter a user ID or exact email address.');
  const query = parsed.data.user;
  const users = await c.env.DB.prepare(`${userSelect} WHERE u.id = ? OR lower(u.email) = lower(?) LIMIT 2`)
    .bind(query, query).all<CreditUser>();
  if (users.results.length > 1) throw new ApiError(422, 'AMBIGUOUS_CREDIT_USER', 'More than one account matches. Use the user ID.');
  const user = requireAccount(users.results[0]);
  const grants = await c.env.DB.prepare(`${grantSelect}
    WHERE user_id = ? AND entry_type = 'adjustment' AND operation_id LIKE 'admin-credit:%'
    ORDER BY created_at DESC, id DESC LIMIT 10`).bind(user.id).all<Grant>();
  return c.json({ user, grants: grants.results });
});

adminCreditRoutes.post('/grants', async c => {
  const parsed = grantSchema.safeParse(await body(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'INVALID_CREDIT_GRANT', 'Enter a whole number from 1 to 1,000,000 credits and an optional reason of up to 500 characters.');
  const { userId, requestId, credits, reason } = parsed.data;
  const adminUserId = c.get('adminUserId');
  if (!adminUserId) throw new ApiError(403, 'ADMIN_REQUIRED', 'Admin access required.');
  requireAccount(await c.env.DB.prepare(`${userSelect} WHERE u.id = ?`).bind(userId).first<CreditUser>());
  const metadata = JSON.stringify({ source: 'admin_dashboard', reason, adminUserId });
  // One transaction inserts the grant, fires the balance trigger, and reads its
  // receipt. The globally unique entry ID also prevents reuse across users.
  const [inserted, receipt, account] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO credit_ledger
      (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
      SELECT ?, u.id, ?, 'adjustment', ?, ?, ? FROM user u
      JOIN credit_accounts a ON a.user_id = u.id WHERE u.id = ?
      ON CONFLICT DO NOTHING`)
      .bind(requestId, `admin-credit:${requestId}`, credits, metadata, Date.now(), userId),
    c.env.DB.prepare(`${grantSelect} WHERE id = ? AND entry_type = 'adjustment'
      AND operation_id = ?`).bind(requestId, `admin-credit:${requestId}`),
    c.env.DB.prepare(`${userSelect} WHERE u.id = ?`).bind(userId),
  ]);
  const user = requireAccount(account!.results[0] as CreditUser | undefined);
  const grant = receipt!.results[0] as Grant | undefined;
  if (!grant || grant.userId !== userId || grant.credits !== credits || grant.reason !== reason || grant.adminUserId !== adminUserId) {
    throw new ApiError(409, 'CREDIT_GRANT_CONFLICT', 'This request ID was already used for a different grant. Look up the account again.');
  }
  return c.json({ user, grant, replayed: inserted!.meta.changes === 0 });
});
