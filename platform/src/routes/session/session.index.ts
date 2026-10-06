import { listProjectItems, type ProjectItemRecord } from '../../lib/project-items';
import { framePreviewPrefix } from '../../agents/runtime/frame-previews';
import { userAccountInstanceName } from '../../agents/runtime/identity';
import { MAX_SOURCE_SNAPSHOT_BYTES, saveSourceSchema, sourceIdentity, sourceIdSchema, sourceRevision, sourceRevisionSchema } from '../../lib/source-history';
import { referenceSource, restoreSource, sourceThumbnail } from '../../lib/source-history-storage';
import { entitlementEvidence, projectItemInput, recoverProjectItem, restoreReference } from '../../lib/project-item-restore';
import type { PinResult } from '../../durable-objects/user-account';
import { z } from 'zod';
import { deleteAgentAccountData } from '../../agents/runtime/account-deletion';
import { Hono, type Context } from 'hono';
import type { App, ImportPayload } from '../../types';
import {
  requireAccountPrincipal,
  requirePrincipal,
  requireSessionPrincipal,
  requireUser,
} from '../../middlewares/authentication';
import { ApiError, asId, body, now, sha256, text } from '../../lib/http';
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
  '/sources/recent',
  '/sources/recent/*',
  '/projects/:id/sources',
  '/projects/:id/sources/*',
  '/oauth/youtube/connect',
  '/oauth/youtube',
  '/billing',
] as const;

for (const path of ACCOUNT_ROUTE_PATTERNS) sessionRoutes.use(path, requireAccountPrincipal);
for (const path of SESSION_ONLY_ROUTE_PATTERNS) sessionRoutes.use(path, requireSessionPrincipal);

sessionRoutes.get('/sources/recent', async (c) => {
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(requireUser(c).id));
  const entries = await account.listSourceReferences();
  const sources = await Promise.all(entries.map(async ({ source, snapshot }) => {
    if (!snapshot) return source;
    // Missing old metadata must not prevent the rest of the history from loading.
    const thumbnailUrl = await sourceThumbnail(c.env, snapshot).catch(() => undefined);
    if (!thumbnailUrl) return source;
    await account.cacheSourceThumbnail(source.id, thumbnailUrl);
    return { ...source, thumbnailUrl };
  }));
  return c.json({ sources });
});

sessionRoutes.post('/sources/recent', async (c) => {
  const json = await sourceJson(c.req.raw);
  const parsed = saveSourceSchema.safeParse(json);
  if (!parsed.success) throw new ApiError(422, 'INVALID_SOURCE', 'The recent source data is invalid.');
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(requireUser(c).id));
  if (parsed.data.projectId) await ownProject(c.env, requireUser(c).id, parsed.data.projectId);
  const referenced = await referenceSource(c.env, parsed.data);
  const sourceRevisionValue = await sourceRevision(referenced.snapshot);
  if (parsed.data.projectId && referenced.snapshot.kind === 'inspection') {
    // Add sources into a project that already holds this whole source as a D1 item:
    // retain the reference with that item rather than adding a second visible row.
    const { inspector } = referenced.snapshot;
    const existing = await wholeSourceItem(c.env, requireUser(c).id, parsed.data.projectId, inspector.provider, inspector.type, inspector.id);
    if (existing) {
      const saved = await account.saveSourceWithItemPin(referenced, parsed.data.projectId, existing.id,
        { provider: inspector.provider, type: inspector.type, id: inspector.id });
      return c.json({ source: saved.source, linked: { item: existing, added: false }, sourceRevision: saved.sourceRevision }, 201);
    }
  }
  const saved = await account.saveSourceWithProject(referenced, parsed.data.projectId);
  // The browser keeps this fingerprint so a later Save pins exactly this version.
  return c.json({ ...saved, sourceRevision: sourceRevisionValue }, 201);
});

sessionRoutes.get('/sources/recent/:id', async (c) => {
  const id = c.req.param('id');
  if (!sourceIdSchema.safeParse(id).success) throw new ApiError(422, 'INVALID_ID', 'Invalid recent source ID.');
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(requireUser(c).id));
  const saved = await account.getSource(id);
  if (!saved) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'This recent source was not found.');
  return c.json({ source: saved.source, snapshot: await restoreSource(c.env, saved.snapshot), sourceRevision: await sourceRevision(saved.snapshot) });
});

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
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
  const counts = new Map((await account.projectSourceCounts()).map(({ projectId, count }) => [projectId, count]));
  return c.json({ projects: result.results.map(project => ({
    ...project, item_count: Number(project.item_count ?? 0) + (counts.get(String(project.id)) ?? 0),
  })) });
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
  return c.json({ ...project, items: await listProjectItems(c.env, user.id, id) });
});

sessionRoutes.get('/projects/:id/sources/:itemId', async (c) => {
  const user = requireUser(c);
  const projectId = asId(c.req.param('id'));
  await ownProject(c.env, user.id, projectId);
  const itemId = c.req.param('itemId');
  if (!sourceIdSchema.safeParse(itemId).success) throw new ApiError(422, 'INVALID_ID', 'Invalid project source ID.');
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
  const saved = await account.getProjectSource(projectId, itemId);
  if (!saved) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'This project source was not found.');
  return c.json({ source: saved.source, snapshot: await restoreSource(c.env, saved.snapshot) });
});

// Every project item opens here: ownership-checked, storage-only, free and write-free.
sessionRoutes.get('/projects/:id/sources/items/:itemId', async (c) => {
  const user = requireUser(c);
  const projectId = asId(c.req.param('id'));
  const itemId = c.req.param('itemId');
  if (!sourceIdSchema.safeParse(itemId).success) throw new ApiError(422, 'INVALID_ID', 'Invalid project item ID.');
  await ownProject(c.env, user.id, projectId);
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
  const linked = await account.getProjectSource(projectId, itemId);
  if (linked) {
    const restored = await restoreReference(c.env, linked.snapshot, linked.source.title);
    if (restored) return c.json({ state: 'restored', item: linked.item, origin: 'project-source', recovered: false, source: linked.source,
      sourceRevision: await sourceRevision(linked.snapshot), ...restored });
    // The owned row is saved evidence: try other owned references and retained storage before asking to pay.
    const key = sourceIdentity({ input: linked.source.input, title: linked.source.title, snapshot: linked.snapshot });
    const references = await account.ownedSourceReferences(projectId, key);
    const recovered = await recoverProjectItem(c.env, { userId: user.id, projectId, references, ownedRow: true, sourceInput: linked.source.input,
      item: { ...linked.item, start_ms: null, end_ms: null, note: '', tags_json: '[]' } });
    return c.json(recovered.state === 'restored' ? { ...recovered, item: linked.item } : { state: 'unavailable', item: linked.item, input: linked.source.input });
  }
  const item = await ownedProjectItem(c.env, user.id, projectId, itemId);
  if (!item) throw new ApiError(404, 'ITEM_NOT_FOUND', 'This project item was not found.');
  const pin = await account.getProjectItemPin(projectId, itemId);
  if (pin) {
    const restored = await restoreReference(c.env, pin.snapshot, item.title);
    if (restored) return c.json({ state: 'restored', item, origin: 'pin', recovered: false, source: pin.source,
      sourceRevision: pin.sourceRevision, ...restored });
  }
  // A missing pointer, or a pin whose bytes are gone, is not proof that saved data is absent.
  const input = projectItemInput(item);
  const references = input ? await account.ownedSourceReferences(projectId, `youtube:${item.entity_type}:${item.entity_id}`) : [];
  const recovered = await recoverProjectItem(c.env, { userId: user.id, projectId, item, references });
  return c.json(recovered.state === 'restored' ? { ...recovered, item } : { state: 'unavailable', item, input });
});

/** Explicit Save only: attach owned references to the existing D1 item, never a second row. */
sessionRoutes.put('/projects/:id/sources/items/:itemId/snapshot', async (c) => {
  const user = requireUser(c);
  const projectId = asId(c.req.param('id'));
  const itemId = c.req.param('itemId');
  if (!sourceIdSchema.safeParse(itemId).success) throw new ApiError(422, 'INVALID_ID', 'Invalid project item ID.');
  const json = await sourceJson(c.req.raw);
  await ownProject(c.env, user.id, projectId);
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
  const item = await ownedProjectItem(c.env, user.id, projectId, itemId);
  if (!item) {
    // A standalone Save that matched an existing project source row refreshes that row in place.
    const linked = await account.getProjectSource(projectId, itemId);
    if (!linked || linked.item.entity_type === 'search') throw new ApiError(404, 'ITEM_NOT_FOUND', 'This project item was not found.');
    const receipt = pinReceiptSchema.safeParse(json);
    const descriptor = receipt.success ? null : saveSourceSchema.omit({ projectId: true }).strict().safeParse(json);
    if (descriptor && (!descriptor.success || descriptor.data.snapshot.kind !== 'inspection')) throw new ApiError(422, 'INVALID_SOURCE', 'The saved source data is invalid.');
    const result = await account.refreshProjectSource(projectId, itemId,
      receipt.success ? receipt.data : await referenceSource(c.env, descriptor!.data!),
      { provider: linked.item.provider, type: linked.item.entity_type, id: linked.item.entity_id });
    return pinResponse(c, result);
  }
  if (!projectItemInput(item)) throw new ApiError(422, 'UNSUPPORTED_ITEM', 'This project item cannot retain a source snapshot.');
  const identity = { provider: item.provider, type: item.entity_type, id: item.entity_id };
  const receipt = pinReceiptSchema.safeParse(json);
  let result: PinResult;
  if (receipt.success) {
    result = await account.pinProjectItemFromRecent(projectId, itemId, receipt.data.sourceId, receipt.data.sourceRevision, identity);
  } else {
    // Only for a browser whose Recent save failed: resolve the same descriptor from stored data.
    const descriptor = saveSourceSchema.omit({ projectId: true }).strict().safeParse(json);
    if (!descriptor.success || descriptor.data.snapshot.kind !== 'inspection') throw new ApiError(422, 'INVALID_SOURCE', 'The saved source data is invalid.');
    const { inspector } = descriptor.data.snapshot;
    if (inspector.provider !== identity.provider || inspector.type !== identity.type || inspector.id !== identity.id) {
      result = { ok: false, code: 'SOURCE_IDENTITY_MISMATCH' };
    } else {
      // The same saved-evidence boundary as opening: a new bookmark alone cannot pin shared data.
      const owned = await account.ownedSourceReferences(projectId, `youtube:${item.entity_type}:${item.entity_id}`);
      const evidence = owned.length ? null : await entitlementEvidence(c.env, user.id, projectId, item);
      if (evidence && !evidence.document && !evidence.imported) {
        throw new ApiError(409, 'SOURCE_EVIDENCE_PENDING', 'Saved data can be retained once this project’s import finishes. Retry shortly.');
      }
      result = await account.pinProjectItem(projectId, itemId, await referenceSource(c.env, descriptor.data), identity);
    }
  }
  return pinResponse(c, result);
});

function pinResponse(c: Context<App>, result: PinResult) {
  if (!result.ok) {
    if (result.code === 'SOURCE_NOT_FOUND') throw new ApiError(404, result.code, 'This recent source is no longer available. Inspect it again, then save.');
    if (result.code === 'SOURCE_REVISION_MISMATCH') throw new ApiError(409, result.code, 'A newer inspection replaced this version. Inspect it again, then save.');
    throw new ApiError(409, result.code, 'This saved data does not match the project item.');
  }
  return c.json({ itemId: result.itemId, sourceId: result.sourceId, sourceRevision: result.sourceRevision });
}

sessionRoutes.post('/projects/:id/sources', async (c) => {
  const user = requireUser(c);
  const projectId = asId(c.req.param('id'));
  await ownProject(c.env, user.id, projectId);
  const input = await body<{ sourceId?: string }>(c.req.raw);
  if (!sourceIdSchema.safeParse(input.sourceId).success) throw new ApiError(422, 'INVALID_SOURCE_ID', 'A saved source ID is required.');
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
  // A project that already holds this whole source as a D1 item retains the reference with it.
  const sourceKey = await account.peekSourceKey(input.sourceId!);
  const [, provider, type, entityId] = /^(youtube):(video|playlist|channel):(.+)$/.exec(sourceKey ?? '') ?? [];
  const existing = provider ? await wholeSourceItem(c.env, user.id, projectId, provider, type!, entityId!) : null;
  if (existing) {
    const result = await account.linkSourceToItem(projectId, input.sourceId!, existing.id, { provider: provider!, type: type!, id: entityId! });
    if (!result.ok) throw new ApiError(result.code === 'SOURCE_NOT_FOUND' ? 404 : 409, result.code, 'This recent source could not be linked. Try again.');
    return c.json({ item: existing, added: false }, 200);
  }
  if (!sourceKey) {
    // After Recent eviction, a link already retained with the D1 whole source is still that item; moments stay distinct.
    const pinnedItems = await account.pinnedItemsForSource(projectId, input.sourceId!);
    const item = pinnedItems.length ? await c.env.DB.prepare(`SELECT * FROM project_items WHERE project_id=? AND user_id=? AND start_ms IS NULL
      AND id IN (${pinnedItems.map(() => '?').join(',')}) ORDER BY created_at, id LIMIT 1`).bind(projectId, user.id, ...pinnedItems).first<ProjectItemRecord>() : null;
    if (item) return c.json({ item, added: false }, 200);
  }
  const linked = await account.linkSourceToProject(projectId, input.sourceId!);
  if (!linked) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'This recent source was not found.');
  return c.json(linked, linked.added ? 201 : 200);
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
  const title = text(input.title, 300);
  // SQLite UNIQUE treats NULL start_ms values as distinct. Match with IS so a
  // repeated whole-source Save or lost-response retry reuses its row, while every
  // moment (including start 0) stays distinct from the whole source.
  const identity = [projectId, user.id, provider.descriptor.id, entityType, entityId, startMs] as const;
  const matching = () => c.env.DB.prepare(
    `SELECT id FROM project_items WHERE project_id=? AND user_id=? AND provider=? AND entity_type=? AND entity_id=? AND start_ms IS ?
     ORDER BY created_at, id LIMIT 1`,
  ).bind(...identity).first<{ id: string }>();
  const content = text(input.content, 100_000);
  const index = async (itemId: string) => {
    if (!content) return;
    await c.env.TASKS.send({
      type: 'index-document',
      // Retries of the same content deduplicate; newer content still refreshes the private copy.
      idempotencyKey: `project-item:${itemId}:${await sha256(content)}`,
      payload: { provider: provider.descriptor.id, userId: user.id, projectId, entityId, title, content, startMs },
    }, { contentType: 'json' });
  };
  // A whole source already saved as a project source row is the same visible entry.
  if (startMs === null && !(await matching())) {
    const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
    const existingSource = await account.findProjectSourceItem(projectId, `${provider.descriptor.id}:${entityType}:${entityId}`);
    if (existingSource) {
      await index(existingSource);
      return c.json({ id: existingSource, existing: true }, 200);
    }
  }
  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO project_items
     (id,project_id,user_id,provider,entity_type,entity_id,title,start_ms,end_ms,note,tags_json,created_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM project_items
       WHERE project_id=? AND user_id=? AND provider=? AND entity_type=? AND entity_id=? AND start_ms IS ?)`
  ).bind(
    id, projectId, user.id, provider.descriptor.id, entityType, entityId, title, startMs,
    finiteNumber(input.endMs), text(input.note, 5000), JSON.stringify(cleanTags(input.tags)), now(), ...identity,
  ).run();
  const created = inserted.meta.changes > 0;
  const itemId = created ? id : (await matching())?.id;
  if (!itemId) throw new ApiError(409, 'PROJECT_ITEM_CONFLICT', 'This project item could not be saved. Try again.');
  await index(itemId);
  return c.json(created ? { id: itemId } : { id: itemId, existing: true }, created ? 201 : 200);
});

sessionRoutes.delete('/projects/:id', async (c) => {
  const user = requireUser(c);
  const id = asId(c.req.param('id'));
  await ownProject(c.env, user.id, id);
  await deleteProjectAssets(c.env, user.id, id);
  const result = await c.env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id, user.id).run();
  if (!result.meta.changes) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  const account = c.env.USER_ACCOUNT.getByName(await userAccountInstanceName(user.id));
  await account.removeProjectSources(id);
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

sessionRoutes.delete('/account', requireSessionPrincipal, async (c) => {
  const user = requireUser(c);
  await deleteAgentAccountData(c.env, user.id);
  await closeBillingAccount(c.env, user.id);
  await disconnectYoutube(c.env, user.id);
  await deleteR2Prefix(c.env.RESEARCH, `private/${user.id}/`);
  await deleteR2Prefix(c.env.RESEARCH, await framePreviewPrefix(user.id));
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

function ownedProjectItem(env: Env, userId: string, projectId: string, itemId: string): Promise<ProjectItemRecord | null> {
  return env.DB.prepare('SELECT * FROM project_items WHERE id=? AND project_id=? AND user_id=?')
    .bind(itemId, projectId, userId).first<ProjectItemRecord>();
}

/** The oldest whole-source D1 item for one source; moments never match. Historical duplicates stay untouched. */
function wholeSourceItem(env: Env, userId: string, projectId: string, provider: string, type: string, entityId: string): Promise<ProjectItemRecord | null> {
  return env.DB.prepare(`SELECT * FROM project_items WHERE project_id=? AND user_id=? AND provider=? AND entity_type=? AND entity_id=?
    AND start_ms IS NULL ORDER BY created_at, id LIMIT 1`).bind(projectId, userId, provider, type, entityId).first<ProjectItemRecord>();
}

const pinReceiptSchema = z.object({ sourceId: sourceIdSchema, sourceRevision: sourceRevisionSchema }).strict();

/** Size- and type-checked JSON for source-history writes. */
async function sourceJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new ApiError(422, 'INVALID_CONTENT_TYPE', 'Expected application/json.');
  const payload = await request.text();
  if (new TextEncoder().encode(payload).byteLength > MAX_SOURCE_SNAPSHOT_BYTES) throw new ApiError(422, 'SOURCE_TOO_LARGE', 'This source is too large to add to recent sources.');
  try { return JSON.parse(payload); } catch { throw new ApiError(422, 'INVALID_JSON', 'The request body is not valid JSON.'); }
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
