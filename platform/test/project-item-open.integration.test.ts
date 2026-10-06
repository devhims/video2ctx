import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { jsonError, sha256 } from '../src/lib/http';
import { sessionRoutes } from '../src/routes/session/session.index';
import { issueCommentPageReceipt } from '../src/lib/comment-page-receipt';
import { videoCatalog } from '../src/lib/video-catalog';
import { videoResourceKey, saveVideoResource } from '../src/lib/video-resources';
import { referenceSource } from '../src/lib/source-history-storage';
import { createProjectExport } from '../src/lib/exports';
import { userAccountInstanceName } from '../src/agents/runtime/identity';
import type { App, AuthPrincipal } from '../src/types';
import type { SaveReferencedSource } from '../src/lib/source-history';
const env = { ...workerEnv, BETTER_AUTH_SECRET: 'test-comment-receipt-secret' } as Env;

const MISSING = 'This saved data is currently unavailable. Retry loading from storage at no cost.';
const json = { 'content-type': 'application/json' };

function sourceApp(userId: string, method: AuthPrincipal['method'] = 'session') {
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: userId, email: `${userId}@example.test`, name: userId };
    c.set('principal', { user, method, permissions: {} }); c.set('user', user); await next();
  });
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  return app;
}

/** Any provider, billing, import or indexing work on a read fails the test. */
function readOnlyEnv(base: Env = env): Env {
  const forbidden = (name: string) => new Proxy({}, { get: () => () => { throw new Error(`${name} used while opening a saved item`); } });
  return { ...base, YOUTUBE_REQUEST_COORDINATOR: forbidden('provider'), IMPORT_WORKFLOW: forbidden('import'),
    TASKS: forbidden('indexing'), BILLING: forbidden('billing') } as unknown as Env;
}

async function owner(prefix: string) {
  const userId = `${prefix}-${crypto.randomUUID()}`, projectId = crypto.randomUUID(), stamp = Date.now();
  await env.DB.prepare('INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, 'Owner', `${userId}@example.test`, stamp, stamp).run();
  await env.DB.prepare('INSERT INTO projects (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(projectId, userId, 'Research', '', stamp, stamp).run();
  const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
  return { userId, projectId, app: sourceApp(userId), account };
}

async function commentReceipt(userId: string, id: string, continuation: string) {
  const key = videoResourceKey({ kind: 'comments', id, continuation })!;
  const stored = await videoCatalog(env)!.readSourceSaved(key);
  return issueCommentPageReceipt(env, userId, key, stored?.catalogVersions ?? [{ ...key, contentHash: 'f'.repeat(64) }]);
}

function videoId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 11); }

function transcript(id: string, text: string) {
  return { videoId: id, text, segments: [{ text, startMs: 0, endMs: 1000, durationMs: 1000 }],
    track: { name: 'English', kind: 'asr', languageCode: 'en' }, meta: { source: 'youtube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } };
}

async function storeVideo(id: string, text = 'Original transcript', title = 'Stored video', at = Date.now()) {
  await saveVideoResource(env, { kind: 'video', id }, { id, title, thumbnails: [] }, at, 60_000);
  await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, transcript(id, text), at, 60_000);
}

const inspection = (id: string, loadedData = ['metadata', 'transcript']) => ({ input: `https://youtu.be/${id}`, snapshot: { kind: 'inspection', inspector: {
  provider: 'youtube', type: 'video', id, requestedData: ['transcript'], dataErrors: {}, loadedData,
} } });

async function remember(app: Hono<App>, id: string) {
  const response = await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify(inspection(id)) }, env);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ source: { id: string }; sourceRevision: string }>;
}

async function addItem(app: Hono<App>, projectId: string, body: Record<string, unknown>, base: Env = env) {
  const response = await app.request(`/projects/${projectId}/items`, { method: 'POST', headers: json, body: JSON.stringify({ provider: 'youtube', ...body }) }, base);
  return { status: response.status, ...(await response.json() as { id: string; existing?: boolean }) };
}

const tasksEnv = (sent: unknown[]) => ({ ...env, TASKS: { send: async (message: unknown) => { sent.push(message); } } }) as unknown as Env;

async function open(app: Hono<App>, projectId: string, itemId: string, base: Env = readOnlyEnv()) {
  const response = await app.request(`/projects/${projectId}/sources/items/${itemId}`, {}, base);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function pin(app: Hono<App>, projectId: string, itemId: string, body: unknown) {
  return app.request(`/projects/${projectId}/sources/items/${itemId}/snapshot`, { method: 'PUT', headers: json, body: JSON.stringify(body) }, env);
}

async function objectKey(contentHash: string) {
  return (await env.VIDEO_CATALOG.prepare('SELECT object_key FROM video_asset_versions WHERE content_hash=?').bind(contentHash).first<{ object_key: string }>())!.object_key;
}

describe('saved project items', () => {
  test('repeated whole-source saves reuse one row while every moment, including start 0, stays distinct', async () => {
    const { projectId, app } = await owner('item-identity');
    const sent: unknown[] = [];
    const id = videoId();
    const whole = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Video', content: '[0] Spoken' }, tasksEnv(sent));
    const retry = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Video', content: '[0] Spoken' }, tasksEnv(sent));
    const zero = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Start', startMs: 0 }, tasksEnv(sent));
    const zeroAgain = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Start', startMs: 0 }, tasksEnv(sent));
    const later = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Later', startMs: 1000, note: 'Key point', endMs: 2000, tags: ['kept'] }, tasksEnv(sent));
    // Repeating a moment returns it unchanged: its note, end and tags stay as saved.
    expect(await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Changed', startMs: 1000, note: 'Changed note' }, tasksEnv(sent))).toMatchObject({ id: later.id, existing: true });
    expect(await env.DB.prepare('SELECT title, note, end_ms, tags_json FROM project_items WHERE id=?').bind(later.id).first())
      .toEqual({ title: 'Later', note: 'Key point', end_ms: 2000, tags_json: '["kept"]' });
    const playlist = await addItem(app, projectId, { entityType: 'playlist', entityId: id, title: 'Same ID, other type' }, tasksEnv(sent));
    expect([whole.status, retry.status, zero.status, zeroAgain.status, later.status, playlist.status]).toEqual([201, 200, 201, 200, 201, 201]);
    expect(retry).toMatchObject({ id: whole.id, existing: true });
    expect(zeroAgain.id).toBe(zero.id);
    expect(new Set([whole.id, zero.id, later.id, playlist.id]).size).toBe(4);
    // Retried content deduplicates through the queue key; the original indexing payload is unchanged.
    expect(sent).toHaveLength(2);
    expect((sent[0] as { idempotencyKey: string }).idempotencyKey).toBe((sent[1] as { idempotencyKey: string }).idempotencyKey);
    expect(sent[0]).toMatchObject({ type: 'index-document', payload: { projectId, entityId: id, content: '[0] Spoken', startMs: null } });
    const detail = await (await app.request(`/projects/${projectId}`, {}, env)).json() as { items: Array<{ start_ms: number | null }> };
    expect(detail.items.map(item => item.start_ms).sort()).toEqual([0, 1000, null, null]);
  });

  test('an explicit Save pins the exact Recent version, which survives refreshes, Recent eviction and newer inspections', async () => {
    const { projectId, app, account } = await owner('item-pin');
    const id = videoId();
    await storeVideo(id, 'Original transcript');
    const recent = await remember(app, id);
    const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Stored video' });
    const pinned = await pin(app, projectId, item.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ itemId: item.id, sourceId: recent.source.id, sourceRevision: recent.sourceRevision });
    // A later inspection replaces Recent and the catalog's current version.
    await storeVideo(id, 'Refreshed transcript', 'Stored video', Date.now() + 1000);
    const refreshed = await remember(app, id);
    expect(refreshed.source.id).toBe(recent.source.id);
    expect(refreshed.sourceRevision).not.toBe(recent.sourceRevision);
    const snapshot: SaveReferencedSource['snapshot'] = { kind: 'search', selectedData: ['transcript'], results: `youtube/source-history/${'a'.repeat(64)}.json` };
    for (let i = 0; i < 31; i++) await account.saveSource({ input: `eviction ${i}`, title: `eviction ${i}`, snapshot });
    expect(await account.getSource(recent.source.id)).toBeNull();
    for (let attempt = 0; attempt < 2; attempt++) {
      const opened = await open(app, projectId, item.id);
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({ state: 'restored', origin: 'pin', recovered: false, sourceRevision: recent.sourceRevision,
        missingData: [], item: { id: item.id, entity_id: id }, snapshot: { inspector: { transcript: { text: 'Original transcript' } } } });
    }
    // Pins are a private sidecar: no extra visible row or count.
    expect(await (await app.request(`/projects/${projectId}`, {}, env)).json()).toMatchObject({ items: [{ id: item.id }] });
    expect(await (await app.request('/projects', {}, env)).json()).toMatchObject({ projects: [{ id: projectId, item_count: 1 }] });
  });

  test('pinning rejects stale revisions, missing Recent entries and mismatched identities, and accepts a stored descriptor', async () => {
    const { projectId, app, account } = await owner('item-pin-reject');
    const id = videoId(), other = videoId();
    await storeVideo(id); await storeVideo(other);
    const first = await remember(app, id);
    const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Stored video' });
    await storeVideo(id, 'Newer transcript', 'Stored video', Date.now() + 1000);
    await remember(app, id);
    const stale = await pin(app, projectId, item.id, { sourceId: first.source.id, sourceRevision: first.sourceRevision });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'SOURCE_REVISION_MISMATCH' } });
    expect(await account.getProjectItemPin(projectId, item.id)).toBeNull();
    const otherRecent = await remember(app, other);
    const mismatch = await pin(app, projectId, item.id, { sourceId: otherRecent.source.id, sourceRevision: otherRecent.sourceRevision });
    expect(await mismatch.json()).toMatchObject({ error: { code: 'SOURCE_IDENTITY_MISMATCH' } });
    expect((await pin(app, projectId, item.id, inspection(other))).status).toBe(409);
    expect((await pin(app, projectId, item.id, { sourceId: crypto.randomUUID(), sourceRevision: first.sourceRevision })).status).toBe(404);
    expect((await pin(app, projectId, item.id, { sourceId: first.source.id })).status).toBe(422);
    const descriptor = await pin(app, projectId, item.id, inspection(id));
    expect(descriptor.status).toBe(200);
    expect(await descriptor.json()).toMatchObject({ itemId: item.id, sourceId: null });
    expect((await open(app, projectId, item.id)).body).toMatchObject({ state: 'restored', origin: 'pin',
      snapshot: { inspector: { transcript: { text: 'Newer transcript' } } } });
  });

  test('a descriptor pin needs saved evidence, and the same item can be retried once its import establishes it', async () => {
    const { userId, projectId, app } = await owner('item-pin-retry');
    const id = videoId();
    await storeVideo(id);
    const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Pending video' });
    // Shared storage exists, but a fresh bookmark alone cannot pin it for free.
    const failed = await pin(app, projectId, item.id, inspection(id));
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: { code: 'SOURCE_EVIDENCE_PENDING' } });
    await env.DB.prepare(`INSERT INTO jobs (id, user_id, kind, input_json, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'video', ?, 'succeeded', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, JSON.stringify({ provider: 'youtube', kind: 'video', entityId: id, projectId }), `import:${id}`, Date.now(), Date.now()).run();
    expect((await pin(app, projectId, item.id, inspection(id))).status).toBe(200);
    expect((await open(app, projectId, item.id)).body).toMatchObject({ state: 'restored', origin: 'pin', item: { id: item.id } });
  });

  test('opening and pinning enforce browser sessions, project ownership and the item’s own project', async () => {
    const first = await owner('item-auth'), second = await owner('item-auth-other');
    const id = videoId();
    await storeVideo(id);
    const item = await addItem(first.app, first.projectId, { entityType: 'video', entityId: id, title: 'Owned' });
    const path = `/projects/${first.projectId}/sources/items/${item.id}`;
    for (const method of ['api-key', 'cli-session'] as const) {
      expect((await sourceApp(first.userId, method).request(path, {}, env)).status).toBe(403);
      expect((await sourceApp(first.userId, method).request(`${path}/snapshot`, { method: 'PUT', headers: json, body: JSON.stringify(inspection(id)) }, env)).status).toBe(403);
    }
    expect((await second.app.request(path, {}, env)).status).toBe(404);
    expect((await pin(second.app, first.projectId, item.id, inspection(id))).status).toBe(404);
    // A valid item ID under another owned project is not found there.
    expect((await open(first.app, second.projectId, item.id)).status).toBe(404);
    const otherProject = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO projects (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(otherProject, first.userId, 'Other', '', Date.now(), Date.now()).run();
    expect((await open(first.app, otherProject, item.id)).status).toBe(404);
    expect((await pin(first.app, otherProject, item.id, inspection(id))).status).toBe(404);
    expect((await open(first.app, first.projectId, 'not-a-uuid')).status).toBe(422);
  });

  test('opening is free and write-free: no provider, billing, import, indexing, Recent or catalog bookkeeping', async () => {
    const { userId, projectId, app, account } = await owner('item-read-only');
    const id = videoId();
    await storeVideo(id);
    const recent = await remember(app, id);
    const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Stored video' });
    await pin(app, projectId, item.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision });
    const legacy = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Moment', startMs: 5000 });
    await env.DB.prepare(`INSERT INTO credit_ledger (id, user_id, operation_id, entry_type, credits, created_at) VALUES (?, ?, ?, 'grant', 100, ?)`)
      .bind(crypto.randomUUID(), userId, crypto.randomUUID(), Date.now()).run();
    const before = {
      recent: await account.listSources(),
      requested: await env.VIDEO_CATALOG.prepare('SELECT last_requested_at FROM videos WHERE video_id=?').bind(id).first(),
      jobs: await env.DB.prepare('SELECT COUNT(*) AS count FROM jobs WHERE user_id=?').bind(userId).first(),
      items: await env.DB.prepare('SELECT COUNT(*) AS count FROM project_items WHERE project_id=?').bind(projectId).first(),
      ledger: await env.DB.prepare('SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id=?').bind(userId).first(),
      accounts: await env.DB.prepare('SELECT * FROM credit_accounts WHERE user_id=?').bind(userId).all(),
    };
    const pinned = await app.request(`/projects/${projectId}/sources/items/${item.id}`, {}, readOnlyEnv());
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('X-Credits-Charged')).toBeNull();
    expect(await (await app.request(`/projects/${projectId}/sources/items/${legacy.id}`, {}, readOnlyEnv())).json()).toMatchObject({ state: 'restored', origin: 'pin', recovered: true, item: { start_ms: 5000 } });
    expect(await account.listSources()).toEqual(before.recent);
    expect(await env.VIDEO_CATALOG.prepare('SELECT last_requested_at FROM videos WHERE video_id=?').bind(id).first()).toEqual(before.requested);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM jobs WHERE user_id=?').bind(userId).first()).toEqual(before.jobs);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM project_items WHERE project_id=?').bind(projectId).first()).toEqual(before.items);
    // Credits are reserved and settled through these D1 tables; opening never touches them.
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id=?').bind(userId).first()).toEqual(before.ledger);
    expect(await env.DB.prepare('SELECT * FROM credit_accounts WHERE user_id=?').bind(userId).all()).toMatchObject({ results: before.accounts.results });
    expect(Number((before.accounts.results[0] as { available_credits: number }).available_credits)).toBeGreaterThanOrEqual(100);
    await runInDurableObject(account, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM project_item_snapshots').one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM project_sources').one().count).toBe(0);
    });
  });

  test('older items need saved evidence: none is unavailable; an import, document or Recent reference restores storage', async () => {
    const { userId, projectId, app } = await owner('item-evidence');
    const bookmark = videoId(), imported = videoId(), documented = videoId(), recentOnly = videoId();
    for (const id of [bookmark, imported, recentOnly]) await storeVideo(id, `Transcript for ${id}`);
    const insertLegacy = async (id: string, type = 'video') => {
      const itemId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO project_items (id, project_id, user_id, provider, entity_type, entity_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(itemId, projectId, userId, 'youtube', type, id, `Legacy ${id}`, Date.now()).run();
      return itemId;
    };
    // Shared storage exists, but a bookmark alone is not entitlement.
    const bookmarkItem = await insertLegacy(bookmark);
    expect((await open(app, projectId, bookmarkItem)).body).toEqual({ state: 'unavailable', input: `https://www.youtube.com/watch?v=${bookmark}`,
      item: expect.objectContaining({ id: bookmarkItem }) });
    const importedItem = await insertLegacy(imported);
    await env.DB.prepare(`INSERT INTO jobs (id, user_id, kind, input_json, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'video', ?, 'succeeded', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, JSON.stringify({ provider: 'youtube', kind: 'video', entityId: imported, projectId }), `import:${imported}`, Date.now(), Date.now()).run();
    expect((await open(app, projectId, importedItem)).body).toMatchObject({ state: 'restored', origin: 'storage', recovered: true, missingData: [],
      snapshot: { inspector: { data: { title: 'Stored video' }, transcript: { text: `Transcript for ${imported}` } } } });
    // A failed import is not evidence.
    const failedId = videoId(); await storeVideo(failedId);
    const failedItem = await insertLegacy(failedId);
    await env.DB.prepare(`INSERT INTO jobs (id, user_id, kind, input_json, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'video', ?, 'failed', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, JSON.stringify({ provider: 'youtube', kind: 'video', entityId: failedId, projectId }), `import:${failedId}`, Date.now(), Date.now()).run();
    expect((await open(app, projectId, failedItem)).body.state).toBe('unavailable');
    // Owned private Markdown is shown as saved text, without inventing a track or timing.
    const documentedItem = await insertLegacy(documented);
    const documentId = await sha256(`${userId}:${projectId}:youtube:${documented}:0`);
    const key = `private/${userId}/projects/${projectId}/youtube/${documentId}.md`;
    await env.RESEARCH.put(key, `# Legacy ${documented}\n\n[0] Saved line\n[1500] Second line`);
    await env.DB.prepare(`INSERT INTO documents (id, owner_scope, user_id, project_id, provider, entity_type, entity_id, title, r2_key, created_at) VALUES (?, 'private', ?, ?, 'youtube', 'transcript', ?, ?, ?, ?)`)
      .bind(documentId, userId, projectId, documented, `Legacy ${documented}`, key, Date.now()).run();
    const text = await open(app, projectId, documentedItem);
    expect(text.body).toMatchObject({ state: 'restored', origin: 'storage', savedText: '[0] Saved line\n[1500] Second line', missingData: ['metadata'],
      snapshot: { inspector: { data: { id: documented, title: `Legacy ${documented}` }, dataErrors: { metadata: MISSING } } } });
    expect(text.body.snapshot.inspector).not.toHaveProperty('transcript');
    // The user's own Recent reference is evidence and restores its exact version.
    const recent = await remember(app, recentOnly);
    const recentItem = await insertLegacy(recentOnly);
    expect((await open(app, projectId, recentItem)).body).toMatchObject({ state: 'restored', origin: 'recent', recovered: true,
      source: { id: recent.source.id }, sourceRevision: recent.sourceRevision });
    // Playlists recover from retained responses only with an import.
    const playlistItem = await insertLegacy('PLlegacyimport', 'playlist');
    const cacheKey = `youtube:v1:${await sha256(JSON.stringify(['playlist-v2', 'PLlegacyimport']))}`;
    await env.YOUTUBE_CACHE.put(cacheKey, JSON.stringify({ version: 1, fetchedAt: Date.now(), freshUntil: Date.now() + 60_000, value: { id: 'PLlegacyimport', title: 'Imported playlist', videos: [] } }));
    expect((await open(app, projectId, playlistItem)).body.state).toBe('unavailable');
    await env.DB.prepare(`INSERT INTO jobs (id, user_id, kind, input_json, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'playlist', ?, 'partial', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, JSON.stringify({ provider: 'youtube', kind: 'playlist', entityId: 'PLlegacyimport', projectId }), 'import:PLlegacyimport', Date.now(), Date.now()).run();
    expect((await open(app, projectId, playlistItem)).body).toMatchObject({ state: 'restored', origin: 'storage', snapshot: { inspector: { type: 'playlist', data: { title: 'Imported playlist' } } } });
  });

  test('missing bytes keep partial data free, while corruption and store failures stay errors', async () => {
    const { projectId, app, account } = await owner('item-storage');
    const id = videoId();
    await storeVideo(id, 'Kept transcript');
    const recent = await remember(app, id);
    const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Partial video' });
    expect((await pin(app, projectId, item.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision })).status).toBe(200);
    const restored = (await open(app, projectId, item.id)).body;
    expect(restored).toMatchObject({ state: 'restored', missingData: [] });
    const reference = (await account.getProjectItemPin(projectId, item.id))!.snapshot as Extract<SaveReferencedSource['snapshot'], { kind: 'inspection' }>;
    const metadataKey = await objectKey(reference.inspector.assets.metadata!.contentHash), transcriptKey = await objectKey(reference.inspector.assets.transcript!.contentHash);
    const metadataBytes = await (await env.VIDEO_ASSETS.get(metadataKey))!.text();
    // A transient store failure is an error, not evidence that data is absent.
    const failing = { ...readOnlyEnv(), VIDEO_ASSETS: { get: async () => { throw new Error('R2 unavailable'); } } } as unknown as Env;
    const outage = await open(app, projectId, item.id, failing);
    expect(outage.status).toBeGreaterThanOrEqual(500);
    expect(outage.body.state).toBeUndefined();
    // Missing metadata keeps the transcript visible for free.
    await env.VIDEO_ASSETS.delete(metadataKey);
    expect((await open(app, projectId, item.id)).body).toMatchObject({ state: 'restored', origin: 'pin', missingData: ['metadata'],
      snapshot: { inspector: { data: { id, title: 'Partial video' }, transcript: { text: 'Kept transcript' }, dataErrors: { metadata: MISSING } } } });
    // Corrupt bytes are reported as an integrity error.
    await env.VIDEO_ASSETS.put(metadataKey, metadataBytes.replace('Stored video', 'Tampered video'));
    const corrupt = await open(app, projectId, item.id);
    expect(corrupt.status).toBe(500);
    expect(corrupt.body).toMatchObject({ error: { code: 'SOURCE_ASSET_INVALID' } });
    await env.VIDEO_ASSETS.put(metadataKey, metadataBytes);
    // With every retained byte gone and no other evidence, the item is unavailable, not an error.
    await env.VIDEO_ASSETS.delete(metadataKey); await env.VIDEO_ASSETS.delete(transcriptKey);
    const gone = await open(app, projectId, item.id);
    expect(gone).toMatchObject({ status: 200, body: { state: 'unavailable', item: { id: item.id } } });
  });

  test('existing project sources open through the same endpoint, and project or account deletion removes pins', async () => {
    const { projectId, app, account } = await owner('item-sources');
    const id = videoId();
    await storeVideo(id);
    const linked = await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify({ ...inspection(id), projectId }) }, env);
    const { linked: link } = await linked.json() as { linked: { item: { id: string } } };
    expect((await open(app, projectId, link.item.id)).body).toMatchObject({ state: 'restored', origin: 'project-source', recovered: false,
      item: { id: link.item.id, source_id: expect.any(String) }, snapshot: { inspector: { transcript: { text: 'Original transcript' } } } });
    const recent = await remember(app, id);
    // F10: a standalone Save of the same whole source reuses that visible row instead of adding a D1 duplicate.
    const sent: unknown[] = [];
    const reused = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Pinned', content: '[0] Original transcript' }, tasksEnv(sent));
    expect(reused).toMatchObject({ status: 200, id: link.item.id, existing: true });
    expect(sent).toMatchObject([{ type: 'index-document', payload: { projectId, entityId: id, content: '[0] Original transcript' } }]);
    await storeVideo(id, 'Saved again', 'Stored video', Date.now() + 1000);
    const again = await remember(app, id);
    expect((await pin(app, projectId, link.item.id, { sourceId: again.source.id, sourceRevision: again.sourceRevision })).status).toBe(200);
    expect((await open(app, projectId, link.item.id)).body).toMatchObject({ state: 'restored', origin: 'project-source', item: { id: link.item.id },
      snapshot: { inspector: { transcript: { text: 'Saved again' } } } });
    expect((await pin(app, projectId, link.item.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision })).status).toBe(409);
    const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Pinned moment', startMs: 30_000 });
    expect(item.status).toBe(201);
    await pin(app, projectId, item.id, { sourceId: again.source.id, sourceRevision: again.sourceRevision });
    expect(await account.getProjectItemPin(projectId, item.id)).not.toBeNull();
    // Project items, moments and sources remain in exports alongside pins, without a duplicate whole source.
    await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Moment', startMs: 0, endMs: 900, note: 'Opening' });
    const exported = await createProjectExport(env, (await env.DB.prepare('SELECT user_id FROM projects WHERE id=?').bind(projectId).first<{ user_id: string }>())!.user_id, projectId, 'json');
    const content = await (await env.RESEARCH.get(exported.key))!.json() as { items: Array<{ title: string; start_ms: number | null }> };
    expect(content.items.map(entry => [entry.title, entry.start_ms]).sort()).toEqual([['Moment', 0], ['Pinned moment', 30_000], ['Stored video', null]]);
    await account.removeProjectSources(projectId);
    expect(await account.getProjectItemPin(projectId, item.id)).toBeNull();
    await pin(app, projectId, item.id, { sourceId: again.source.id, sourceRevision: again.sourceRevision });
    await account.beginDeletion(); await account.finishDeletion();
    await runInDurableObject(account, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM project_item_snapshots').one().count).toBe(0);
    });
  });
});

describe('saved project item recovery boundaries', () => {
  async function legacyItem(userId: string, projectId: string, id: string, type = 'video') {
    const itemId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO project_items (id, project_id, user_id, provider, entity_type, entity_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(itemId, projectId, userId, 'youtube', type, id, `Legacy ${id}`, Date.now()).run();
    return itemId;
  }
  async function imported(userId: string, projectId: string, id: string, kind = 'video') {
    await env.DB.prepare(`INSERT INTO jobs (id, user_id, kind, input_json, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, kind, JSON.stringify({ provider: 'youtube', kind, entityId: id, projectId }), `import:${kind}:${id}`, Date.now(), Date.now()).run();
  }

  test('with import evidence, the import workflow’s transcript copy restores when the catalog has none', async () => {
    const { userId, projectId, app } = await owner('item-import-copy');
    const id = videoId();
    const itemId = await legacyItem(userId, projectId, id);
    await env.RESEARCH.put(`public/youtube/videos/${id}/transcript-en.json`, JSON.stringify(transcript(id, 'Imported transcript')));
    // The raw copy alone, without owned evidence, is not used.
    expect((await open(app, projectId, itemId)).body.state).toBe('unavailable');
    await imported(userId, projectId, id);
    expect((await open(app, projectId, itemId)).body).toMatchObject({ state: 'restored', origin: 'storage', missingData: ['metadata'],
      snapshot: { inspector: { transcript: { text: 'Imported transcript', track: { languageCode: 'en' } } } } });
    // A copy for another video is corrupt data, not a usable transcript.
    await env.RESEARCH.put(`public/youtube/videos/${id}/transcript-en.json`, JSON.stringify(transcript(videoId(), 'Wrong video')));
    expect((await open(app, projectId, itemId)).body).toMatchObject({ error: { code: 'SOURCE_ASSET_INVALID' } });
  });

  test('private document keys outside the user’s project namespace are never read', async () => {
    const first = await owner('item-document-key'), other = await owner('item-document-other');
    const id = videoId();
    const itemId = await legacyItem(first.userId, first.projectId, id);
    const documentId = await sha256(`${first.userId}:${first.projectId}:youtube:${id}:0`);
    const foreignKey = `private/${other.userId}/projects/${other.projectId}/youtube/${documentId}.md`;
    await env.RESEARCH.put(foreignKey, '# Other\n\n[0] Another user’s private text');
    await env.DB.prepare(`INSERT INTO documents (id, owner_scope, user_id, project_id, provider, entity_type, entity_id, title, r2_key, created_at) VALUES (?, 'private', ?, ?, 'youtube', 'transcript', ?, 'Tampered', ?, ?)`)
      .bind(documentId, first.userId, first.projectId, id, foreignKey, Date.now()).run();
    const opened = await open(first.app, first.projectId, itemId);
    expect(opened.body.state).toBe('unavailable');
    expect(JSON.stringify(opened.body)).not.toContain('Another user');
    // A row for another entity in the same project does not count either.
    const otherItem = await legacyItem(first.userId, first.projectId, videoId());
    expect((await open(first.app, first.projectId, otherItem)).body.state).toBe('unavailable');
  });

  test('a project source whose bytes are gone recovers from other owned storage; a lost saved search waits without a query', async () => {
    const { projectId, app } = await owner('item-source-fallback');
    const id = videoId();
    await storeVideo(id, 'Recovered for source row');
    const saved = await (await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify({ ...inspection(id), projectId }) }, env)).json() as { linked: { item: { id: string } } };
    const reference = (await env.USER_ACCOUNT.getByName(await userAccountInstanceName((await env.DB.prepare('SELECT user_id FROM projects WHERE id=?').bind(projectId).first<{ user_id: string }>())!.user_id)).getProjectSource(projectId, saved.linked.item.id))!;
    if (reference.snapshot.kind !== 'inspection') throw new Error('expected an inspection');
    for (const asset of Object.values(reference.snapshot.inspector.assets)) await env.VIDEO_ASSETS.delete(await objectKey(asset!.contentHash));
    // A newer catalog version exists; the owned row permits a storage restore.
    await storeVideo(id, 'Newer stored transcript', 'Newer stored video', Date.now() + 5000);
    expect((await open(app, projectId, saved.linked.item.id)).body).toMatchObject({ state: 'restored', recovered: true, item: { id: saved.linked.item.id },
      snapshot: { inspector: { transcript: { text: 'Newer stored transcript' } } } });
    // A saved search whose results are gone is unavailable with its query, never re-run automatically.
    const results = `youtube/source-history/${'f'.repeat(64)}.json`;
    const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName((await env.DB.prepare('SELECT user_id FROM projects WHERE id=?').bind(projectId).first<{ user_id: string }>())!.user_id));
    const search = await account.saveSourceWithProject({ input: 'lost search', title: 'lost search', snapshot: { kind: 'search', selectedData: ['transcript'], results } }, projectId);
    expect((await open(app, projectId, search.linked!.item.id))).toMatchObject({ status: 200, body: { state: 'unavailable', input: 'lost search', item: { entity_type: 'search' } } });
  });

  test('an owned reference whose old bytes are gone still permits recovery of the newest stored version, labeled as such', async () => {
    const { userId, projectId, app, account } = await owner('item-reference-evidence');
    const id = videoId();
    await storeVideo(id, 'Original saved transcript', 'Original title');
    const recent = await remember(app, id);
    const stored = (await account.ownedSourceReferences(projectId, `youtube:video:${id}`))[0]!.snapshot;
    if (stored.kind !== 'inspection') throw new Error('expected an inspection');
    for (const asset of Object.values(stored.inspector.assets)) await env.VIDEO_ASSETS.delete(await objectKey(asset!.contentHash));
    await storeVideo(id, 'Newer stored transcript', 'Newer title', Date.now() + 5000);
    // No project document or import exists: only the owned Recent reference.
    const itemId = await legacyItem(userId, projectId, id);
    const opened = await open(app, projectId, itemId);
    expect(opened.body).toMatchObject({ state: 'restored', origin: 'storage', recovered: true, evidence: 'saved-reference', missingData: [],
      snapshot: { inspector: { data: { title: 'Newer title' }, transcript: { text: 'Newer stored transcript' } } } });
    // It is not presented as the original immutable reference.
    expect(opened.body.sourceRevision).toBeUndefined();
    expect(opened.body.source.id).toBe(itemId);
    expect(recent.source.id).not.toBe(itemId);
  });

  test('with import evidence, a retention-expired stored playlist still opens for free', async () => {
    const { userId, projectId, app } = await owner('item-expired');
    const id = 'PLexpired' + crypto.randomUUID().slice(0, 8);
    const itemId = await legacyItem(userId, projectId, id, 'playlist');
    const cacheKey = `youtube:v1:${await sha256(JSON.stringify(['playlist-v2', id]))}`;
    await env.VIDEO_ASSETS.put(`youtube/source-responses/v1/${await sha256(cacheKey)}.json`, JSON.stringify({ version: 1, resourceType: 'playlist-v2',
      value: { id, title: 'Expired retention', videos: [] }, fetchedAt: Date.now() - 10_000, retainedUntil: Date.now() - 1 }));
    expect((await open(app, projectId, itemId)).body.state).toBe('unavailable');
    await imported(userId, projectId, id, 'playlist');
    expect((await open(app, projectId, itemId)).body).toMatchObject({ state: 'restored', snapshot: { inspector: { data: { title: 'Expired retention' } } } });
  });
});

describe('saved project item revisions and reuse of existing rows', () => {
  async function legacyItem(userId: string, projectId: string, id: string, startMs: number | null = null) {
    const itemId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO project_items (id, project_id, user_id, provider, entity_type, entity_id, title, start_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(itemId, projectId, userId, 'youtube', 'video', id, `Legacy ${id}`, startMs, Date.now()).run();
    return itemId;
  }
  const projectRows = async (app: Hono<App>, projectId: string) => (await (await app.request(`/projects/${projectId}`, {}, env)).json() as { items: Array<{ id: string; source_id?: string; start_ms: number | null }> }).items;

  test('a cached thumbnail does not stale a receipt, while a changed asset still does', async () => {
    const { userId, projectId, app, account } = await owner('item-thumbnail');
    const id = videoId();
    const thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    await saveVideoResource(env, { kind: 'video', id }, { id, title: 'Thumbnail video', thumbnails: [{ url: thumbnail, width: 480, height: 360 }] }, Date.now(), 60_000);
    await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, transcript(id, 'Kept transcript'), Date.now(), 60_000);
    const referenced = await referenceSource(env, { input: `https://youtu.be/${id}`, snapshot: inspection(id).snapshot as never });
    const older = structuredClone(referenced);
    if (older.snapshot.kind === 'inspection') delete older.snapshot.inspector.thumbnailUrl;
    // An older Recent entry without a thumbnail, as written before thumbnails were stored.
    const source = await account.saveSource(older);
    const receipt = { sourceId: source.id, sourceRevision: (await (await app.request(`/sources/recent/${source.id}`, {}, env)).json() as { sourceRevision: string }).sourceRevision };
    // Listing Recent lazily caches the thumbnail into the stored snapshot.
    await app.request('/sources/recent', {}, env);
    await runInDurableObject(account, (_instance, state) => {
      expect(state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM recent_sources WHERE id = ?', source.id).one().snapshot).toContain(thumbnail);
    });
    const item = await legacyItem(userId, projectId, id);
    const pinned = await pin(app, projectId, item, receipt);
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ sourceRevision: receipt.sourceRevision });
    const kept = (await account.getProjectItemPin(projectId, item))!.snapshot;
    if (kept.kind !== 'inspection' || older.snapshot.kind !== 'inspection') throw new Error('expected inspections');
    expect(kept.inspector.assets).toEqual(older.snapshot.inspector.assets);
    // A genuinely newer asset version under the same Recent ID is still a stale receipt.
    await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, transcript(id, 'Changed transcript'), Date.now() + 1000, 60_000);
    await remember(app, id);
    const stale = await pin(app, projectId, item, receipt);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'SOURCE_REVISION_MISMATCH' } });
  });

  test('Add sources auto-save into a project that already has the whole source as a D1 item retains it there without a new row', async () => {
    const { userId, projectId, app, account } = await owner('item-reverse-save');
    const id = videoId();
    await storeVideo(id, 'Auto-saved transcript');
    const whole = await legacyItem(userId, projectId, id);
    const moment = await legacyItem(userId, projectId, id, 0);
    const response = await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify({ ...inspection(id), projectId }) }, env);
    expect(response.status).toBe(201);
    const saved = await response.json() as { source: { id: string }; linked: { item: { id: string }; added: boolean }; sourceRevision: string };
    expect(saved.linked).toMatchObject({ added: false, item: { id: whole } });
    // Recent still records the inspection; the project keeps exactly its two rows and IDs.
    expect((await account.listSources())[0]?.id).toBe(saved.source.id);
    expect((await projectRows(app, projectId)).map(row => row.id).sort()).toEqual([whole, moment].sort());
    expect(await account.projectSourceCounts()).toEqual([]);
    expect((await open(app, projectId, whole)).body).toMatchObject({ state: 'restored', origin: 'pin', recovered: false, sourceRevision: saved.sourceRevision,
      snapshot: { inspector: { transcript: { text: 'Auto-saved transcript' } } } });
    // A moment alone is not the whole source, so a separate project source row is still added.
    const other = videoId(); await storeVideo(other);
    await legacyItem(userId, projectId, other, 0);
    const otherSaved = await (await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify({ ...inspection(other), projectId }) }, env)).json() as { linked: { added: boolean } };
    expect(otherSaved.linked.added).toBe(true);
    // A failed sidecar write rolls back the Recent write too.
    const before = await account.listSources();
    await runInDurableObject(account, (_instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER fail_pin BEFORE INSERT ON project_item_snapshots BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      state.storage.sql.exec('DELETE FROM project_item_snapshots');
    });
    const failed = await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify({ input: 'https://youtube.com/watch?v=' + id, snapshot: inspection(id).snapshot, projectId }) }, env);
    expect(failed.status).toBe(500);
    await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DROP TRIGGER fail_pin'); });
    expect(await account.listSources()).toEqual(before);
  });

  test('linking a Recent source into a project with the D1 whole source retains it with that item, including after Recent eviction', async () => {
    const { userId, projectId, app, account } = await owner('item-reverse-link');
    const id = videoId();
    await storeVideo(id, 'Linked transcript');
    const recent = await remember(app, id);
    const whole = await legacyItem(userId, projectId, id);
    const link = () => app.request(`/projects/${projectId}/sources`, { method: 'POST', headers: json, body: JSON.stringify({ sourceId: recent.source.id }) }, env);
    const first = await link();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ added: false, item: { id: whole } });
    expect(await account.projectSourceCounts()).toEqual([]);
    expect((await open(app, projectId, whole)).body).toMatchObject({ state: 'restored', origin: 'pin', sourceRevision: recent.sourceRevision });
    const snapshot: SaveReferencedSource['snapshot'] = { kind: 'search', selectedData: ['transcript'], results: `youtube/source-history/${'a'.repeat(64)}.json` };
    for (let i = 0; i < 31; i++) await account.saveSource({ input: `eviction ${i}`, title: `eviction ${i}`, snapshot });
    expect(await account.getSource(recent.source.id)).toBeNull();
    const again = await link();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ added: false, item: { id: whole } });
    expect((await projectRows(app, projectId)).map(row => row.id)).toEqual([whole]);
  });

  test('after Recent eviction, relinking returns the whole-source item even when a newer moment pin shares the Recent ID', async () => {
    const { userId, projectId, app, account } = await owner('item-reverse-moment');
    const id = videoId();
    await storeVideo(id, 'Shared transcript');
    const recent = await remember(app, id);
    const whole = await legacyItem(userId, projectId, id);
    const moment = await legacyItem(userId, projectId, id, 0);
    const link = () => app.request(`/projects/${projectId}/sources`, { method: 'POST', headers: json, body: JSON.stringify({ sourceId: recent.source.id }) }, env);
    expect(await (await link()).json()).toMatchObject({ item: { id: whole } });
    await new Promise(resolve => setTimeout(resolve, 5));
    // The moment is pinned later from the same Recent entry, so its sidecar is the newest for that source ID.
    expect((await pin(app, projectId, moment, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision })).status).toBe(200);
    await runInDurableObject(account, (_instance, state) => {
      expect(state.storage.sql.exec<{ item_id: string }>('SELECT item_id FROM project_item_snapshots WHERE source_id = ? ORDER BY created_at DESC LIMIT 1', recent.source.id).one().item_id).toBe(moment);
    });
    const snapshot: SaveReferencedSource['snapshot'] = { kind: 'search', selectedData: ['transcript'], results: `youtube/source-history/${'a'.repeat(64)}.json` };
    for (let i = 0; i < 31; i++) await account.saveSource({ input: `eviction ${i}`, title: `eviction ${i}`, snapshot });
    expect(await account.getSource(recent.source.id)).toBeNull();
    const before = (await projectRows(app, projectId)).map(row => [row.id, row.start_ms]).sort();
    const again = await link();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ added: false, item: { id: whole, start_ms: null } });
    expect((await projectRows(app, projectId)).map(row => [row.id, row.start_ms]).sort()).toEqual(before);
    expect(before).toHaveLength(2);
    expect(await account.projectSourceCounts()).toEqual([]);
  });
});

test('saving a recovered owned pin retains the displayed version', async () => {
  const { projectId, app, account } = await owner('review-recovered-version');
  const id = videoId();
  await storeVideo(id, 'Displayed original transcript');
  const recent = await remember(app, id);
  const moment = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Moment', startMs: 1000 });
  expect((await pin(app, projectId, moment.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision })).status).toBe(200);
  await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DELETE FROM recent_sources'); });
  const whole = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Whole video' });
  await storeVideo(id, 'Newer undisplayed transcript', 'Stored video', Date.now() + 1000);
  const before = await open(app, projectId, whole.id);
  expect(before.body).toMatchObject({ state: 'restored', origin: 'pin', recovered: true,
    snapshot: { inspector: { transcript: { text: 'Displayed original transcript' } } } });
  // SourcesClient sends the recovered revision, even after Recent eviction and a shared refresh.
  expect((await pin(app, projectId, whole.id, { savedRevision: before.body.sourceRevision })).status).toBe(200);
  const after = await open(app, projectId, whole.id);
  expect(after.body.snapshot.inspector.transcript.text).toBe(before.body.snapshot.inspector.transcript.text);
});

test('saving preserves a recovered private text transcript on the next open', async () => {
  const { userId, projectId, app } = await owner('review-saved-text');
  const id = videoId();
  await saveVideoResource(env, { kind: 'video', id }, { id, title: 'Text-only video', thumbnails: [] }, Date.now(), 60_000);
  const item = await addItem(app, projectId, { entityType: 'video', entityId: id, title: 'Text-only video' });
  const documentId = await sha256(`${userId}:${projectId}:youtube:${id}:0`);
  const key = `private/${userId}/projects/${projectId}/youtube/${documentId}.md`;
  await env.RESEARCH.put(key, '# Text-only video\n\n[0] The only saved transcript');
  await env.DB.prepare(`INSERT INTO documents (id, owner_scope, user_id, project_id, provider, entity_type, entity_id, title, r2_key, created_at) VALUES (?, 'private', ?, ?, 'youtube', 'transcript', ?, ?, ?, ?)`)
    .bind(documentId, userId, projectId, id, 'Text-only video', key, Date.now()).run();
  const before = await open(app, projectId, item.id);
  expect(before.body).toMatchObject({ state: 'restored', origin: 'storage', savedText: '[0] The only saved transcript', missingData: [] });
  // This is the descriptor sourceRequest() emits when the inspector has savedText but no transcript.
  expect((await pin(app, projectId, item.id, inspection(id, ['metadata']))).status).toBe(200);
  const after = await open(app, projectId, item.id);
  expect(after.body.savedText).toBe(before.body.savedText);
});


test('saved revisions must still belong to the account, project and source being saved', async () => {
  const { userId, projectId, app, account } = await owner('saved-revision-boundary');
  const id = videoId();
  await storeVideo(id, 'Owned original');
  const recent = await remember(app, id);
  const item = await addItem(app, projectId, { entityType: 'video', entityId: id });
  await pin(app, projectId, item.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision });
  await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DELETE FROM recent_sources'); });
  const receipt = { savedRevision: recent.sourceRevision };
  const otherSource = await addItem(app, projectId, { entityType: 'video', entityId: videoId() });
  expect((await pin(app, projectId, otherSource.id, receipt)).status).toBe(409);
  const otherProject = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO projects (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(otherProject, userId, 'Other project', '', Date.now(), Date.now()).run();
  const otherItem = await addItem(app, otherProject, { entityType: 'video', entityId: id });
  expect((await pin(app, otherProject, otherItem.id, receipt)).status).toBe(409);
  const foreign = await owner('foreign-saved-revision');
  const foreignItem = await addItem(foreign.app, foreign.projectId, { entityType: 'video', entityId: id });
  expect((await pin(foreign.app, foreign.projectId, foreignItem.id, receipt)).status).toBe(409);
  // A formerly owned revision cannot resolve against newer shared data after its last reference is removed.
  await storeVideo(id, 'Newer shared data', 'Stored video', Date.now() + 1000);
  await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DELETE FROM project_item_snapshots'); });
  const rejected = await pin(app, projectId, item.id, receipt);
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: { code: 'SOURCE_REVISION_MISMATCH' } });
  expect(await account.getProjectItemPin(projectId, item.id)).toBeNull();
});

test('a recovered project source saves the selected revision into its existing row', async () => {
  const { projectId, app, account } = await owner('recovered-project-source');
  const id = videoId();
  await storeVideo(id, 'Lost original', 'Lost title');
  const original = await referenceSource(env, inspection(id) as Parameters<typeof referenceSource>[1]);
  const linked = await account.saveSourceWithProject(original, projectId);
  const originalReference = original.snapshot as Extract<SaveReferencedSource['snapshot'], { kind: 'inspection' }>;
  await env.VIDEO_ASSETS.delete(await objectKey(originalReference.inspector.assets.metadata!.contentHash));
  await env.VIDEO_ASSETS.delete(await objectKey(originalReference.inspector.assets.transcript!.contentHash));
  await storeVideo(id, 'Recovered displayed transcript', 'Recovered title', Date.now() + 1000);
  const recent = await remember(app, id);
  const moment = await addItem(app, projectId, { entityType: 'video', entityId: id, startMs: 1000 });
  await pin(app, projectId, moment.id, { sourceId: recent.source.id, sourceRevision: recent.sourceRevision });
  await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DELETE FROM recent_sources'); });
  await storeVideo(id, 'Undisplayed newest transcript', 'Newest title', Date.now() + 2000);
  const before = await open(app, projectId, linked.linked!.item.id);
  expect(before.body).toMatchObject({ origin: 'pin', recovered: true,
    snapshot: { inspector: { transcript: { text: 'Recovered displayed transcript' } } } });
  expect((await pin(app, projectId, linked.linked!.item.id, { savedRevision: before.body.sourceRevision })).status).toBe(200);
  const after = await open(app, projectId, linked.linked!.item.id);
  expect(after.body).toMatchObject({ origin: 'project-source', recovered: false,
    sourceRevision: before.body.sourceRevision, snapshot: { inspector: { transcript: { text: 'Recovered displayed transcript' } } } });
  expect(await account.projectSourceCounts()).toEqual([{ projectId, count: 1 }]);
});


test('comment pages stay pinned through refresh, retries and Recent eviction', async () => {
  const { userId, projectId, app, account } = await owner('retained-comment-pages');
  const id = videoId();
  await storeVideo(id);
  const page = (ids: string[], continuation?: string) => ({ videoId: id, comments: ids.map(id => ({ id, text: id })),
    ...(continuation ? { continuation } : {}), meta: { source: 'youtube', fetchedAt: new Date().toISOString(), warnings: [], partial: false } });
  await saveVideoResource(env, { kind: 'comments', id }, page(['first', 'overlap'], 'page-two'), Date.now(), 60_000);
  await saveVideoResource(env, { kind: 'comments', id, continuation: 'page-two' }, page(['overlap', 'second'], 'page-three'), Date.now(), 60_000);
  const descriptor = inspection(id, ['metadata', 'transcript', 'comments']);
  descriptor.snapshot.inspector.requestedData.push('comments');
  const remembered = await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify({ ...descriptor, projectId }) }, env);
  const initial = await remembered.json() as { source: { id: string }; sourceRevision: string };
  const append = (body: unknown, target = app) => target.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json, body: JSON.stringify(body) }, readOnlyEnv());
  const request = { sourceRevision: initial.sourceRevision, continuation: 'page-two', projectId, pageReceipt: await commentReceipt(userId, id, 'page-two') };
  const response = await append(request);
  expect(response.status).toBe(200);
  const saved = await response.json() as { sourceRevision: string };
  expect(saved.sourceRevision).not.toBe(initial.sourceRevision);
  // A lost successful response can be retried without appending twice or using a provider.
  expect((await append(request)).status).toBe(200);
  const restored = await (await app.request(`/sources/recent/${initial.source.id}`, {}, readOnlyEnv())).json() as any;
  expect(restored.snapshot.inspector.commentPagesLoaded).toBe(2);
  expect(restored.snapshot.inspector.comments.comments.map((comment: { id: string }) => comment.id)).toEqual(['first', 'overlap', 'second']);
  expect((await append({ ...request, continuation: 'unrelated' })).status).toBe(403);
  expect((await append({ ...request, pageReceipt: `${request.pageReceipt.slice(0, 68)}${'0'.repeat(64)}` })).status).toBe(403);
  const foreign = await owner('foreign-comment-pages');
  expect((await append({ ...request, sourceRevision: saved.sourceRevision, continuation: 'page-three' }, foreign.app)).status).toBe(404);
  expect((await append({ ...request, projectId: foreign.projectId })).status).toBe(404);
  expect((await append(request, sourceApp((await owner('api-comment-pages')).userId, 'api-key'))).status).toBe(403);
  const projectSource = (await account.listProjectSources(projectId))[0]!;
  await saveVideoResource(env, { kind: 'comments', id, continuation: 'page-two' }, page(['newer unseen comments']), Date.now() + 1000, 60_000);
  // Retrying another dataset must not replace the retained page chain with the latest shared page.
  const retainedDescriptor = { ...descriptor, snapshot: { ...descriptor.snapshot, inspector: { ...descriptor.snapshot.inspector,
    commentsReceipt: { sourceId: initial.source.id, sourceRevision: saved.sourceRevision } } } };
  const retained = await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify(retainedDescriptor) }, readOnlyEnv());
  expect(retained.status).toBe(201);
  const afterRetry = await (await app.request(`/sources/recent/${initial.source.id}`, {}, readOnlyEnv())).json() as any;
  expect(afterRetry.snapshot.inspector.comments.comments.map((comment: { id: string }) => comment.id)).toEqual(['first', 'overlap', 'second']);
  expect(afterRetry.snapshot.inspector.commentPagesLoaded).toBe(2);
  const foreignReceipt = await foreign.app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify(retainedDescriptor) }, readOnlyEnv());
  expect(foreignReceipt.status).toBe(409);
  await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DELETE FROM recent_sources'); });
  const opened = await open(app, projectId, projectSource.id);
  expect(opened.body.snapshot.inspector.comments.comments.map((comment: { id: string }) => comment.id)).toEqual(['first', 'overlap', 'second']);
  expect(opened.body.snapshot.inspector.commentPagesLoaded).toBe(2);
  const reference = (await account.getProjectSource(projectId, projectSource.id))!.snapshot;
  if (reference.kind !== 'inspection') throw new Error('Expected an inspection');
  await env.VIDEO_ASSETS.delete(await objectKey(reference.inspector.commentPages![0]!.contentHash));
  const partial = await open(app, projectId, projectSource.id);
  expect(partial.body).toMatchObject({ state: 'restored', missingData: ['comments'] });
  expect(partial.body.snapshot.inspector.comments.comments.map((comment: { id: string }) => comment.id)).toEqual(['first', 'overlap']);
  expect(partial.body.snapshot.inspector.dataErrors.comments).toBe(MISSING);
});


test('appending comments to a D1 item rolls back Recent when pinning fails', async () => {
  const { userId, projectId, app, account } = await owner('comments-pin-rollback');
  const id = videoId();
  await storeVideo(id);
  const page = (text: string, continuation?: string) => ({ videoId: id, comments: [{ id: text, text }], continuation,
    meta: { source: 'youtube', fetchedAt: new Date().toISOString(), warnings: [], partial: false } });
  await saveVideoResource(env, { kind: 'comments', id }, { ...page('first', 'next'), totalCount: 200 }, Date.now(), 60_000);
  await saveVideoResource(env, { kind: 'comments', id, continuation: 'next' }, page('second', 'not-stored'), Date.now(), 60_000);
  const item = await addItem(app, projectId, { entityType: 'video', entityId: id });
  const descriptor = inspection(id, ['metadata', 'comments']);
  descriptor.snapshot.inspector.requestedData = ['comments'];
  const initial = await (await app.request('/sources/recent', { method: 'POST', headers: json,
    body: JSON.stringify({ ...descriptor, projectId }) }, env)).json() as { source: { id: string }; sourceRevision: string };
  const append = async (revision: string, continuation = 'next') => app.request(`/sources/recent/${initial.source.id}/comments`, {
    method: 'POST', headers: json, body: JSON.stringify({ sourceRevision: revision, continuation, projectId, pageReceipt: await commentReceipt(userId, id, continuation) }),
  }, readOnlyEnv());
  const before = (await account.getSource(initial.source.id))!.snapshot;
  await runInDurableObject(account, (_instance, state) => {
    state.storage.sql.exec(`CREATE TRIGGER reject_comment_pin BEFORE INSERT ON project_item_snapshots BEGIN SELECT RAISE(ABORT, 'injected pin failure'); END`);
  });
  expect((await append(initial.sourceRevision)).status).toBe(500);
  expect((await account.getSource(initial.source.id))!.snapshot).toEqual(before);
  expect((await open(app, projectId, item.id)).body.snapshot.inspector.commentPagesLoaded).toBe(1);
  await runInDurableObject(account, (_instance, state) => { state.storage.sql.exec('DROP TRIGGER reject_comment_pin'); });
  const committed = await append(initial.sourceRevision);
  expect(committed.status).toBe(200);
  const revision = (await committed.json() as { sourceRevision: string }).sourceRevision;
  const opened = await open(app, projectId, item.id);
  expect(opened.body.snapshot.inspector.commentPagesLoaded).toBe(2);
  expect(opened.body.snapshot.inspector.comments.totalCount).toBe(200);
  expect(await account.projectSourceCounts()).toEqual([]);
  // A concurrent save using the old reference cannot overwrite the appended pages.
  expect(await account.replaceSourceReferences(initial.source.id, before, { input: descriptor.input, title: 'Stale save', snapshot: before })).toEqual({ ok: false });
  expect((await append(revision, 'not-stored')).status).toBe(409);
  expect((await open(app, projectId, item.id)).body.sourceRevision).toBe(revision);
});


for (const { destination, operation } of [
  { destination: 'recent', operation: 'save' }, { destination: 'project-source', operation: 'save' }, { destination: 'item', operation: 'save' },
  { destination: 'project-source', operation: 'pin' }, { destination: 'item', operation: 'pin' },
] as const) test(`${operation} cannot overwrite a concurrently appended page in ${destination}`, async () => {
  const { userId, projectId, app, account } = await owner('interleaved-save');
  const id = videoId();
  await storeVideo(id);
  const page = (text: string, continuation?: string) => ({ videoId: id, comments: [{ id: text, text }], continuation,
    meta: { source: 'youtube', fetchedAt: new Date().toISOString(), warnings: [], partial: false } });
  await saveVideoResource(env, { kind: 'comments', id }, page('first', 'next'), Date.now(), 60_000);
  await saveVideoResource(env, { kind: 'comments', id, continuation: 'next' }, page('second'), Date.now(), 60_000);
  const item = destination === 'item' ? await addItem(app, projectId, { entityType: 'video', entityId: id }) : null;
  const descriptor = inspection(id, ['metadata', 'comments']);
  descriptor.snapshot.inspector.requestedData = ['comments'];
  const project = destination === 'recent' ? {} : { projectId };
  const initial = await (await app.request('/sources/recent', { method: 'POST', headers: json,
    body: JSON.stringify({ ...descriptor, ...project }) }, env)).json() as { source: { id: string }; sourceRevision: string };
  let release = () => {}, entered = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  const gatedEnv = { ...readOnlyEnv(), VIDEO_ASSETS: new Proxy(env.VIDEO_ASSETS, { get(target, property) {
    if (property === 'get') return async (key: string) => {
      const result = await target.get(key);
      if (!blocked) { blocked = true; entered(); await gate; }
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
  const targetItemId = item?.id ?? (await account.listProjectSources(projectId))[0]?.id;
  const stale = app.request(operation === 'pin' ? `/projects/${projectId}/sources/items/${targetItemId}/snapshot` : '/sources/recent',
    { method: operation === 'pin' ? 'PUT' : 'POST', headers: json, body: JSON.stringify({ ...descriptor, ...(operation === 'save' ? project : {}),
    snapshot: { ...descriptor.snapshot, inspector: { ...descriptor.snapshot.inspector,
      commentsReceipt: { sourceId: initial.source.id, sourceRevision: initial.sourceRevision } } } }) }, gatedEnv);
  try {
    await waiting;
    const append = await app.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json,
      body: JSON.stringify({ sourceRevision: initial.sourceRevision, continuation: 'next', ...project, pageReceipt: await commentReceipt(userId, id, 'next') }) }, readOnlyEnv());
    expect(append.status).toBe(200);
    release();
    expect((await stale).status).toBe(409);
    const recent = await (await app.request(`/sources/recent/${initial.source.id}`, {}, readOnlyEnv())).json() as any;
    expect(recent.snapshot.inspector.comments.comments.map((comment: { text: string }) => comment.text)).toEqual(['first', 'second']);
    if (destination !== 'recent') {
      const projectItem = item?.id ?? (await account.listProjectSources(projectId))[0]!.id;
      expect((await open(app, projectId, projectItem)).body.snapshot.inspector.commentPagesLoaded).toBe(2);
    }
  } finally { release(); await stale; }
});

test('a retention retry pins the fetched page even after the shared page changes', async () => {
  const { app, userId } = await owner('exact-page-retry');
  const id = videoId();
  await storeVideo(id);
  const page = (text: string, continuation?: string) => ({ videoId: id, comments: [{ id: text, text }], continuation,
    meta: { source: 'youtube', fetchedAt: new Date().toISOString(), warnings: [], partial: false } });
  await saveVideoResource(env, { kind: 'comments', id }, page('first', 'next'), Date.now(), 60_000);
  await saveVideoResource(env, { kind: 'comments', id, continuation: 'next' }, page('displayed'), Date.now(), 60_000);
  const descriptor = inspection(id, ['metadata', 'comments']);
  const initial = await (await app.request('/sources/recent', { method: 'POST', headers: json, body: JSON.stringify(descriptor) }, env)).json() as { source: { id: string }; sourceRevision: string };
  const pageReceipt = await commentReceipt(userId, id, 'next');
  const request = { sourceRevision: initial.sourceRevision, continuation: 'next', pageReceipt };
  const unavailable = { ...readOnlyEnv(), VIDEO_ASSETS: new Proxy(env.VIDEO_ASSETS, { get(target, property) {
    if (property === 'get') return () => { throw new Error('Temporary R2 failure'); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
  expect((await app.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json,
    body: JSON.stringify(request) }, unavailable)).status).toBe(500);
  // Another request refreshes the shared continuation before this page's retention succeeds.
  await saveVideoResource(env, { kind: 'comments', id, continuation: 'next' }, page('not displayed'), Date.now() + 1000, 60_000);
  const retained = await app.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json,
    body: JSON.stringify(request) }, readOnlyEnv());
  expect(retained.status).toBe(200);
  const restored = await (await app.request(`/sources/recent/${initial.source.id}`, {}, readOnlyEnv())).json() as any;
  expect(restored.snapshot.inspector.comments.comments.map((comment: { text: string }) => comment.text)).toEqual(['first', 'displayed']);
  // A response-lost retry recognizes only the exact page that was committed.
  expect((await app.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json, body: JSON.stringify(request) }, readOnlyEnv())).status).toBe(200);
  const newerReceipt = await commentReceipt(userId, id, 'next');
  expect((await app.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json,
    body: JSON.stringify({ ...request, pageReceipt: newerReceipt }) }, readOnlyEnv())).status).toBe(409);
  const foreign = await owner('foreign-page-receipt');
  const forged = await commentReceipt(foreign.userId, id, 'next');
  expect((await app.request(`/sources/recent/${initial.source.id}/comments`, { method: 'POST', headers: json,
    body: JSON.stringify({ ...request, pageReceipt: forged }) }, readOnlyEnv())).status).toBe(403);
});
