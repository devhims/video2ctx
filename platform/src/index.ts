import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { SearchFilters } from './lib/youtube-types';
import type { AppUser, AppVariables, ImportPayload, MonitorPayload } from './types';
import { createAuth } from './lib/auth';
import { ApiError, asId, body, jsonError, now, sha256, text } from './lib/http';
import {
  browseYouTube, getAllComments, getCaptionTracks, getChannel, getComments, getEndscreen, getPlaylist,
  getStoryboards, getTranscript, getVideo, routeInput, searchYouTube,
} from './lib/youtube';
import { creditBalance, enforceCount, enforceImportLimit, entitlements, releaseCredits, reserveCredits, settleCredits } from './lib/entitlements';
import { requireEvidence, searchPrivate, searchPublic } from './lib/search';
import { citedAnswer } from './lib/analysis';
import { transcriptEvidence } from './lib/evidence';
import { assertFormat, createProjectExport } from './lib/exports';
import { disconnectYoutube, youtubeConnectUrl, youtubeOAuthCallback } from './lib/oauth';
import { createCheckout, processStripeWebhook } from './lib/billing';
import { queueDigests, unsubscribe } from './lib/digests';
import { handleQueue } from './queues';
import { researchTrendTopic } from './lib/trends';
import { generateTrendPlan, normalizeTrendPlanSignals } from './lib/trend-plan';
import { documentationApp } from './docs';
export { ImportWorkflow, MonitorWorkflow } from './workflows';

type App = { Bindings: Env; Variables: AppVariables };
export const app = new Hono<App>();

app.use('*', async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? crypto.randomUUID());
  c.header('X-Request-Id', c.get('requestId'));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  await next();
});

app.route('/', documentationApp);

app.use('/api/auth/*', cors({
  origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : c.env.APP_ORIGIN,
  allowHeaders: ['Content-Type'], allowMethods: ['GET', 'POST', 'OPTIONS'], credentials: true,
}));

app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));

app.use('/v1/*', async (c, next) => {
  let user: AppUser | null = null;
  try {
    const session = await createAuth(c.env, c.executionCtx).api.getSession({ headers: c.req.raw.headers });
    if (session?.user) user = { id: session.user.id, email: session.user.email, name: session.user.name };
  } catch (error) {
    console.warn('session_lookup_failed', error);
  }
  const demoId = c.req.header('x-demo-user');
  if (!user && demoId && String(c.env.ENVIRONMENT) !== 'production') {
    const id = `demo-${(await sha256(demoId)).slice(0, 24)}`;
    const timestamp = now();
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)`
    ).bind(id, 'Demo Researcher', `${id}@example.test`, timestamp, timestamp).run();
    user = { id, name: 'Demo Researcher', email: `${id}@example.test` };
  }
  c.set('user', user);
  await next();
});

app.get('/', (c) => c.json({
  service: 'all-things-youtube-platform', version: 'v1', status: 'ok',
  capabilities: ['discover','inspect','save','search','compare','monitor','synthesize'],
}));
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/v1/billing/webhook', async (c) => {
  await processStripeWebhook(c.env, c.req.raw);
  return c.json({ received: true });
});

app.post('/v1/resolve', async (c) => {
  await enforcePublicEntry(c);
  const input = await body<{ input?: string }>(c.req.raw);
  return c.json(routeInput(text(input.input, 500)));
});

app.get('/v1/search', async (c) => {
  const mode = c.req.query('mode') ?? 'youtube';
  const query = text(c.req.query('q'), 500);
  if (!query) throw new ApiError(422, 'QUERY_REQUIRED', 'A search query is required.');
  if (mode === 'youtube') {
    await enforcePublicRate(c);
    const filters: SearchFilters = {
      type: entityType(c.req.query('type')),
      channelId: text(c.req.query('channel'), 200) || undefined,
      language: text(c.req.query('language'), 32) || undefined,
      duration: duration(c.req.query('duration')),
      sort: sort(c.req.query('sort')),
      captionsOnly: c.req.query('captions') === 'true' || undefined,
      live: live(c.req.query('live')),
      continuation: text(c.req.query('continuation'), 10_000) || undefined,
    };
    return c.json(await searchYouTube(c.env, query, filters));
  }
  const user = requireUser(c);
  if (mode === 'inside') return c.json({ query, results: await searchPrivate(c.env, user.id, query, c.req.query('projectId')) });
  if (mode === 'ask') {
    const evidence = requireEvidence(await searchPrivate(c.env, user.id, query, c.req.query('projectId')));
    return c.json(await runAnalysis(c.env, user.id, query, evidence, 'answer'));
  }
  throw new ApiError(422, 'INVALID_SEARCH_MODE', 'Use youtube, inside, or ask.');
});

app.get('/v1/browse', async (c) => {
  await enforcePublicRate(c);
  return c.json(await browseYouTube(c.env, {
    categoryId: text(c.req.query('category'), 32) || undefined,
    region: text(c.req.query('region'), 8) || undefined,
    language: text(c.req.query('language'), 16) || undefined,
    continuation: text(c.req.query('continuation'), 4000) || undefined,
  }));
});

app.get('/v1/trends', async (c) => {
  await enforcePublicRate(c);
  const query = text(c.req.query('q'), 200);
  if (!query) throw new ApiError(422, 'QUERY_REQUIRED', 'A topic is required.');
  const requestedLimit = Number(c.req.query('limit') ?? 20);
  const includeAiInsights = c.req.query('insights') !== 'deterministic';
  return c.json(await researchTrendTopic(
    c.env,
    query,
    Number.isFinite(requestedLimit) ? requestedLimit : 20,
    includeAiInsights
  ));
});

app.post('/v1/trends/plan', async (c) => {
  const user = requireUser(c);
  const payload = await body<{ report?: unknown }>(c.req.raw);
  const signals = normalizeTrendPlanSignals(payload.report);
  const operationId = crypto.randomUUID();
  const reserved = 32;
  await reserveCredits(c.env, user.id, operationId, reserved, { mode: 'trend-plan', topic: signals.query });
  try {
    const plan = await generateTrendPlan(c.env, signals, operationId);
    await settleCredits(c.env, user.id, operationId, reserved, 26, 0);
    return c.json({ ...plan, operationId });
  } catch (error) {
    await releaseCredits(c.env, user.id, operationId, reserved);
    throw error;
  }
});

app.get('/v1/videos/:id', async (c) => c.json(await getVideo(c.env, asId(c.req.param('id')))));
app.get('/v1/videos/:id/captions', async (c) => c.json(await getCaptionTracks(asId(c.req.param('id')))));
app.get('/v1/videos/:id/transcript', async (c) => c.json(await getTranscript(c.env, asId(c.req.param('id')), text(c.req.query('language'), 20) || 'en')));
app.get('/v1/videos/:id/comments', async (c) => {
  const id = asId(c.req.param('id'));
  const result = c.req.query('all') === 'true'
    ? await getAllComments(c.env, id)
    : await getComments(c.env, id, c.req.query('continuation'));
  const {
    replyContinuations: _internalReplyContinuations,
    newestContinuation: _internalNewestContinuation,
    ...publicResult
  } = result;
  return c.json(publicResult);
});
app.get('/v1/videos/:id/storyboards', async (c) => c.json(await getStoryboards(asId(c.req.param('id')))));
app.get('/v1/videos/:id/endscreen', async (c) => c.json(await getEndscreen(asId(c.req.param('id')))));
app.get('/v1/channels/:id', async (c) => c.json(await getChannel(c.env, asId(c.req.param('id')))));
app.get('/v1/playlists/:id', async (c) => c.json(await getPlaylist(c.env, asId(c.req.param('id')))));

app.get('/v1/projects', async (c) => {
  const user = requireUser(c);
  const result = await c.env.DB.prepare(
    `SELECT p.*,COUNT(i.id) AS item_count FROM projects p LEFT JOIN project_items i ON i.project_id=p.id
     WHERE p.user_id=? GROUP BY p.id ORDER BY p.updated_at DESC`
  ).bind(user.id).all();
  return c.json({ projects: result.results });
});

app.post('/v1/projects', async (c) => {
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

app.get('/v1/projects/:id', async (c) => {
  const user = requireUser(c); const id = asId(c.req.param('id'));
  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').bind(id, user.id).first();
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  const items = await c.env.DB.prepare('SELECT * FROM project_items WHERE project_id=? AND user_id=? ORDER BY created_at DESC').bind(id, user.id).all();
  return c.json({ ...project, items: items.results });
});

app.post('/v1/projects/:id/items', async (c) => {
  const user = requireUser(c); const projectId = asId(c.req.param('id'));
  await ownProject(c.env, user.id, projectId);
  const input = await body<Record<string, unknown>>(c.req.raw);
  const entityTypeValue = text(input.entityType, 30);
  const entityId = asId(input.entityId);
  const id = crypto.randomUUID();
  const startMs = finiteNumber(input.startMs);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO project_items
     (id,project_id,user_id,entity_type,entity_id,title,start_ms,end_ms,note,tags_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, projectId, user.id, entityTypeValue, entityId, text(input.title, 300), startMs,
    finiteNumber(input.endMs), text(input.note, 5000), JSON.stringify(cleanTags(input.tags)), now()
  ).run();
  const content = text(input.content, 100_000);
  if (content) {
    await c.env.TASKS.send({
      type: 'index-document', idempotencyKey: `project-item:${id}`,
      payload: { userId: user.id, projectId, entityId, title: text(input.title, 300), content, startMs },
    }, { contentType: 'json' });
  }
  return c.json({ id }, 201);
});

app.delete('/v1/projects/:id', async (c) => {
  const user = requireUser(c); const id = asId(c.req.param('id'));
  const result = await c.env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id, user.id).run();
  if (!result.meta.changes) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  return c.body(null, 204);
});

app.post('/v1/imports', async (c) => {
  const user = requireUser(c);
  const input = await body<{ kind?: ImportPayload['kind']; entityId?: string; projectId?: string; idempotencyKey?: string }>(c.req.raw);
  if (!input.kind || !['video','channel','playlist','comments','deep-comments'].includes(input.kind)) {
    throw new ApiError(422, 'INVALID_IMPORT_KIND', 'Invalid import kind.');
  }
  await enforceImportLimit(c.env, user.id, await entitlements(c.env, user.id), input.kind === 'deep-comments');
  const entityId = asId(input.entityId);
  if (input.projectId) await ownProject(c.env, user.id, input.projectId);
  const idempotencyKey = text(c.req.header('idempotency-key') ?? input.idempotencyKey, 200) || `import:${input.kind}:${entityId}:${input.projectId ?? ''}`;
  const existing = await c.env.DB.prepare('SELECT id,status,progress FROM jobs WHERE user_id=? AND idempotency_key=?')
    .bind(user.id, idempotencyKey).first();
  if (existing) return c.json(existing, 202);
  const jobId = crypto.randomUUID();
  const payload: ImportPayload = { jobId, userId: user.id, kind: input.kind, entityId, projectId: input.projectId, idempotencyKey };
  await c.env.DB.prepare(
    `INSERT INTO jobs (id,user_id,kind,input_json,status,idempotency_key,created_at,updated_at)
     VALUES (?,?,?,?,'queued',?,?,?)`
  ).bind(jobId, user.id, input.kind, JSON.stringify(payload), idempotencyKey, now(), now()).run();
  await c.env.IMPORT_WORKFLOW.create({ id: `import-${jobId}`, params: payload });
  return c.json({ id: jobId, status: 'queued', progress: 0 }, 202);
});

app.get('/v1/jobs/:id', async (c) => {
  const user = requireUser(c);
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').bind(asId(c.req.param('id')), user.id).first();
  if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
  return c.json(job);
});

app.post('/v1/answers', async (c) => {
  const user = requireUser(c);
  const input = await body<{ question?: string; projectId?: string; entityId?: string; scope?: 'private' | 'public' }>(c.req.raw);
  const question = text(input.question, 2000);
  if (!question) throw new ApiError(422, 'QUESTION_REQUIRED', 'A question is required.');
  const entityId = input.entityId ? asId(input.entityId) : undefined;
  const evidence = entityId
    ? transcriptEvidence(entityId, (await getTranscript(c.env, entityId)).segments, question)
    : input.scope === 'public'
      ? await searchPublic(c.env, question)
      : await searchPrivate(c.env, user.id, question, input.projectId);
  return c.json(await runAnalysis(c.env, user.id, question, requireEvidence(evidence), 'answer'));
});

app.post('/v1/comparisons', async (c) => {
  const user = requireUser(c);
  const input = await body<{ question?: string; projectId?: string }>(c.req.raw);
  const question = text(input.question, 2000) || 'Compare the selected sources, highlighting agreements, contradictions, and changes over time.';
  const evidence = requireEvidence(await searchPrivate(c.env, user.id, question, input.projectId));
  return c.json(await runAnalysis(c.env, user.id, question, evidence, 'comparison'));
});

app.post('/v1/reports', async (c) => {
  const user = requireUser(c);
  const input = await body<{ prompt?: string; projectId?: string }>(c.req.raw);
  const prompt = text(input.prompt, 2000) || 'Create an evidence-first research report with claims, supporting evidence, notable quotes, resources, action items, and content gaps.';
  const evidence = requireEvidence(await searchPrivate(c.env, user.id, prompt, input.projectId));
  return c.json(await runAnalysis(c.env, user.id, prompt, evidence, 'report'));
});

app.post('/v1/projects/:id/exports', async (c) => {
  const user = requireUser(c); const projectId = asId(c.req.param('id'));
  const input = await body<{ format?: string }>(c.req.raw);
  return c.json(await createProjectExport(c.env, user.id, projectId, assertFormat((input.format ?? '').toLowerCase())), 201);
});

app.get('/v1/exports/:id/download', async (c) => {
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

app.get('/v1/monitors', async (c) => {
  const user = requireUser(c);
  const result = await c.env.DB.prepare('SELECT * FROM monitors WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all();
  return c.json({ monitors: result.results });
});
app.post('/v1/monitors', async (c) => {
  const user = requireUser(c); const limits = await entitlements(c.env, user.id);
  await enforceCount(c.env, user.id, 'monitors', limits.monitorLimit);
  const input = await body<{ kind?: string; target?: string; cadence?: string; query?: unknown }>(c.req.raw);
  if (!input.kind || !['channel','topic','search'].includes(input.kind)) throw new ApiError(422, 'INVALID_MONITOR_KIND', 'Invalid monitor kind.');
  const target = text(input.target, 500); if (!target) throw new ApiError(422, 'MONITOR_TARGET_REQUIRED', 'Monitor target is required.');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO monitors (id,user_id,kind,target,query_json,cadence,created_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, user.id, input.kind, target, JSON.stringify(input.query ?? {}), text(input.cadence, 30) || 'hourly', now()).run();
  return c.json({ id }, 201);
});
app.delete('/v1/monitors/:id', async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare('DELETE FROM monitors WHERE id=? AND user_id=?').bind(asId(c.req.param('id')), user.id).run();
  return c.body(null, 204);
});

app.get('/v1/notifications', async (c) => {
  const user = requireUser(c);
  const result = await c.env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all();
  return c.json({ notifications: result.results });
});
app.post('/v1/notifications/:id/read', async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').bind(now(), asId(c.req.param('id')), user.id).run();
  return c.json({ read: true });
});
app.put('/v1/notification-preferences', async (c) => {
  const user = requireUser(c);
  const input = await body<{ inApp?: boolean; emailDigest?: string }>(c.req.raw);
  const digest = ['off','daily','weekly'].includes(input.emailDigest ?? '') ? input.emailDigest : 'weekly';
  await c.env.DB.prepare(
    `INSERT INTO notification_preferences (user_id,in_app,email_digest,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET in_app=excluded.in_app,email_digest=excluded.email_digest,
       unsubscribed_at=NULL,updated_at=excluded.updated_at`
  ).bind(user.id, input.inApp === false ? 0 : 1, digest, now()).run();
  return c.json({ inApp: input.inApp !== false, emailDigest: digest });
});
app.all('/v1/email/unsubscribe', async (c) => {
  const ok = await unsubscribe(c.env, text(c.req.query('user'), 200), text(c.req.query('token'), 500));
  return ok ? c.text('Email digests disabled.') : c.text('Invalid unsubscribe link.', 400);
});

app.get('/v1/oauth/youtube/connect', async (c) => c.json({ url: await youtubeConnectUrl(c.env, requireUser(c).id) }));
app.get('/v1/oauth/youtube/callback', async (c) => {
  const code = text(c.req.query('code'), 2000); const state = text(c.req.query('state'), 1000);
  if (!code || !state) throw new ApiError(422, 'OAUTH_CALLBACK_INVALID', 'OAuth code and state are required.');
  await youtubeOAuthCallback(c.env, code, state);
  return c.redirect(`${c.env.APP_ORIGIN}/settings/connections?youtube=connected`, 302);
});
app.delete('/v1/oauth/youtube', async (c) => { await disconnectYoutube(c.env, requireUser(c).id); return c.body(null, 204); });

app.post('/v1/billing/checkout', async (c) => c.json({ url: await createCheckout(c.env, requireUser(c)) }));
app.get('/v1/usage', async (c) => {
  const user = requireUser(c); const limits = await entitlements(c.env, user.id);
  return c.json({ ...limits, creditBalance: await creditBalance(c.env, user.id) });
});

app.get('/v1/admin/jobs', async (c) => {
  const user = requireUser(c);
  if (!c.env.ADMIN_EMAILS.split(',').map((value) => value.trim()).includes(user.email)) throw new ApiError(403, 'ADMIN_REQUIRED', 'Admin access required.');
  const jobs = await c.env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all();
  return c.json({ jobs: jobs.results });
});

app.delete('/v1/account', async (c) => {
  const user = requireUser(c);
  await disconnectYoutube(c.env, user.id);
  let cursor: string | undefined;
  do {
    const objects = await c.env.RESEARCH.list({ prefix: `private/${user.id}/`, cursor, limit: 1000 });
    if (objects.objects.length) await c.env.RESEARCH.delete(objects.objects.map((object) => object.key));
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
  const instanceId = `user-${user.id.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 27)}`;
  await c.env.TASKS.send({ type: 'delete-user-search', idempotencyKey: `delete-search:${user.id}`, payload: { instanceId } }, { contentType: 'json' });
  await c.env.DB.prepare('DELETE FROM user WHERE id=?').bind(user.id).run();
  return c.body(null, 204);
});

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId') } }, 404));
app.onError((error, c) => jsonError(c, error));

async function runAnalysis(env: Env, userId: string, question: string, evidence: Parameters<typeof citedAnswer>[2], mode: 'answer'|'comparison'|'report') {
  const operationId = crypto.randomUUID(); const reserved = mode === 'report' ? 40 : mode === 'comparison' ? 24 : 12;
  await reserveCredits(env, userId, operationId, reserved, { mode });
  try {
    const result = await citedAnswer(env, question, evidence, operationId, mode);
    await settleCredits(env, userId, operationId, reserved, Math.ceil(reserved * 0.8), 0);
    return { ...result, operationId };
  } catch (error) {
    await releaseCredits(env, userId, operationId, reserved);
    throw error;
  }
}

function requireUser(c: Context<App>): AppUser {
  const user = c.get('user');
  if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return user;
}
async function ownProject(env: Env, userId: string, projectId: string): Promise<void> {
  const project = await env.DB.prepare('SELECT 1 FROM projects WHERE id=? AND user_id=?').bind(projectId, userId).first();
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
}
async function enforcePublicRate(c: Context<App>): Promise<void> {
  const key = c.req.header('cf-connecting-ip') ?? 'unknown';
  const result = await c.env.PUBLIC_RATE_LIMITER.limit({ key });
  if (!result.success) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
}
async function enforcePublicEntry(c: Context<App>): Promise<void> {
  await enforcePublicRate(c);
  if (!c.env.TURNSTILE_SECRET || String(c.env.ENVIRONMENT) !== 'production') return;
  const token = c.req.header('cf-turnstile-response');
  if (!token) throw new ApiError(403, 'TURNSTILE_REQUIRED', 'Human verification is required.');
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: token }),
  });
  const result = await response.json<{ success: boolean }>();
  if (!result.success) throw new ApiError(403, 'TURNSTILE_FAILED', 'Human verification failed.');
}
function cleanTags(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0,50)).filter(Boolean).slice(0,20) : []; }
function finiteNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.round(number) : null; }
function entityType(value?: string): SearchFilters['type'] { return ['video','channel','playlist'].includes(value ?? '') ? value as SearchFilters['type'] : 'all'; }
function duration(value?: string): SearchFilters['duration'] { return ['short','medium','long'].includes(value ?? '') ? value as SearchFilters['duration'] : undefined; }
function sort(value?: string): SearchFilters['sort'] { return ['relevance','date','views','rating'].includes(value ?? '') ? value as SearchFilters['sort'] : undefined; }
function live(value?: string): SearchFilters['live'] { return ['live','upcoming','completed'].includes(value ?? '') ? value as SearchFilters['live'] : undefined; }

export default {
  fetch: app.fetch,
  queue: handleQueue,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') {
      const params: MonitorPayload = { scheduledAt: controller.scheduledTime };
      await env.MONITOR_WORKFLOW.create({ id: `monitor-${new Date(controller.scheduledTime).toISOString().slice(0,13)}`, params });
    } else if (controller.cron === '0 8 * * *') await queueDigests(env, 'daily');
    else if (controller.cron === '0 8 * * 1') await queueDigests(env, 'weekly');
  },
} satisfies ExportedHandler<Env>;
