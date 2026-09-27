import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { SaveReferencedSource } from '../src/lib/source-history';
import { referenceSource, restoreSource } from '../src/lib/source-history-storage';
import { saveVideoResource } from '../src/lib/video-resources';
import { sha256 } from '../src/lib/http';
import { jsonError } from '../src/lib/http';
import { Hono } from 'hono';
import { sessionRoutes } from '../src/routes/session/session.index';
import type { App, AuthPrincipal } from '../src/types';
const env = workerEnv as Env;

function sourceApp(userId: string, method: AuthPrincipal['method'] = 'session') {
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: userId, email: `${userId}@example.test`, name: userId };
    c.set('principal', { user, method, permissions: {} }); c.set('user', user); await next();
  });
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  return app;
}

const CONVERSATION_A = 'a08cff6c-326e-47f7-b771-59ff58c48846';
const CONVERSATION_B = 'e665d2a1-f9f9-4b7f-8b7c-0bf0a1393c3b';
const CONVERSATION_C = 'cfb5309a-954f-4e4a-9b0e-2d673c708f20';

describe('UserAccountDO', () => {
  test('recent source routes enforce ownership and browser authentication and restore playlist data', async () => {
    const playlist = { id: 'PLhistory', title: 'Saved playlist', videos: [] };
    const key = `youtube:v1:${await sha256(JSON.stringify(['playlist-v2', playlist.id]))}`;
    await env.YOUTUBE_CACHE.put(key, JSON.stringify({ version: 1, fetchedAt: Date.now(), freshUntil: Date.now() + 60_000, value: playlist }));
    const first = sourceApp('route-first');
    const request = () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      input: 'https://youtube.com/playlist?list=PLhistory', snapshot: { kind: 'inspection', inspector: {
        provider: 'youtube', type: 'playlist', id: playlist.id, requestedData: [], dataErrors: {}, loadedData: ['metadata'],
      } },
    }) });
    const saved = await first.request('/sources/recent', request(), env);
    expect(saved.status).toBe(201);
    const { source } = await saved.json() as { source: { id: string } };
    const list = await first.request('/sources/recent', {}, env);
    expect(await list.json()).toMatchObject({ sources: [{ id: source.id }] });
    const restored = await first.request(`/sources/recent/${source.id}`, {}, env);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ snapshot: { kind: 'inspection', inspector: { data: playlist } } });
    expect((await sourceApp('route-second').request(`/sources/recent/${source.id}`, {}, env)).status).toBe(404);
    expect((await sourceApp('route-first', 'cli-session').request('/sources/recent', {}, env)).status).toBe(403);
    expect((await sourceApp('route-first', 'api-key').request('/sources/recent', request(), env)).status).toBe(403);
    expect((await first.request('/sources/recent/invalid', {}, env)).status).toBe(422);
    const malformed = await first.request('/sources/recent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env);
    expect(malformed.status).toBe(422);
  });
  test('recent videos store catalog references, reuse shared assets and restore the original version', async () => {
    const id = 'abcdefghijk';
    const metadata = { id, title: 'Shared video', thumbnails: [] };
    const transcript = { videoId: id, text: 'Original transcript', segments: [{ text: 'Original transcript', startMs: 0, endMs: 1000, durationMs: 1000 }],
      track: { name: 'English', kind: 'asr', languageCode: 'en' }, meta: { source: 'youtube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } };
    await saveVideoResource(env, { kind: 'video', id }, metadata, Date.now(), 60_000);
    await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, transcript, Date.now(), 60_000);
    const references = await referenceSource(env, { input: `https://youtu.be/${id}`, snapshot: { kind: 'inspection', inspector: {
      provider: 'youtube', type: 'video', id, requestedData: ['transcript'], dataErrors: {}, loadedData: ['metadata', 'transcript'],
    } } });
    const first = env.USER_ACCOUNT.getByName('source-first'), second = env.USER_ACCOUNT.getByName('source-second');
    const saved = await first.saveSource(references);
    expect(await second.getSource(saved.id)).toBeNull();
    await second.saveSource(references);
    await runInDurableObject(first, (_instance, state) => {
      const row = state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM recent_sources').one();
      expect(row.snapshot).toContain('contentHash');
      expect(row.snapshot).not.toContain('Original transcript');
      expect(row.snapshot).not.toContain('segments');
    });
    const storedObjects = (await env.VIDEO_ASSETS.list()).objects.length;
    await first.saveSource(references);
    expect((await first.listSources())).toHaveLength(1);
    expect((await env.VIDEO_ASSETS.list()).objects).toHaveLength(storedObjects);
    await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, { ...transcript, text: 'Refreshed transcript', segments: [{ ...transcript.segments[0], text: 'Refreshed transcript' }] }, Date.now() + 1000, 60_000);
    const stored = await first.getSource(saved.id);
    const restored = await restoreSource(env, stored!.snapshot);
    expect(restored.kind).toBe('inspection');
    if (restored.kind === 'inspection') {
      expect(restored.inspector.transcript?.text).toBe('Original transcript');
      expect(restored.inspector.data.title).toBe('Shared video');
    }
    await first.beginDeletion(); await first.finishDeletion();
    await expect(second.getSource((await second.listSources())[0]!.id)).resolves.not.toBeNull();
    expect(await restoreSource(env, references.snapshot)).toEqual(restored);
    await runInDurableObject(first, (instance, state) => {
      expect(() => instance.listSources()).toThrow('deletion');
      expect(() => instance.saveSource(references)).toThrow('deletion');
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM recent_sources').one().count).toBe(0);
    });
  });

  test('search history persists public results outside the DO and deduplicates normalized terms', async () => {
    const input = 'Opus vs Astra';
    const results = [{ id: 'abcdefghijk', type: 'video', title: 'Model comparison', thumbnails: [] }];
    const searchKey = await sha256(JSON.stringify({ query: input, filters: { type: 'video' } }));
    const cacheKey = `youtube:v1:${await sha256(JSON.stringify(['search-v3', searchKey]))}`;
    await env.YOUTUBE_CACHE.put(cacheKey, JSON.stringify({ version: 1, fetchedAt: Date.now(), freshUntil: Date.now() + 60_000, value: { query: input, results } }));
    const referenced = await referenceSource(env, { input, snapshot: { kind: 'search', selectedData: ['transcript'] } });
    const account = env.USER_ACCOUNT.getByName('source-search');
    const first = await account.saveSource(referenced);
    const repeat = await account.saveSource({ ...referenced, input: '  OPUS   vs Astra  ' });
    expect(repeat.id).toBe(first.id);
    expect(await account.listSources()).toHaveLength(1);
    const restored = await restoreSource(env, referenced.snapshot);
    expect(restored).toEqual({ kind: 'search', selectedData: ['transcript'], items: results });
    if (referenced.snapshot.kind === 'search') {
      const payload = await (await env.VIDEO_ASSETS.get(referenced.snapshot.results))!.text();
      expect(payload).not.toContain(input);
      await env.VIDEO_ASSETS.delete(referenced.snapshot.results);
      await expect(restoreSource(env, referenced.snapshot)).rejects.toThrow('Saved source data is unavailable');
    }
  });

  test('recent sources keep the newest thirty entries', async () => {
    const account = env.USER_ACCOUNT.getByName('source-limit');
    const snapshot: SaveReferencedSource['snapshot'] = { kind: 'search', selectedData: ['transcript'], results: `youtube/source-history/${'a'.repeat(64)}.json` };
    for (let i = 0; i < 32; i++) await account.saveSource({ input: `query ${i}`, title: `query ${i}`, snapshot });
    const sources = await account.listSources();
    expect(sources).toHaveLength(30);
    expect(sources[0]?.input).toBe('query 31');
    expect(sources.some(source => source.input === 'query 0')).toBe(false);
    await account.getSource(sources.at(-1)!.id);
    expect((await account.listSources())[0]?.id).toBe(sources.at(-1)!.id);
  });
  test('deletion includes admissions without catalog entries and blocks late writes', async () => {
    const account = env.USER_ACCOUNT.getByName('user:deletion');
    await account.registerConversation(CONVERSATION_A);
    await account.recordSession({ conversationId: CONVERSATION_B,
      runId: '6c5496c8-0efe-450b-b2d7-b5d0d2c105aa', message: 'Private research', updatedAt: 100 });
    expect(await account.beginDeletion()).toEqual(expect.arrayContaining([CONVERSATION_A, CONVERSATION_B]));
    await runInDurableObject(account, instance => { expect(() => instance.registerConversation(CONVERSATION_C)).toThrow('deletion'); });
    await runInDurableObject(account, instance => { expect(() => instance.recordSession({ conversationId: CONVERSATION_C,
      runId: '540208c8-4d9d-43e0-842e-0bdd331ff4d9', message: 'Late write', updatedAt: 200 })).toThrow('deletion'); });
    // Until cleanup succeeds, retrying retains every conversation to be deleted.
    expect(await account.beginDeletion()).toHaveLength(2);
    await account.finishDeletion();
    expect((await account.listSessions()).sessions).toEqual([]);
    expect((await account.listSessions({ query: 'Private' })).sessions).toEqual([]);
    expect(await account.beginDeletion()).toEqual([]);
    await runInDurableObject(account, instance => { expect(() => instance.registerConversation(CONVERSATION_A)).toThrow('deletion'); });
  });

  test('records sessions idempotently and preserves the first-message title', async () => {
    const account = env.USER_ACCOUNT.getByName('user:catalog-idempotency');
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: '6c5496c8-0efe-450b-b2d7-b5d0d2c105aa',
      message: 'Research Durable Object coordination',
      updatedAt: 100,
    });
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: '6c5496c8-0efe-450b-b2d7-b5d0d2c105aa',
      message: 'Research Durable Object coordination',
      updatedAt: 100,
    });
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: '540208c8-4d9d-43e0-842e-0bdd331ff4d9',
      message: 'Now compare it with D1',
      updatedAt: 200,
    });

    const page = await account.listSessions({});
    expect(page.sessions).toEqual([expect.objectContaining({
      conversationId: CONVERSATION_A,
      title: 'Research Durable Object coordination',
      latestMessagePreview: 'Now compare it with D1',
      runCount: 2,
      updatedAt: 200,
    })]);
    await expect(account.getSession(CONVERSATION_A)).resolves.toMatchObject({
      conversationId: CONVERSATION_A,
      runCount: 2,
      title: 'Research Durable Object coordination',
    });
  });

  test('searches user prompts with FTS5 and paginates by recent activity', async () => {
    const account = env.USER_ACCOUNT.getByName('user:catalog-search');
    await account.recordSession({
      conversationId: CONVERSATION_A,
      runId: 'b0c16b5d-6d0b-433d-a000-50464eea39ab',
      message: 'Research Cloudflare Durable Objects',
      updatedAt: 100,
    });
    await account.recordSession({
      conversationId: CONVERSATION_B,
      runId: '1f500067-ea34-45d1-a394-fc80d82e67ab',
      message: 'Inspect a YouTube architecture video',
      updatedAt: 200,
    });
    await account.recordSession({
      conversationId: CONVERSATION_C,
      runId: '8051cf66-34fa-4780-935d-7f2f6173f5ea',
      message: 'Compare Durable Object storage options',
      updatedAt: 300,
    });

    const search = await account.listSessions({ query: 'dur obj', limit: 10 });
    expect(search.sessions.map((session) => session.conversationId)).toEqual([
      CONVERSATION_C,
      CONVERSATION_A,
    ]);

    const firstPage = await account.listSessions({ limit: 2 });
    expect(firstPage.sessions.map((session) => session.conversationId)).toEqual([
      CONVERSATION_C,
      CONVERSATION_B,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await account.listSessions({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.sessions.map((session) => session.conversationId)).toEqual([CONVERSATION_A]);
    expect(secondPage.nextCursor).toBeNull();
  });

  test('keeps separate users in separate Durable Objects', async () => {
    const first = env.USER_ACCOUNT.getByName('user:first');
    const second = env.USER_ACCOUNT.getByName('user:second');
    await first.recordSession({
      conversationId: CONVERSATION_A,
      runId: 'f4e21122-5141-4872-b298-a0ae76ad19e1',
      message: 'Private first-user session',
      updatedAt: 100,
    });

    await expect(first.listSessions({})).resolves.toMatchObject({ sessions: [{ conversationId: CONVERSATION_A }] });
    await expect(first.getSession(CONVERSATION_A)).resolves.toMatchObject({ conversationId: CONVERSATION_A });
    await expect(second.listSessions({})).resolves.toEqual({ sessions: [], nextCursor: null });
    await expect(second.getSession(CONVERSATION_A)).resolves.toBeNull();
  });
});

test('operator session inventory uses stable IDs across pages while session activity changes', async () => {
  const account = env.USER_ACCOUNT.getByName('operator-stable-inventory');
  const ids = Array.from({ length: 102 }, () => crypto.randomUUID()).sort();
  for (const conversationId of ids) await account.recordSession({
    conversationId, runId: crypto.randomUUID(), message: 'Private prompt', updatedAt: 100,
  });
  const first = await account.listSessionAssetMigrationTargets();
  expect(first.conversationIds).toEqual(ids.slice(0, 100));
  // A recency-based cursor would miss this now-active session on the next page.
  await account.recordSession({ conversationId: ids[101]!, runId: crypto.randomUUID(), message: 'Updated prompt', updatedAt: 1000 });
  const last = await account.listSessionAssetMigrationTargets(first.nextCursor!);
  expect(last).toEqual({ conversationIds: ids.slice(100), nextCursor: null });
  expect(JSON.stringify(first)).not.toContain('Private prompt');
});
