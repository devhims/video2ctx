import { Hono } from 'hono';
import type { App, ImportPayload } from '../../types';
import {
  requireAccountPrincipal,
  requirePrincipal,
  requireSessionPrincipal,
  requireUser,
} from '../../middlewares/authentication';
import { ApiError, asId, body, now, text } from '../../lib/http';
import { enforceCount, enforceImportLimit, entitlements } from '../../lib/entitlements';
import { assertFormat, createProjectExport } from '../../lib/exports';
import { disconnectYoutube, youtubeConnectUrl } from '../../lib/oauth';
import { closeBillingAccount, getBillingSummary } from '../../lib/billing';
import { deleteProjectAssets, deleteR2Prefix, userSearchInstanceId } from '../../lib/research-storage';
import { getProvider } from '../../providers';
import {
  DEFAULT_MONITOR_INTERVAL_MINUTES,
  cancelMonitorSchedule,
  configureMonitorSchedule,
  initialMonitorCheckAt,
  monitorCadence,
  monitorIntervalMinutes,
} from '../../lib/monitor-scheduler';
import { confirmEmailAlerts, getNotificationPreferences, saveNotificationPreferences } from '../../lib/notification-preferences';

export const sessionRoutes = new Hono<App>();

export const ACCOUNT_ROUTE_PATTERNS = [
  '/projects',
  '/projects/*',
  '/imports',
  '/jobs/*',
  '/exports/*',
  '/monitors',
  '/monitors/*',
  '/notifications',
  '/notifications/*',
  '/notification-preferences',
  '/account',
] as const;

export const SESSION_ONLY_ROUTE_PATTERNS = [
  '/oauth/youtube/connect',
  '/oauth/youtube',
  '/billing',
  '/admin/*',
] as const;

for (const path of ACCOUNT_ROUTE_PATTERNS) sessionRoutes.use(path, requireAccountPrincipal);
for (const path of SESSION_ONLY_ROUTE_PATTERNS) sessionRoutes.use(path, requireSessionPrincipal);

sessionRoutes.get('/account', (c) => {
  const principal = requirePrincipal(c);
  return c.json({
    user: principal.user,
    authentication: { method: principal.method },
  });
});

sessionRoutes.get('/projects', async (c) => {
  const user = requireUser(c);
  const result = await c.env.DB.prepare(
    `SELECT p.*,COUNT(i.id) AS item_count FROM projects p LEFT JOIN project_items i ON i.project_id=p.id
     WHERE p.user_id=? GROUP BY p.id ORDER BY p.updated_at DESC`
  ).bind(user.id).all();
  return c.json({ projects: result.results });
});

sessionRoutes.post('/projects', async (c) => {
  const user = requireUser(c);
  const limits = await entitlements(c.env, user.id);
  await enforceCount(c.env, user.id, 'projects', limits.projectLimit);
  const input = await body<{ name?: string; description?: string; tags?: string[] }>(c.req.raw);
  const name = text(input.name, 120);
  if (!name) throw new ApiError(422, 'PROJECT_NAME_REQUIRED', 'Project name is required.');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO projects (id,user_id,name,description,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, user.id, name, text(input.description, 1000), JSON.stringify(cleanTags(input.tags)), now(), now()).run();
  return c.json({ id, name }, 201);
});

sessionRoutes.get('/projects/:id', async (c) => {
  const user = requireUser(c);
  const id = asId(c.req.param('id'));
  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').bind(id, user.id).first();
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  const items = await c.env.DB.prepare('SELECT * FROM project_items WHERE project_id=? AND user_id=? ORDER BY created_at DESC')
    .bind(id, user.id).all();
  return c.json({ ...project, items: items.results });
});

sessionRoutes.post('/projects/:id/items', async (c) => {
  const user = requireUser(c);
  const projectId = asId(c.req.param('id'));
  await ownProject(c.env, user.id, projectId);
  const input = await body<Record<string, unknown>>(c.req.raw);
  const provider = getProvider(text(input.provider, 40));
  const entityType = text(input.entityType, 30);
  const entityId = asId(input.entityId);
  const id = crypto.randomUUID();
  const startMs = finiteNumber(input.startMs);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO project_items
     (id,project_id,user_id,provider,entity_type,entity_id,title,start_ms,end_ms,note,tags_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, projectId, user.id, provider.descriptor.id, entityType, entityId, text(input.title, 300), startMs,
    finiteNumber(input.endMs), text(input.note, 5000), JSON.stringify(cleanTags(input.tags)), now()
  ).run();
  const content = text(input.content, 100_000);
  if (content) {
    await c.env.TASKS.send({
      type: 'index-document',
      idempotencyKey: `project-item:${id}`,
      payload: {
        provider: provider.descriptor.id,
        userId: user.id,
        projectId,
        entityId,
        title: text(input.title, 300),
        content,
        startMs,
      },
    }, { contentType: 'json' });
  }
  return c.json({ id }, 201);
});

sessionRoutes.delete('/projects/:id', async (c) => {
  const user = requireUser(c);
  const id = asId(c.req.param('id'));
  await ownProject(c.env, user.id, id);
  await deleteProjectAssets(c.env, user.id, id);
  const result = await c.env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id, user.id).run();
  if (!result.meta.changes) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  return c.body(null, 204);
});

sessionRoutes.post('/imports', async (c) => {
  const user = requireUser(c);
  const input = await body<{
    provider?: string;
    kind?: ImportPayload['kind'];
    entityId?: string;
    projectId?: string;
    idempotencyKey?: string;
  }>(c.req.raw);
  if (!input.kind || !['video', 'channel', 'playlist', 'comments', 'deep-comments'].includes(input.kind)) {
    throw new ApiError(422, 'INVALID_IMPORT_KIND', 'Invalid import kind.');
  }
  await enforceImportLimit(c.env, user.id, await entitlements(c.env, user.id), input.kind === 'deep-comments');
  const provider = getProvider(text(input.provider, 40));
  const entityId = asId(input.entityId);
  if (input.projectId) await ownProject(c.env, user.id, input.projectId);
  const idempotencyKey = text(c.req.header('idempotency-key') ?? input.idempotencyKey, 200)
    || `import:${provider.descriptor.id}:${input.kind}:${entityId}:${input.projectId ?? ''}`;
  const existing = await c.env.DB.prepare('SELECT id,status,progress FROM jobs WHERE user_id=? AND idempotency_key=?')
    .bind(user.id, idempotencyKey).first();
  if (existing) return c.json(existing, 202);
  const jobId = crypto.randomUUID();
  const payload: ImportPayload = {
    jobId,
    userId: user.id,
    provider: provider.descriptor.id,
    kind: input.kind,
    entityId,
    projectId: input.projectId,
    idempotencyKey,
  };
  await c.env.DB.prepare(
    `INSERT INTO jobs (id,user_id,kind,input_json,status,idempotency_key,created_at,updated_at)
     VALUES (?,?,?,?,'queued',?,?,?)`
  ).bind(jobId, user.id, input.kind, JSON.stringify(payload), idempotencyKey, now(), now()).run();
  await c.env.IMPORT_WORKFLOW.create({ id: `import-${jobId}`, params: payload });
  return c.json({ id: jobId, status: 'queued', progress: 0 }, 202);
});

sessionRoutes.get('/jobs/:id', async (c) => {
  const user = requireUser(c);
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?')
    .bind(asId(c.req.param('id')), user.id).first();
  if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
  return c.json(job);
});

sessionRoutes.post('/projects/:id/exports', async (c) => {
  const user = requireUser(c);
  const projectId = asId(c.req.param('id'));
  const input = await body<{ format?: string }>(c.req.raw);
  return c.json(await createProjectExport(
    c.env,
    user.id,
    projectId,
    assertFormat((input.format ?? '').toLowerCase()),
  ), 201);
});

sessionRoutes.get('/exports/:id/download', async (c) => {
  const user = requireUser(c);
  const record = await c.env.DB.prepare('SELECT r2_key,format FROM exports WHERE id=? AND user_id=?')
    .bind(asId(c.req.param('id')), user.id).first<{ r2_key: string; format: string }>();
  if (!record) throw new ApiError(404, 'EXPORT_NOT_FOUND', 'Export not found.');
  const object = await c.env.RESEARCH.get(record.r2_key);
  if (!object) throw new ApiError(404, 'EXPORT_NOT_FOUND', 'Export file not found.');
  return new Response(object.body, { headers: {
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-disposition': `attachment; filename="youtube-research.${record.format}"`,
  }});
});

sessionRoutes.get('/monitors', async (c) => {
  const user = requireUser(c);
  const result = await c.env.DB.prepare('SELECT * FROM monitors WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all();
  return c.json({ monitors: result.results });
});

sessionRoutes.post('/monitors', async (c) => {
  const user = requireUser(c);
  const limits = await entitlements(c.env, user.id);
  await enforceCount(c.env, user.id, 'monitors', limits.monitorLimit);
  const input = await body<{ provider?: string; kind?: string; target?: string; cadence?: string; intervalMinutes?: number; query?: unknown }>(c.req.raw);
  const provider = getProvider(text(input.provider, 40));
  if (!input.kind || !['channel', 'topic', 'search'].includes(input.kind)) {
    throw new ApiError(422, 'INVALID_MONITOR_KIND', 'Invalid monitor kind.');
  }
  const target = text(input.target, 500);
  if (!target) throw new ApiError(422, 'MONITOR_TARGET_REQUIRED', 'Monitor target is required.');
  const id = crypto.randomUUID();
  const intervalMinutes = monitorIntervalInput(input.intervalMinutes, input.cadence);
  const createdAt = now();
  const nextCheckAt = initialMonitorCheckAt(createdAt);
  await c.env.DB.prepare(
    `INSERT INTO monitors
     (id,user_id,provider,kind,target,query_json,cadence,interval_minutes,next_check_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, user.id, provider.descriptor.id, input.kind, target, JSON.stringify(input.query ?? {}),
    monitorCadence(intervalMinutes), intervalMinutes, nextCheckAt, createdAt,
  ).run();
  try {
    await configureMonitorSchedule(c.env, { monitorId: id, userId: user.id, intervalMinutes, nextCheckAt });
  } catch (error) {
    await c.env.DB.prepare('DELETE FROM monitors WHERE id=? AND user_id=?').bind(id, user.id).run();
    throw error;
  }
  return c.json({ id, intervalMinutes, nextCheckAt }, 201);
});

sessionRoutes.patch('/monitors/:id', async (c) => {
  const user = requireUser(c);
  const monitorId = asId(c.req.param('id'));
  const input = await body<{ query?: unknown; intervalMinutes?: number; enabled?: boolean }>(c.req.raw);
  const existing = await c.env.DB.prepare(
    `SELECT query_json,cadence,interval_minutes,enabled,next_check_at
     FROM monitors WHERE id=? AND user_id=?`
  ).bind(monitorId, user.id).first<{
    query_json: string;
    cadence: string;
    interval_minutes: number;
    enabled: number;
    next_check_at: number | null;
  }>();
  if (!existing) throw new ApiError(404, 'MONITOR_NOT_FOUND', 'Monitor not found.');

  const intervalMinutes = input.intervalMinutes === undefined
    ? monitorIntervalMinutes(existing.interval_minutes)
    : monitorIntervalMinutes(input.intervalMinutes);
  const enabled = input.enabled === undefined ? Boolean(existing.enabled) : input.enabled;
  const scheduleChanged = intervalMinutes !== existing.interval_minutes || enabled !== Boolean(existing.enabled);
  const nextCheckAt = enabled
    ? scheduleChanged || !existing.next_check_at ? initialMonitorCheckAt() : existing.next_check_at
    : null;
  const queryJson = input.query === undefined ? existing.query_json : JSON.stringify(input.query ?? {});

  await c.env.DB.prepare(
    `UPDATE monitors SET query_json=?,cadence=?,interval_minutes=?,enabled=?,next_check_at=?
     WHERE id=? AND user_id=?`
  ).bind(
    queryJson, monitorCadence(intervalMinutes), intervalMinutes, enabled ? 1 : 0, nextCheckAt,
    monitorId, user.id,
  ).run();

  try {
    if (enabled && nextCheckAt) {
      await configureMonitorSchedule(c.env, { monitorId, userId: user.id, intervalMinutes, nextCheckAt });
    } else {
      await cancelMonitorSchedule(c.env, monitorId);
    }
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE monitors SET query_json=?,cadence=?,interval_minutes=?,enabled=?,next_check_at=?
       WHERE id=? AND user_id=?`
    ).bind(
      existing.query_json, existing.cadence, existing.interval_minutes, existing.enabled, existing.next_check_at,
      monitorId, user.id,
    ).run();
    throw error;
  }

  return c.json({ intervalMinutes, enabled, nextCheckAt });
});

sessionRoutes.delete('/monitors/:id', async (c) => {
  const user = requireUser(c);
  const monitorId = asId(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM monitors WHERE id=? AND user_id=?')
    .bind(monitorId, user.id).run();
  try {
    await cancelMonitorSchedule(c.env, monitorId);
  } catch {
    // A deleted monitor is harmless if cancellation is briefly unavailable:
    // its next alarm verifies D1 ownership and then removes itself.
  }
  return c.body(null, 204);
});

sessionRoutes.get('/notifications', async (c) => {
  const user = requireUser(c);
  const result = await c.env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
    .bind(user.id).all();
  return c.json({ notifications: result.results });
});

sessionRoutes.post('/notifications/:id/read', async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?')
    .bind(now(), asId(c.req.param('id')), user.id).run();
  return c.json({ read: true });
});

sessionRoutes.get('/notification-preferences', async (c) => {
  const user = requireUser(c);
  return c.json(await getNotificationPreferences(c.env, user.id));
});

sessionRoutes.put('/notification-preferences', async (c) => {
  const user = requireUser(c);
  const input = await body<{ inApp?: boolean; emailAlerts?: boolean }>(c.req.raw);
  return c.json(await saveNotificationPreferences(c.env, user.id, input));
});

sessionRoutes.post('/notification-preferences/confirm-email', async (c) => {
  const user = requireUser(c);
  const input = await body<{ confirmation?: string }>(c.req.raw);
  return c.json(await confirmEmailAlerts(c.env, user.id, text(input.confirmation, 1000)));
});

sessionRoutes.get('/oauth/youtube/connect', async (c) => {
  return c.json({ url: await youtubeConnectUrl(c.env, requireUser(c).id) });
});

sessionRoutes.delete('/oauth/youtube', async (c) => {
  await disconnectYoutube(c.env, requireUser(c).id);
  return c.body(null, 204);
});

sessionRoutes.get('/billing', async (c) => {
  return c.json(await getBillingSummary(c.env, requireUser(c).id));
});

sessionRoutes.get('/admin/jobs', async (c) => {
  const user = requireUser(c);
  if (!c.env.ADMIN_EMAILS.split(',').map((value) => value.trim()).includes(user.email)) {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'Admin access required.');
  }
  const jobs = await c.env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all();
  return c.json({ jobs: jobs.results });
});

sessionRoutes.delete('/account', requireSessionPrincipal, async (c) => {
  const user = requireUser(c);
  await closeBillingAccount(c.env, user.id);
  await disconnectYoutube(c.env, user.id);
  await deleteR2Prefix(c.env.RESEARCH, `private/${user.id}/`);
  const instanceId = userSearchInstanceId(user.id);
  await c.env.TASKS.send({
    type: 'delete-user-search',
    idempotencyKey: `delete-search:${user.id}`,
    payload: { instanceId },
  }, { contentType: 'json' });
  await c.env.DB.prepare('DELETE FROM user WHERE id=?').bind(user.id).run();
  return c.body(null, 204);
});

async function ownProject(env: Env, userId: string, projectId: string): Promise<void> {
  const project = await env.DB.prepare('SELECT 1 FROM projects WHERE id=? AND user_id=?').bind(projectId, userId).first();
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
}

function cleanTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().slice(0, 50)).filter(Boolean).slice(0, 20)
    : [];
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function monitorIntervalInput(value: unknown, legacyCadence: unknown): number {
  if (value !== undefined) return monitorIntervalMinutes(value);
  const cadence = text(legacyCadence, 30).toLowerCase();
  if (!cadence) return DEFAULT_MONITOR_INTERVAL_MINUTES;
  if (cadence === 'hourly') return 60;
  if (cadence === 'daily') return 1440;
  const minutes = /^(\d+)m$/.exec(cadence)?.[1];
  return monitorIntervalMinutes(minutes ?? cadence);
}
