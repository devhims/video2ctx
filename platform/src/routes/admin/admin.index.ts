import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../types';
import { requireAdminMutationOrigin, requireAdminSession } from '../../lib/admin-access';
import { ApiError, body } from '../../lib/http';

export const adminRoutes = new Hono<App>();
adminRoutes.use('/admin/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await requireAdminSession(c);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireAdminMutationOrigin(c);
  await next();
});

adminRoutes.get('/admin/access', c => c.json({ enabled: true }));

const listSchema = z.object({
  q: z.string().trim().max(320).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const emailSchema = z.object({ email: z.string().trim().toLowerCase().max(320).email() });

adminRoutes.get('/admin/agent-access', async c => {
  const query = listSchema.safeParse(c.req.query());
  if (!query.success) throw new ApiError(422, 'INVALID_QUERY', 'Invalid allowlist query.');
  const { q, limit, offset } = query.data;
  const [rows, count] = await c.env.DB.batch<{ email?: string; createdAt?: number; total?: number }>([
    c.env.DB.prepare(`SELECT email, created_at AS createdAt FROM agent_access_allowlist
      WHERE instr(lower(trim(email)), ?) > 0 ORDER BY created_at DESC, email LIMIT ? OFFSET ?`)
      .bind(q.toLowerCase(), limit, offset),
    c.env.DB.prepare('SELECT count(*) AS total FROM agent_access_allowlist WHERE instr(lower(trim(email)), ?) > 0')
      .bind(q.toLowerCase()),
  ]);
  if (!rows || !count || typeof count.results[0]?.total !== 'number') {
    throw new ApiError(503, 'ALLOWLIST_UNAVAILABLE', 'Agent access could not be loaded.');
  }
  return c.json({ entries: rows.results, total: count.results[0].total, limit, offset });
});

adminRoutes.post('/admin/agent-access', async c => {
  const parsed = emailSchema.safeParse(await body(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'INVALID_EMAIL', 'Enter a valid email address.');
  await c.env.DB.prepare('INSERT INTO agent_access_allowlist (email) VALUES (?) ON CONFLICT DO NOTHING')
    .bind(parsed.data.email).run();
  return c.json({ email: parsed.data.email, enabled: true });
});

adminRoutes.delete('/admin/agent-access', async c => {
  const parsed = emailSchema.safeParse(await body(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'INVALID_EMAIL', 'Enter a valid email address.');
  await c.env.DB.prepare('DELETE FROM agent_access_allowlist WHERE lower(trim(email)) = ?')
    .bind(parsed.data.email).run();
  return c.json({ email: parsed.data.email, enabled: false });
});

adminRoutes.get('/admin/jobs', async c => {
  const jobs = await c.env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all();
  return c.json({ jobs: jobs.results });
});
