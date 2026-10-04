import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import { SessionEvidenceStore } from '../src/agents/runtime/session-evidence';
import { SessionCatalog, type SessionCatalogReference } from '../src/agents/runtime/session-catalog';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { VideoCatalog } from '../src/lib/video-catalog';
import { saveVideoResource, videoResourceKey } from '../src/lib/video-resources';
import { withYouTubeMetadata, type CachedResult } from '../src/lib/youtube';

const env = workerEnv as Env;
const videoId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 11);
const catalog = () => new VideoCatalog(env.VIDEO_CATALOG, env.VIDEO_ASSETS);
function transcript(id: string, text = 'Original public transcript'): Transcript {
  return {
    videoId: id,
    track: {
      id: 'en',
      name: 'English',
      languageCode: 'en',
      kind: 'manual',
      isDefault: true,
      isTranslatable: true,
    },
    segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text }],
    text,
    meta: { source: 'allthingsyoutube', fetchedAt: '2026-09-24T00:00:00Z', partial: false, warnings: [] },
  };
}
async function source(id: string, text?: string, at = Date.now()) {
  const raw = transcript(id, text);
  const catalogVersions = await saveVideoResource(
    env,
    { kind: 'transcript', id, granularity: 'word' },
    raw,
    at,
    60_000,
  );
  return {
    value: { ...withYouTubeMetadata(raw), freshness: { state: 'fresh', fetchedAt: at } },
    catalogVersions,
    cacheStatus: 'hit' as const,
  };
}
function provider(result: CachedResult<Transcript>) {
  return { transcript: vi.fn(async () => result) } as unknown as YouTubeAgentProvider;
}
function within(
  name: string,
  work: (args: {
    store: SessionEvidenceStore;
    legacy: SessionEvidenceStore;
    backend: SessionCatalog;
    sql: SqlStorage;
    prefix: string;
    reopen: () => SessionEvidenceStore;
    atomic: <T>(fn: () => T) => T;
  }) => Promise<void>,
) {
  return runInDurableObject(env.AGENT_RUNTIME.getByName(`catalog-${name}`), async (_instance, state) => {
    const prefix = `session-catalog-test/${name}/`;
    const backend = new SessionCatalog(env);
    const atomic = <T>(fn: () => T) => state.storage.transactionSync(fn);
    const reopen = () =>
      new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix, undefined, backend, atomic);
    await work({
      store: reopen(),
      legacy: new SessionEvidenceStore(state.storage.sql, env.RESEARCH, prefix),
      backend,
      sql: state.storage.sql,
      prefix,
      reopen,
      atomic,
    });
  });
}
function reference(sql: SqlStorage, version: string): SessionCatalogReference {
  return JSON.parse(
    sql
      .exec<{ reference_json: string }>(
        'SELECT reference_json FROM session_asset_catalog_refs WHERE version=?',
        version,
      )
      .one().reference_json,
  );
}

test('two sessions reuse one source object while deletion removes only the first session evidence', async () => {
  const id = videoId(),
    data = await source(id);
  await within('owner-a', async ({ store, sql, prefix }) => {
    const result = await sessionProvider(provider(data), store).transcript(id);
    const version = result.assetVersions![0]!;
    const packet = (await store.readEvidence(version)).packets[0]!;
    store.beginRun('r1');
    store.remember(
      'r1',
      [
        {
          kind: 'finding',
          topic: 'private',
          text: 'Private session conclusion',
          evidenceIds: [packet.excerpts[0]!.id],
        },
      ],
      [packet],
    );
    expect(store.brief().memories).toHaveLength(1);
    expect(reference(sql, version).asset).toEqual(data.catalogVersions[0]);
    expect(JSON.stringify(reference(sql, version))).not.toContain('Original public transcript');
    expect((await env.RESEARCH.list({ prefix })).objects).toEqual([]);
  });
  let secondVersion = '';
  await within('owner-b', async ({ store, prefix }) => {
    const saved = await sessionProvider(provider(data), store).transcript(id);
    secondVersion = saved.assetVersions![0]!;
    expect(await store.read(secondVersion)).toEqual(data.value);
    expect((await env.RESEARCH.list({ prefix })).objects).toEqual([]);
  });
  await within('owner-a', async ({ store, sql }) => {
    const version = store.brief().assets[0]!.version;
    await store.delete(version);
    expect(await store.read(version)).toBeNull();
    expect(await store.lookup(`transcript:${id}:default`)).toBeUndefined();
    expect(store.evidence()).toEqual([]);
    expect(store.brief().memories).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
  });
  await within('owner-b', async ({ store }) => {
    expect(await store.read(secondVersion)).toEqual(data.value);
  });
  expect((await env.VIDEO_ASSETS.list({ prefix: `youtube/videos/${id}/` })).objects).toHaveLength(1);
  expect(await catalog().readVersion(data.catalogVersions[0]!)).toMatchObject({ value: transcript(id) });
  expect((await catalog().inventory(id)).results).toHaveLength(1);
});

test('sessions pin old content across refresh and never substitute current content for a missing version', async () => {
  const id = videoId(),
    old = await source(id, 'Earlier captions', Date.now() - 1000);
  await within('pinned-version', async ({ store, reopen }) => {
    const result = await sessionProvider(provider(old), store).transcript(id);
    const version = result.assetVersions![0]!;
    const citations = (await store.readEvidence(version)).packets[0]!.excerpts;
    await source(id, 'Refreshed captions');
    expect(await reopen().read(version)).toEqual(old.value);
    expect((await reopen().readEvidence(version)).packets[0]!.excerpts).toEqual(citations);
    const row = await env.VIDEO_CATALOG.prepare(
      'SELECT object_key FROM video_asset_versions WHERE content_hash=?',
    )
      .bind(old.catalogVersions[0]!.contentHash)
      .first<{ object_key: string }>();
    await env.VIDEO_ASSETS.delete(row!.object_key);
    expect(await reopen().read(version)).toBeNull();
    expect(
      await catalog().read(videoResourceKey({ kind: 'transcript', id, granularity: 'word' })!),
    ).toMatchObject({ value: { text: 'Refreshed captions' } });
  });
});

test('legacy backfill preserves citation identities, retains the private copy and keeps the newer public pointer', async () => {
  const id = videoId();
  await within('legacy-history', async ({ legacy, reopen, sql, prefix }) => {
    const value = transcript(id, 'Historical captions');
    const old = await legacy.retrieve(
      `transcript:${id}:default`,
      'transcript',
      id,
      false,
      async () => ({ value, cacheStatus: 'miss' }),
      () => ({}),
    );
    const version = old.assetVersions![0]!;
    const before = legacy.brief();
    const citations = (await legacy.readEvidence(version)).packets[0]!.excerpts;
    const blob = sql
      .exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version)
      .one().blob_key;
    await source(id, 'Current captions');
    const restored = reopen();
    await restored.backfill();
    expect(await restored.read(version)).toEqual(value);
    expect(restored.brief()).toEqual(before);
    expect((await restored.readEvidence(version)).packets[0]!.excerpts).toEqual(citations);
    expect(await env.RESEARCH.get(blob)).not.toBeNull();
    expect((await env.RESEARCH.list({ prefix })).objects).toHaveLength(1);
    expect(
      sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version).one()
        .blob_key,
    ).toBe(blob);
    expect(reference(sql, version).asset.contentHash).toBeTruthy();
    expect(
      await catalog().read(videoResourceKey({ kind: 'transcript', id, granularity: 'word' })!),
    ).toMatchObject({ value: { text: 'Current captions' } });
  });
});

test('a failed legacy backfill leaves the private asset readable and retries later', async () => {
  const id = videoId();
  await within('backfill-failure', async ({ legacy, store, backend, sql }) => {
    const value = transcript(id);
    const result = await legacy.retrieve(
      `transcript:${id}:default`,
      'transcript',
      id,
      false,
      async () => ({ value, cacheStatus: 'miss' }),
      () => ({}),
    );
    const version = result.assetVersions![0]!;
    const blob = sql
      .exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version)
      .one().blob_key;
    const mock = vi.spyOn(backend, 'pin').mockRejectedValueOnce(new Error('storage outage'));
    expect(await store.read(version)).toEqual(value);
    expect(await env.RESEARCH.get(blob)).not.toBeNull();
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    mock.mockRestore();
    expect(await store.read(version)).toEqual(value);
    expect(await env.RESEARCH.get(blob)).not.toBeNull();
  });
});

test('deletion during legacy migration cannot restore session access or delete the shared payload', async () => {
  const id = videoId();
  await within('backfill-delete-race', async ({ legacy, store, backend, sql }) => {
    const value = transcript(id);
    const saved = await legacy.retrieve(
      `transcript:${id}:default`,
      'transcript',
      id,
      false,
      async () => ({ value, cacheStatus: 'miss' }),
      () => ({}),
    );
    const version = saved.assetVersions![0]!;
    let unblock!: () => void, started!: (ref: SessionCatalogReference) => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<SessionCatalogReference>((resolve) => {
      started = resolve;
    });
    const original = backend.pin.bind(backend);
    vi.spyOn(backend, 'pin').mockImplementation(async (...args) => {
      const ref = await original(...args);
      started(ref);
      await gate;
      return ref;
    });
    const reading = store.read(version);
    const pinned = await ready;
    await store.delete(version);
    unblock();
    expect(await reading).toBeNull();
    expect(store.brief().assets).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    expect(await catalog().readVersion(pinned.asset)).toMatchObject({ value });
  });
});

test('deletion during a new retrieval prevents a session link while retaining the shared source', async () => {
  const id = videoId(),
    data = await source(id);
  await within('retrieve-delete-race', async ({ store, backend, sql }) => {
    let unblock!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = backend.pin.bind(backend);
    vi.spyOn(backend, 'pin').mockImplementation(async (...args) => {
      const ref = await original(...args);
      started();
      await gate;
      return ref;
    });
    const loading = sessionProvider(provider(data), store).transcript(id);
    const rejected = expect(loading).rejects.toThrow('Session assets changed');
    await ready;
    await store.delete();
    unblock();
    await rejected;
    expect(store.brief().assets).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    expect(await catalog().readVersion(data.catalogVersions[0]!)).not.toBeNull();
  });
});

test('a session cannot use an unowned version or pin a mismatched source reference', async () => {
  const id = videoId(),
    data = await source(id);
  await within('unowned', async ({ store }) => {
    expect(await store.read(data.catalogVersions[0]!.contentHash)).toBeNull();
    const wrong = { ...data, value: transcript(id, 'Different source text') };
    await expect(sessionProvider(provider(wrong), store).transcript(id)).rejects.toThrow('does not match');
    expect(store.brief().assets).toEqual([]);
  });
});

test('frame and storyboard batches link each selected image once and reuse it after reopening', async () => {
  const id = videoId(),
    jpeg = '/9j/AA==';
  const frames = {
    videoId: id,
    frames: [1000, 2000].map((timestampMs) => ({
      timestampMs,
      width: 640,
      height: 360,
      mimeType: 'image/jpeg' as const,
      imageBase64: jpeg,
    })),
    failures: [],
    meta: { partial: false, warnings: [] },
  };
  const frameRefs = await saveVideoResource(
    env,
    { kind: 'frames', id, timestampsMs: [1000, 2000], maxWidth: 640, extractionTimeoutMs: 45_000 },
    frames,
    Date.now(),
    60_000,
  );
  const board = {
    videoId: id,
    intervalMs: 10_000,
    frameCount: 4,
    manifest: {
      totalSheets: 2,
      framesPerSheet: 2,
      tileWidth: 120,
      tileHeight: 90,
      columns: 2,
      rows: 1,
      lastSampleMs: 30_000,
    },
    sheets: [],
    selection: { mode: 'metadata' as const },
    meta: { partial: false, warnings: [] },
  };
  const manifestRefs = await saveVideoResource(
    env,
    { kind: 'storyboard', id, metadataOnly: true },
    board,
    Date.now(),
    60_000,
  );
  const sheets = {
    ...board,
    selection: { mode: 'indexes' as const, requestedSheetIndexes: [0, 1] },
    sheets: [0, 1].map((index) => ({
      tileWidth: 120,
      tileHeight: 90,
      columns: 2,
      rows: 1,
      firstFrameIndex: index * 2,
      frameCount: 2,
      intervalMs: 10_000,
      imageBase64: jpeg,
    })),
  };
  const sheetRefs = await saveVideoResource(
    env,
    { kind: 'storyboard', id, sheetIndexes: [0, 1] },
    sheets,
    Date.now(),
    60_000,
  );
  const upstream = {
    frames: vi.fn(async () => ({ value: frames, cacheStatus: 'hit', catalogVersions: frameRefs })),
    storyboard: vi.fn(async (_id: string, _times: unknown, options: { metadataOnly?: boolean }) =>
      options.metadataOnly
        ? { value: board, cacheStatus: 'hit', catalogVersions: manifestRefs }
        : { value: sheets, cacheStatus: 'hit', catalogVersions: [...manifestRefs, ...sheetRefs] },
    ),
  } as unknown as YouTubeAgentProvider;
  await within('visuals', async ({ store, reopen, sql, prefix }) => {
    const wrapped = sessionProvider(upstream, store);
    const a = await wrapped.frames!({ videoId: id, timestampsMs: [1000, 2000], maxWidth: 640 });
    const b = await wrapped.storyboard!(id, undefined, { sheetIndexes: [0, 1] });
    expect(a.assetVersions).toHaveLength(2);
    expect(b.assetVersions).toHaveLength(3);
    for (const asset of store.brief().assets) {
      const ref = reference(sql, asset.version);
      expect(ref.asset.kind).toBe(asset.kind);
      expect(JSON.stringify(ref)).not.toContain(jpeg);
      expect(await reopen().read(asset.version)).not.toBeNull();
    }
    const restored = sessionProvider(upstream, reopen());
    expect((await restored.frames!({ videoId: id, timestampsMs: [1000], maxWidth: 640 })).sessionReused).toBe(
      true,
    );
    expect((await restored.storyboard!(id, undefined, { sheetIndexes: [1] })).sessionReused).toBe(true);
    expect(upstream.frames).toHaveBeenCalledTimes(1);
    expect(upstream.storyboard).toHaveBeenCalledTimes(1);
    await store.delete();
    expect((await env.RESEARCH.list({ prefix })).objects).toEqual([]);
  });
  expect((await env.VIDEO_ASSETS.list({ prefix: `youtube/videos/${id}/images/` })).objects).toHaveLength(1);
  for (const ref of [...frameRefs, ...manifestRefs, ...sheetRefs])
    expect(await catalog().readVersion(ref)).not.toBeNull();
});

test('a failed local commit leaves no asset, alias or reference but retains the shared source', async () => {
  const id = videoId(),
    data = await source(id);
  await within('transaction-failure', async ({ backend, sql, prefix, atomic, reopen }) => {
    const broken = new SessionEvidenceStore(sql, env.RESEARCH, prefix, undefined, backend, (work) =>
      atomic(() => {
        work();
        throw new Error('Interrupted transaction');
      }),
    );
    await expect(sessionProvider(provider(data), broken).transcript(id)).rejects.toThrow(
      'Interrupted transaction',
    );
    expect(reopen().brief().assets).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    expect(await reopen().lookup(`transcript:${id}:default`)).toBeUndefined();
    expect(await catalog().readVersion(data.catalogVersions[0]!)).not.toBeNull();
  });
});

test('unsupported private fields in a legacy blob remain private', async () => {
  const id = videoId();
  await within('private-legacy', async ({ legacy, store, sql }) => {
    const value = { ...transcript(id), privateAnalysis: 'User-specific interpretation' };
    const saved = await legacy.retrieve(
      `transcript:${id}:default`,
      'transcript',
      id,
      false,
      async () => ({ value, cacheStatus: 'miss' }),
      () => ({}),
    );
    expect(await store.read(saved.assetVersions![0]!)).toEqual(value);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    expect((await env.VIDEO_ASSETS.list({ prefix: `youtube/videos/${id}/` })).objects).toEqual([]);
  });
});

test('preview capabilities store only references and revocation leaves shared image bytes intact', async () => {
  const { saveFramePreviews, framePreviewKey } = await import('../src/agents/runtime/frame-previews');
  const { agentFramePreviewRoutes } = await import('../src/routes/agent/frame-previews');
  const id = videoId();
  const frames = {
    videoId: id,
    frames: [
      {
        timestampMs: 1000,
        width: 640,
        height: 360,
        mimeType: 'image/jpeg' as const,
        imageBase64: '/9j/AA==',
      },
    ],
    failures: [],
    meta: { partial: false, warnings: [] },
  };
  await saveVideoResource(
    env,
    { kind: 'frames', id, timestampsMs: [1000], maxWidth: 640, extractionTimeoutMs: 45_000 },
    frames,
    Date.now(),
    60_000,
  );
  const signal = new AbortController().signal;
  const first = (
    await saveFramePreviews(env.RESEARCH, 'preview-owner', frames, signal, env.VIDEO_ASSETS)
  )[0]!;
  const second = (
    await saveFramePreviews(env.RESEARCH, 'preview-owner', frames, signal, env.VIDEO_ASSETS)
  )[0]!;
  const object = await env.RESEARCH.get(framePreviewKey(first.collectionId, first.assetId));
  expect(object?.httpMetadata?.contentType).toBe('application/json');
  const ref = await object!.json<{ sharedImageKey: string }>();
  const read = (preview: typeof first) =>
    agentFramePreviewRoutes.request(`/agent/frames/${preview.collectionId}/${preview.assetId}`, {}, env);
  expect((await read(first)).status).toBe(200);
  await within('preview-revocation', async ({ store }) => {
    store.queueCleanup([framePreviewKey(first.collectionId, first.assetId)]);
    await store.delete();
  });
  expect(await env.RESEARCH.get(framePreviewKey(first.collectionId, first.assetId))).toBeNull();
  expect((await read(second)).status).toBe(200);
  expect(await env.VIDEO_ASSETS.get(ref.sharedImageKey)).not.toBeNull();
});

test('operator sweep covers every page, preserves originals, and retries failed assets without starving later pages', async () => {
  await within('operator-pagination', async ({ legacy, store, backend, sql, reopen, prefix }) => {
    for (let i = 0; i < 12; i++) {
      const id = videoId();
      await legacy.retrieve(`transcript:${id}:default`, 'transcript', id, false,
        async () => ({ value: transcript(id), cacheStatus: 'miss' }), () => ({}));
    }
    const before = legacy.brief();
    const originals = (await env.RESEARCH.list({ prefix })).objects.map(row => [row.key, row.etag]);
    const audit = await store.migrateAssetBatch('verify');
    expect(audit.results).toHaveLength(10);
    expect(audit.results.every(row => row.status === 'unlinked')).toBe(true);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    const pin = vi.spyOn(backend, 'pin').mockRejectedValueOnce(new Error('temporary failure'));
    const first = await store.migrateAssetBatch('migrate');
    expect(first.results.filter(row => row.status === 'unreadable')).toHaveLength(1);
    expect(first.results.filter(row => row.status === 'shared_verified' && row.migrated)).toHaveLength(9);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.migrateAssetBatch('migrate', first.nextCursor!);
    expect(second.results.every(row => row.status === 'shared_verified')).toBe(true);
    expect(second.nextCursor).toBeNull();
    pin.mockRestore();
    const retry = await reopen().migrateAssetBatch('migrate');
    expect(retry.results.every(row => row.status === 'shared_verified')).toBe(true);
    expect(retry.results.filter(row => row.migrated)).toHaveLength(1);
    const verified = await reopen().migrateAssetBatch('verify');
    expect(verified.results.every(row => row.status === 'shared_verified' && !row.migrated)).toBe(true);
    expect(reopen().brief()).toEqual(before);
    expect((await env.RESEARCH.list({ prefix })).objects.map(row => [row.key, row.etag])).toEqual(originals);
  });
});

test('operator verification fails on a missing shared source even while the retained private source is readable', async () => {
  const id = videoId();
  await within('operator-missing-shared', async ({ legacy, store, sql }) => {
    const saved = await legacy.retrieve(`transcript:${id}:default`, 'transcript', id, false,
      async () => ({ value: transcript(id), cacheStatus: 'miss' }), () => ({}));
    const version = saved.assetVersions![0]!;
    expect((await store.migrateAssetBatch('migrate')).results[0]?.status).toBe('shared_verified');
    const ref = reference(sql, version);
    const shared = await env.VIDEO_CATALOG.prepare('SELECT object_key FROM video_asset_versions WHERE content_hash=?')
      .bind(ref.asset.contentHash).first<{ object_key: string }>();
    await env.VIDEO_ASSETS.delete(shared!.object_key);
    const blobKey = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version).one().blob_key;
    expect(await env.RESEARCH.get(blobKey)).not.toBeNull();
    expect((await store.migrateAssetBatch('verify')).results[0]?.status).toBe('unreadable');
    expect(await store.read(version)).toBeNull();
  });
});

test('operator sweep rejects a changed inventory and cannot restore access after concurrent deletion', async () => {
  const id = videoId();
  await within('operator-delete-race', async ({ legacy, store, backend, sql }) => {
    const saved = await legacy.retrieve(`transcript:${id}:default`, 'transcript', id, false,
      async () => ({ value: transcript(id), cacheStatus: 'miss' }), () => ({}));
    const version = saved.assetVersions![0]!;
    const original = backend.pin.bind(backend);
    vi.spyOn(backend, 'pin').mockImplementation(async (...args) => {
      const ref = await original(...args);
      await store.delete(version);
      return ref;
    });
    const batch = await store.migrateAssetBatch('migrate');
    expect(batch.stable).toBe(false);
    expect(batch.results[0]?.status).toBe('changed');
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    await expect(store.migrateAssetBatch('migrate', { afterVersion: version, generation: batch.generation, total: 1 }))
      .rejects.toThrow('Session assets changed');
  });
});

test('operator verification reports a changed retained payload without replacing the shared citation version', async () => {
  const id = videoId();
  await within('operator-mismatch', async ({ legacy, store, sql }) => {
    const saved = await legacy.retrieve(`transcript:${id}:default`, 'transcript', id, false,
      async () => ({ value: transcript(id), cacheStatus: 'miss' }), () => ({}));
    const version = saved.assetVersions![0]!;
    await store.migrateAssetBatch('migrate');
    const before = reference(sql, version);
    const key = sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_assets WHERE version=?', version).one().blob_key;
    await env.RESEARCH.put(key, JSON.stringify(transcript(id, 'Changed private bytes')));
    expect((await store.migrateAssetBatch('verify')).results[0]?.status).toBe('mismatch');
    expect(reference(sql, version)).toEqual(before);
    expect(await store.read(version)).toEqual(transcript(id));
  });
});

test('temporary operator helper authenticates requests before enumerating private sessions', async () => {
  const { default: helper } = await import('../scripts/session-assets/worker');
  const bindings = { ...env, MIGRATION_TOKEN: 'test-operator-token' };
  const denied = await helper.fetch(new Request('https://operator/users', { method: 'POST', body: '{}' }), bindings);
  expect(denied.status).toBe(401);
  const allowed = await helper.fetch(new Request('https://operator/health', {
    method: 'POST', headers: { authorization: 'Bearer test-operator-token' }, body: '{}',
  }), bindings);
  expect(await allowed.json()).toEqual({ ready: true });
});

test.each(['delete', 'cancel'])('%s during concurrent storyboard pinning drains the batch without late references', async mode => {
  const id = videoId();
  const board = { videoId: id, frameCount: 18, intervalMs: 10000,
    manifest: { totalSheets: 9, framesPerSheet: 2, tileWidth: 120, tileHeight: 90, columns: 2, rows: 1, lastSampleMs: 170000 },
    sheets: [], selection: { mode: 'metadata' as const }, meta: { partial: false, warnings: [] } };
  const sheets = { ...board, selection: { mode: 'indexes' as const }, sheets: Array.from({ length: 9 }, (_, i) => ({
    firstFrameIndex: i * 2, frameCount: 2, intervalMs: 10000, tileWidth: 120, tileHeight: 90, columns: 2, rows: 1, imageBase64: '/9j/AA==',
  })) };
  const manifestRefs = await saveVideoResource(env, { kind: 'storyboard', id, metadataOnly: true }, board, Date.now(), 60000);
  const sheetRefs = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 9 }, sheets, Date.now(), 60000);
  await within(`parallel-storyboard-${mode}`, async ({ store, backend, sql }) => {
    const originalPin = backend.pin.bind(backend);
    let started = 0;
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    vi.spyOn(backend, 'pin').mockImplementation(async (...args) => {
      if (args[0] === 'storyboard_sheet') {
        if (++started === 4) ready();
        await gate;
      }
      return originalPin(...args);
    });
    const p = { storyboard: async (_id: string, _times: unknown, options: { metadataOnly?: boolean }) => ({
      value: options.metadataOnly ? board : sheets, cacheStatus: 'hit' as const,
      catalogVersions: options.metadataOnly ? manifestRefs : [...manifestRefs, ...sheetRefs],
    }) } as unknown as YouTubeAgentProvider;
    const controller = new AbortController();
    const request = sessionProvider(p, store).storyboard!(id, undefined, { maxSheets: 9, signal: controller.signal });
    const rejected = expect(request).rejects.toThrow(mode === 'delete' ? 'Session assets changed' : 'retrieval budget elapsed');
    await entered;
    if (mode === 'delete') await store.delete();
    else controller.abort(new Error('retrieval budget elapsed'));
    release();
    await rejected;
    expect(started).toBe(4);
    expect(store.brief().assets.filter(asset => asset.kind === 'storyboard_sheet')).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toHaveLength(mode === 'delete' ? 0 : 1);
    expect(await catalog().readVersion(sheetRefs[0]!)).not.toBeNull();
  });
});

test.each([false, true])('combined cold storyboard pins exact shared versions and reuses them, partial=%s', async partial => {
  const id = videoId();
  const { storyboardMetadata } = await import('../src/agents/providers/youtube/storyboard');
  const board = { videoId:id, frameCount:16, intervalMs:10000,
    manifest:{totalSheets:8,framesPerSheet:2,tileWidth:120,tileHeight:90,columns:2,rows:1,lastSampleMs:150000},
    selection:{mode:'spread' as const}, meta:{partial,warnings:partial ? ['One sheet unavailable'] : []},
    sheets:Array.from({length:partial ? 7 : 8}, (_,index) => ({firstFrameIndex:index*2,frameCount:2,
      intervalMs:10000,tileWidth:120,tileHeight:90,columns:2,rows:1,imageBase64:'/9j/AA=='}))};
  const manifestRefs = await saveVideoResource(env, {kind:'storyboard',id,metadataOnly:true}, storyboardMetadata(board), Date.now(), 60000);
  const sheetRefs = await saveVideoResource(env, {kind:'storyboard',id,maxSheets:12}, board, Date.now(), 60000);
  await within(`combined-cold-${partial}`, async ({store,reopen,sql}) => {
    const upstream = vi.fn(async () => ({value:board,cacheStatus:'miss' as const,catalogVersions:[...manifestRefs,...sheetRefs]}));
    const p = {storyboard:upstream} as unknown as YouTubeAgentProvider;
    const first = await sessionProvider(p,store).storyboard!(id, undefined, {maxSheets:12});
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(first.assetVersions).toHaveLength(board.sheets.length+1);
    expect(first.value.meta.partial).toBe(partial);
    const { saveStoryboardPreviews } = await import('../src/agents/runtime/storyboard-previews');
    const head = vi.spyOn(env.VIDEO_ASSETS, 'head');
    try {
      expect(first.verifiedImages).toHaveLength(board.sheets.length);
      const previews = await saveStoryboardPreviews(env.RESEARCH, 'verified-owner', first.value,
        new AbortController().signal, env.VIDEO_ASSETS, first.verifiedImages);
      expect(previews).toHaveLength(board.sheets.length);
      expect(head).not.toHaveBeenCalled();
    } finally { head.mockRestore(); }
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toHaveLength(board.sheets.length+1);
    const second = await sessionProvider(p,reopen()).storyboard!(id,undefined,{sheetIndexes:[0,1],maxSheets:2});
    expect(second.value.sheets).toHaveLength(2);
    expect(second.sessionReused).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    const savedManifest = await reopen().read(first.assetVersions![0]!);
    expect(savedManifest).toEqual(storyboardMetadata(board));
  });
});

test.each(['delete','cancel'])('%s during combined extraction cannot attach a late manifest or images', async mode => {
  const id = videoId();
  await within(`combined-fetch-${mode}`, async ({store,sql}) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => {enter=resolve;});
    const gate = new Promise<void>(resolve => {release=resolve;});
    const controller = new AbortController();
    const p = {storyboard:async () => {
      enter();
      await gate;
      return {cacheStatus:'miss' as const, value:{videoId:id,frameCount:1,intervalMs:10000,
        manifest:{totalSheets:1,framesPerSheet:1,tileWidth:120,tileHeight:90,columns:1,rows:1,lastSampleMs:0},
        selection:{mode:'spread' as const},meta:{partial:false,warnings:[]},
        sheets:[{firstFrameIndex:0,frameCount:1,intervalMs:10000,tileWidth:120,tileHeight:90,columns:1,rows:1,imageBase64:'/9j/AA=='}]}};
    }} as unknown as YouTubeAgentProvider;
    const pending = sessionProvider(p,store).storyboard!(id,undefined,{maxSheets:1,signal:controller.signal});
    const rejected = expect(pending).rejects.toThrow(mode==='delete' ? 'Session assets changed' : 'cancelled');
    await entered;
    if (mode==='delete') await store.delete(); else controller.abort(new Error('cancelled'));
    release();
    await rejected;
    expect(store.brief().assets).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
  });
});

test('six-frame session pinning reuses verification for previews and explicit refresh bypasses session hits', async () => {
  const id=videoId();
  const times=[1000,2000,3000,4000,5000,6000];
  const frames={videoId:id,frames:times.map(timestampMs=>({timestampMs,width:640,height:360,
    mimeType:'image/jpeg' as const,imageBase64:'/9j/AA=='})),failures:[],meta:{partial:false,warnings:[]}};
  const refs=await saveVideoResource(env,{kind:'frames',id,timestampsMs:times,maxWidth:640,extractionTimeoutMs:5000},frames,Date.now(),60000);
  await within('frames-optimized',async({store,reopen})=>{
    const upstream=vi.fn(async()=>({value:frames,cacheStatus:'miss' as const,catalogVersions:refs}));
    const p={frames:upstream} as unknown as YouTubeAgentProvider;
    const request={videoId:id,timestampsMs:times,maxWidth:640};
    const first=await sessionProvider(p,store).frames!(request);
    expect(first.assetVersions).toHaveLength(6);
    expect(first.verifiedImages).toHaveLength(6);
    const {saveFramePreviews}=await import('../src/agents/runtime/frame-previews');
    const head=vi.spyOn(env.VIDEO_ASSETS,'head');
    try {
      const previews=await saveFramePreviews(env.RESEARCH,'frame-owner',first.value,new AbortController().signal,env.VIDEO_ASSETS,first.verifiedImages);
      expect(previews).toHaveLength(6);
      expect(head).not.toHaveBeenCalled();
    } finally {head.mockRestore();}
    const restored=sessionProvider(p,reopen());
    expect((await restored.frames!(request)).sessionReused).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await restored.frames!(request,undefined,{refresh:true,extractionTimeoutMs:5000})).sessionReused).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenLastCalledWith(request,undefined,{refresh:true,extractionTimeoutMs:5000},undefined);
  });
});

test.each(['cancel','delete'])('%s during frame pinning drains six started pins without late session attachments', async mode=>{
  const id=videoId();
  const times=[1000,2000,3000,4000,5000,6000];
  const frames={videoId:id,frames:times.map(timestampMs=>({timestampMs,width:640,height:360,
    mimeType:'image/jpeg' as const,imageBase64:'/9j/AA=='})),failures:[],meta:{partial:false,warnings:[]}};
  const refs=await saveVideoResource(env,{kind:'frames',id,timestampsMs:times,maxWidth:640,extractionTimeoutMs:5000},frames,Date.now(),60000);
  await within(`frames-pin-${mode}`,async({store,backend,sql})=>{
    const original=backend.pin.bind(backend);
    let started=0;
    let release!:()=>void;
    let ready!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const entered=new Promise<void>(resolve=>{ready=resolve;});
    vi.spyOn(backend,'pin').mockImplementation(async(...args)=>{
      if (++started===6) ready();
      await gate;
      return original(...args);
    });
    const p={frames:async()=>({value:frames,cacheStatus:'miss',catalogVersions:refs})} as unknown as YouTubeAgentProvider;
    const controller=new AbortController();
    const pending=sessionProvider(p,store).frames!({videoId:id,timestampsMs:times,maxWidth:640},controller.signal);
    const rejected=expect(pending).rejects.toThrow(mode==='cancel'?'cancelled':'Session assets changed');
    await entered;
    if(mode==='cancel') controller.abort(new Error('cancelled')); else await store.delete();
    release();
    await rejected;
    expect(started).toBe(6);
    expect(store.brief().assets).toEqual([]);
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    expect(await catalog().readVersion(refs[0]!)).not.toBeNull();
  });
});

test('cancellation during frame extraction prevents subsequent session pins', async()=>{
  const id=videoId();
  await within('frames-extraction-cancel',async({store,backend})=>{
    const controller=new AbortController();
    const pin=vi.spyOn(backend,'pin');
    const p={frames:async()=>{
      controller.abort(new Error('cancelled'));
      return {value:{videoId:id,frames:[{timestampMs:1000,width:640,height:360,mimeType:'image/jpeg',imageBase64:'/9j/AA=='}],
        failures:[],meta:{partial:false,warnings:[]}},cacheStatus:'miss'};
    }} as unknown as YouTubeAgentProvider;
    await expect(sessionProvider(p,store).frames!({videoId:id,timestampsMs:[1000],maxWidth:640},controller.signal)).rejects.toThrow('cancelled');
    expect(pin).not.toHaveBeenCalled();
    expect(store.brief().assets).toEqual([]);
  });
});

test('session storyboard metadata and missing sheets retain the caller retrieval deadline', async () => {
  const id = videoId();
  const deadlineAt = Date.now() + 45_000;
  const board = { videoId: id, frameCount: 2, intervalMs: 10000,
    manifest: { totalSheets: 1, framesPerSheet: 2, tileWidth: 120, tileHeight: 90, columns: 2, rows: 1, lastSampleMs: 10000 },
    sheets: [], selection: { mode: 'metadata' as const }, meta: { partial: false, warnings: [] } };
  const images = { ...board, selection: { mode: 'indexes' as const, requestedSheetIndexes: [0] },
    sheets: [{ firstFrameIndex: 0, frameCount: 2, intervalMs: 10000, tileWidth: 120, tileHeight: 90,
      columns: 2, rows: 1, imageBase64: '/9j/AA==' }] };
  const manifestRefs = await saveVideoResource(env, { kind: 'storyboard', id, metadataOnly: true }, board, Date.now(), 60000);
  const sheetRefs = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, images, Date.now(), 60000);
  await within('storyboard-retrieval-deadline', async ({ store }) => {
    const upstream = vi.fn<NonNullable<YouTubeAgentProvider['storyboard']>>(async (_id, _times, options) => {
      expect(options?.deadlineAt).toBe(deadlineAt);
      return options?.metadataOnly
        ? { value: board, cacheStatus: 'hit', catalogVersions: manifestRefs }
        : { value: images, cacheStatus: 'hit', catalogVersions: [...manifestRefs, ...sheetRefs] };
    });
    const p = sessionProvider({ storyboard: upstream } as unknown as YouTubeAgentProvider, store);
    await p.storyboard!(id, undefined, { metadataOnly: true, deadlineAt });
    await p.storyboard!(id, undefined, { sheetIndexes: [0], maxSheets: 1, deadlineAt });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

test('a completed coordinator save attaches frames without downloading them again and restores from storage', async () => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId();
  const request = {videoId:id,timestampsMs:[1000,2000],maxWidth:640};
  const value = {videoId:id,frames:request.timestampsMs.map(timestampMs=>({timestampMs,width:640,height:360,
    mimeType:'image/jpeg' as const,imageBase64:'/9j/AA=='})),failures:[],meta:{partial:false,warnings:[]}};
  let published = false;
  const getOrLoad = vi.fn(async () => {
    const versions = await saveVideoResource(configured,{kind:'frames',id,...request,extractionTimeoutMs:5000},value,Date.now(),60000);
    published = true;
    return JSON.stringify({ok:true,value,cacheStatus:'miss',catalogVersions:versions,fetchedAt:Date.now()});
  });
  const configured = {...env,YOUTUBE_FRAMES_BACKEND:'media',YOUTUBE_REQUEST_COORDINATOR:{getByName:()=>({getOrLoad})}} as unknown as Env;
  await within('frame-receipt',async({store})=>{
    const read = vi.spyOn(VideoCatalog.prototype,'readVersion');
    try {
      const result = await sessionProvider(createYouTubeAgentProvider(configured),store).frames!(request);
      expect(published).toBe(true);
      expect(result.assetVersions).toHaveLength(2);
      expect(result.verifiedImages).toHaveLength(2);
      expect(read).not.toHaveBeenCalled();
      const restored = await store.lookup(`frame:${id}:640:1000`);
      expect(restored?.value).toMatchObject({frames:[value.frames[0]]});
      expect(read).toHaveBeenCalledOnce();
      expect(restored?.verifiedImages).toHaveLength(1);
      const { saveFramePreviews, framePreviewKey } = await import('../src/agents/runtime/frame-previews');
      const { agentFramePreviewRoutes } = await import('../src/routes/agent/frame-previews');
      const preview = (await saveFramePreviews(env.RESEARCH, 'inline-owner', result.value, new AbortController().signal, env.VIDEO_ASSETS, result.verifiedImages))[0]!;
      const previewPath = `/agent/frames/${preview.collectionId}/${preview.assetId}`;
      expect((await agentFramePreviewRoutes.request(previewPath, {}, env)).status).toBe(200);
      const repeated = await sessionProvider(createYouTubeAgentProvider(configured),store).frames!(request);
      expect(repeated.sessionReused).toBe(true);
      const reusedPreview = (await saveFramePreviews(env.RESEARCH, 'inline-owner', repeated.value, new AbortController().signal, env.VIDEO_ASSETS, repeated.verifiedImages))[0]!;
      expect((await agentFramePreviewRoutes.request(`/agent/frames/${reusedPreview.collectionId}/${reusedPreview.assetId}`, {}, env)).status).toBe(200);
      await env.RESEARCH.delete(framePreviewKey(preview.collectionId,preview.assetId));
      expect((await env.RESEARCH.get(framePreviewKey(preview.collectionId,preview.assetId)))).toBeNull();
      expect(getOrLoad).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); }
  });
});

test.each(['serialized','changed-bytes','changed-version','different-bucket'])('a %s receipt cannot bypass catalog verification', async mode => {
  const { VerifiedFrame } = await import('../src/lib/verified-frame');
  const { videoImageKey } = await import('../src/lib/video-catalog');
  const id = videoId(), frame = {timestampMs:1000,width:640,height:360,mimeType:'image/jpeg' as const,imageBase64:'/9j/AA=='};
  const value = {videoId:id,frames:[frame],failures:[],meta:{partial:false,warnings:[]}};
  const versions = await saveVideoResource(env,{kind:'frames',id,timestampsMs:[1000],maxWidth:640,extractionTimeoutMs:5000},value,Date.now(),60000);
  const key = await videoImageKey(id,Uint8Array.from(atob(frame.imageBase64),c=>c.charCodeAt(0)));
  const receipt = new VerifiedFrame(mode==='different-bucket'? {} as R2Bucket : env.VIDEO_ASSETS,versions[0]!,frame,key);
  const supplied = mode==='serialized' ? JSON.parse(JSON.stringify(receipt)) : receipt;
  const changed = mode==='changed-bytes' ? {...value,frames:[{...frame,imageBase64:'/9j/AQ=='}]} : value;
  const refs = mode==='changed-version' ? [{...versions[0]!,contentHash:'a'.repeat(64)}] : versions;
  const read = vi.spyOn(VideoCatalog.prototype,'readVersion');
  try {
    const pin = new SessionCatalog(env).pin('frame',id,`frame:${id}:640:1000`,changed,Date.now(),refs,undefined,{ frames: [supplied] });
    if (mode==='changed-bytes'||mode==='changed-version') await expect(pin).rejects.toThrow('does not match');
    else await expect(pin).resolves.toMatchObject({asset:versions[0]});
    expect(read).toHaveBeenCalledOnce();
  } finally { read.mockRestore(); }
});

test.each(['refresh', 'width-alias', 'rollback'] as const)('inline frame previews survive %s in the same session', async mode => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const { saveFramePreviews } = await import('../src/agents/runtime/frame-previews');
  const { agentFramePreviewRoutes } = await import('../src/routes/agent/frame-previews');
  const { videoImageKey } = await import('../src/lib/video-catalog');
  const id = videoId(), at = Date.now();
  const request = { videoId: id, timestampsMs: [1000], maxWidth: 640 };
  const frame = { timestampMs: 1000, width: 320, height: 180, mimeType: 'image/jpeg' as const, imageBase64: '/9j/AA==' };
  const value = { videoId: id, frames: [frame], failures: [], meta: { partial: false, warnings: [] } };
  const versions = await saveVideoResource({ ...env, YOUTUBE_FRAMES_BACKEND: 'media' },
    { kind: 'frames', id, ...request, extractionTimeoutMs: 5000 }, value, at, 60000);
  const getOrLoad = vi.fn(async () => JSON.stringify({ ok: true, value, cacheStatus: 'miss', catalogVersions: versions, fetchedAt: at }));
  const configured = { ...env, YOUTUBE_FRAMES_BACKEND: 'media', YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  await within(`inline-alias-${mode}`, async ({ store, reopen }) => {
    const first = await sessionProvider(createYouTubeAgentProvider(configured), store).frames!(request);
    expect(await env.VIDEO_ASSETS.head(await videoImageKey(id, Uint8Array.from(atob(frame.imageBase64), c => c.charCodeAt(0))))).toBeNull();
    const nextRequest = mode === 'width-alias' ? { ...request, maxWidth: 1280 } : request;
    if (mode === 'width-alias') {
      const wider = await saveVideoResource(configured, { kind: 'frames', id, ...nextRequest, extractionTimeoutMs: 5000 }, value, at, 60000);
      getOrLoad.mockResolvedValue(JSON.stringify({ ok: true, value, cacheStatus: 'miss', catalogVersions: wider, fetchedAt: at }));
    }
    const backend = (mode === 'rollback' ? { ...configured, YOUTUBE_FRAMES_BACKEND: 'container' } : configured) as Env;
    const next = await sessionProvider(createYouTubeAgentProvider(backend), mode === 'rollback' ? reopen() : store)
      .frames!(nextRequest, undefined, mode === 'refresh' ? { refresh: true, extractionTimeoutMs: 5000 } : undefined);
    expect(next.assetVersions).toEqual(first.assetVersions);
    const previews = await saveFramePreviews(env.RESEARCH, 'inline-alias-owner', next.value,
      new AbortController().signal, env.VIDEO_ASSETS, next.verifiedImages);
    const response = await agentFramePreviewRoutes.request(`/agent/frames/${previews[0]!.collectionId}/${previews[0]!.assetId}`, {}, env);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from(atob(frame.imageBase64), c => c.charCodeAt(0)));
    expect(getOrLoad).toHaveBeenCalledTimes(mode === 'rollback' ? 1 : 2);
  });
});

test('completed storyboard saves avoid sheet readback and restored previews avoid extra HEAD requests', async () => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const { storyboardMetadata } = await import('../src/agents/providers/youtube/storyboard');
  const { saveStoryboardPreviews } = await import('../src/agents/runtime/storyboard-previews');
  const { captureVisualWork } = await import('../src/lib/visual-diagnostics');
  const id = videoId();
  const board = { videoId: id, frameCount: 12, intervalMs: 10000,
    manifest: { totalSheets: 6, framesPerSheet: 2, tileWidth: 120, tileHeight: 90, columns: 2, rows: 1, lastSampleMs: 110000 },
    selection: { mode: 'spread' as const }, meta: { partial: false, warnings: [] },
    sheets: Array.from({ length: 6 }, (_, index) => ({ firstFrameIndex: index * 2, frameCount: 2,
      intervalMs: 10000, tileWidth: 120, tileHeight: 90, columns: 2, rows: 1, imageBase64: '/9j/AA==' })) };
  const getOrLoad = vi.fn(async () => {
    const manifest = await saveVideoResource(env, { kind: 'storyboard', id, metadataOnly: true }, storyboardMetadata(board), Date.now(), 60000);
    const sheets = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 6 }, board, Date.now(), 60000);
    return JSON.stringify({ ok: true, value: board, cacheStatus: 'miss', catalogVersions: [...manifest, ...sheets], fetchedAt: Date.now() });
  });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  await within('storyboard-save-receipts', async ({ store, reopen }) => {
    const p = createYouTubeAgentProvider(configured);
    const preview = async (result: Awaited<ReturnType<NonNullable<YouTubeAgentProvider['storyboard']>>>) => {
      expect(result.verifiedImages).toHaveLength(6);
      expect(await saveStoryboardPreviews(env.RESEARCH, 'receipt-owner', result.value,
        new AbortController().signal, env.VIDEO_ASSETS, result.verifiedImages)).toHaveLength(6);
    };
    const cold = await captureVisualWork('tool', 'storyboard', async () => {
      const result = await sessionProvider(p, store).storyboard!(id, undefined, { maxSheets: 6 });
      expect(result.assetVersions).toHaveLength(7);
      await preview(result);
      return result;
    });
    expect(cold.diagnostics.counters.catalogR2Gets).toBe(1); // Manifest only, no sheet JSON/JPEG readback.
    expect(cold.diagnostics.counters.previewR2Heads ?? 0).toBe(0);
    const warm = await captureVisualWork('tool', 'storyboard', async () => {
      const result = await sessionProvider(p, reopen()).storyboard!(id, undefined, { maxSheets: 6 });
      expect(result.sessionReused).toBe(true);
      await preview(result);
      return result;
    });
    expect(warm.value.value.sheets).toEqual(cold.value.value.sheets);
    expect(warm.diagnostics.counters.catalogR2Gets).toBe(13); // Verify persisted bytes after restoring.
    expect(warm.diagnostics.counters.previewR2Heads ?? 0).toBe(0);
    const fallback = await captureVisualWork('tool', 'storyboard', () => saveStoryboardPreviews(
      env.RESEARCH, 'fallback-owner', cold.value.value, new AbortController().signal, env.VIDEO_ASSETS));
    expect(fallback.diagnostics.counters.previewR2Heads).toBe(6);
    expect(getOrLoad).toHaveBeenCalledOnce();
  });
});

function receiptStoryboard(id: string) {
  return { videoId: id, frameCount: 2, intervalMs: 10000,
    manifest: { totalSheets: 1, framesPerSheet: 2, tileWidth: 120, tileHeight: 90, columns: 2, rows: 1, lastSampleMs: 10000 },
    selection: { mode: 'indexes' as const, requestedSheetIndexes: [0] }, meta: { partial: false, warnings: [] as string[] },
    sheets: [{ firstFrameIndex: 0, frameCount: 2, intervalMs: 10000, tileWidth: 120, tileHeight: 90,
      columns: 2, rows: 1, imageBase64: '/9j/AA==' }] };
}

test.each(['serialized', 'changed-bytes', 'changed-version', 'different-bucket', 'changed-mapping', 'extra-field'] as const)(
  'a storyboard %s receipt cannot bypass storage verification', async mode => {
    const { VerifiedStoryboardSheet } = await import('../src/lib/verified-storyboard');
    const { videoImageKey } = await import('../src/lib/video-catalog');
    const id = videoId(), board = receiptStoryboard(id);
    const versions = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, board, Date.now(), 60000);
    const imageKey = await videoImageKey(id, Uint8Array.from(atob(board.sheets[0]!.imageBase64), c => c.charCodeAt(0)));
    const receipt = new VerifiedStoryboardSheet(mode === 'different-bucket' ? {} as R2Bucket : env.VIDEO_ASSETS,
      versions[0]!, board, imageKey);
    const supplied = mode === 'serialized' ? JSON.parse(JSON.stringify(receipt)) : receipt;
    if (mode === 'changed-bytes') board.sheets[0]!.imageBase64 = '/9j/AQ==';
    if (mode === 'changed-version') versions[0]!.contentHash = 'f'.repeat(64);
    if (mode === 'changed-mapping') board.manifest.lastSampleMs += 10000;
    const value = mode === 'extra-field' ? { ...board, unexpected: 'must not be trusted' } : board;
    const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
    try {
      const pending = new SessionCatalog(env).pin('storyboard_sheet', id, 'unused', value, Date.now(), versions,
        undefined, { storyboards: [supplied] });
      if (mode === 'serialized' || mode === 'different-bucket') await expect(pending).resolves.toBeDefined();
      else await expect(pending).rejects.toThrow('does not match');
      expect(read).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); }
  });

test('storyboard receipts allow envelope changes but keep images and mapping out of session SQLite', async () => {
  const { VerifiedStoryboardSheet } = await import('../src/lib/verified-storyboard');
  const id = videoId(), board = receiptStoryboard(id);
  const versions = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, board, Date.now(), 60000);
  const receipt = new VerifiedStoryboardSheet(env.VIDEO_ASSETS, versions[0]!, board, 'unused');
  const value = { ...board, selection: undefined, meta: { partial: true, warnings: ['Another sheet failed'] }, freshness: { state: 'fresh' } };
  const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
  try {
    const backend = new SessionCatalog(env);
    const reference = await backend.pin('storyboard_sheet', id, 'unused', value, Date.now(), versions, undefined, { storyboards: [receipt] });
    expect(read).not.toHaveBeenCalled();
    expect(reference.overrides).toEqual({ meta: value.meta, freshness: value.freshness });
    expect(reference.omitted).toEqual(['selection']);
    expect(await backend.read(reference)).toEqual(value);
    await expect(backend.pin('storyboard_sheet', id, 'unused', { ...value, meta: { warnings: ['x'.repeat(32001)] } },
      Date.now(), versions, undefined, { storyboards: [receipt] })).rejects.toThrow('does not match');
  } finally { read.mockRestore(); }
});

test.each(['hit', 'coalesced', 'stale', 'missing-reference'] as const)('storyboard %s results retain independent verification', async mode => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const { storyboardMetadata } = await import('../src/agents/providers/youtube/storyboard');
  const id = videoId(), value = receiptStoryboard(id);
  const manifest = await saveVideoResource(env, { kind: 'storyboard', id, metadataOnly: true }, storyboardMetadata(value), Date.now(), 60000);
  const sheets = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, value, Date.now(), 60000);
  const getOrLoad = async () => JSON.stringify({ ok: true, value, cacheStatus: mode === 'missing-reference' ? 'miss' : mode,
    catalogVersions: mode === 'missing-reference' ? undefined : [...manifest, ...sheets], fetchedAt: Date.now() });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const result = await createYouTubeAgentProvider(configured).storyboard!(id);
  expect(result.verifiedStoryboards ?? []).toHaveLength(0);
  await within(`storyboard-unverified-${mode}`, async ({ store }) => {
    const p = { storyboard: async () => result } as unknown as YouTubeAgentProvider;
    const attached = await sessionProvider(p, store).storyboard!(id, undefined, { maxSheets: 1 });
    expect(attached.assetVersions).toHaveLength(2);
    expect(attached.verifiedImages).toHaveLength(1);
  });
});

test.each(['delete', 'cancel', 'save-failure'] as const)('storyboard %s cannot attach coordinator save receipts', async mode => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const { storyboardMetadata } = await import('../src/agents/providers/youtube/storyboard');
  const id = videoId(), value = receiptStoryboard(id);
  await within(`storyboard-receipt-${mode}`, async ({ store, sql }) => {
    let entered!: () => void, release!: () => void;
    const published = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const getOrLoad = async () => {
      const manifest = await saveVideoResource(env, { kind: 'storyboard', id, metadataOnly: true }, storyboardMetadata(value), Date.now(), 60000);
      const sheets = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, value, Date.now(), 60000);
      entered();
      await gate;
      return JSON.stringify(mode === 'save-failure'
        ? { ok: false, error: { code: 'STORAGE_FAILURE', message: 'save failed', apiStatus: 503 } }
        : { ok: true, value, cacheStatus: 'miss', catalogVersions: [...manifest, ...sheets], fetchedAt: Date.now() });
    };
    const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
    const controller = new AbortController();
    const pending = sessionProvider(createYouTubeAgentProvider(configured), store).storyboard!(id, undefined, { maxSheets: 1, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(mode === 'delete' ? 'Session assets changed' : mode === 'cancel' ? 'cancelled' : 'save failed');
    await published;
    if (mode === 'delete') await store.delete();
    if (mode === 'cancel') controller.abort(new Error('cancelled'));
    release();
    await rejected;
    expect(sql.exec('SELECT * FROM session_asset_catalog_refs').toArray()).toEqual([]);
    expect(store.brief().assets).toEqual([]);
  });
});

test('a coordinator payload must match its stored hash before it can receive a storyboard receipt', async () => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId(), stored = receiptStoryboard(id);
  const versions = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, stored, Date.now(), 60000);
  const changed = structuredClone(stored);
  changed.sheets[0]!.imageBase64 = '/9j/AQ==';
  const getOrLoad = async () => JSON.stringify({ ok: true, value: changed, cacheStatus: 'miss', catalogVersions: versions, fetchedAt: Date.now() });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const result = await createYouTubeAgentProvider(configured).storyboard!(id);
  expect(result.verifiedStoryboards ?? []).toHaveLength(0);
  await expect(new SessionCatalog(env).pin('storyboard_sheet', id, 'unused', result.value, Date.now(), versions,
    undefined, { storyboards: result.verifiedStoryboards })).rejects.toThrow('does not match');
});

test.each(['storyboard', 'frame'] as const)('large unchanged %s metadata must remain attachable with a receipt', async kind => {
  const { VerifiedStoryboardSheet } = await import('../src/lib/verified-storyboard');
  const { VerifiedFrame } = await import('../src/lib/verified-frame');
  const id = videoId(), meta = { partial: false, warnings: ['x'.repeat(32001)] };
  const board = { ...receiptStoryboard(id), meta };
  const frame = { timestampMs: 1000, width: 640, height: 360, mimeType: 'image/jpeg' as const, imageBase64: '/9j/AA==' };
  const frames = { videoId: id, frames: [frame], meta, failures: [] };
  const value = kind === 'storyboard' ? board : frames;
  // The lower-level catalog can contain historical envelopes beyond today's frame schema limits.
  const versions = kind === 'storyboard'
    ? await saveVideoResource(env, { kind, id, maxSheets: 1 }, value, Date.now(), 60000)
    : [await catalog().save({ videoId: id, kind: 'frame', variant: 'v1:640:1000' }, value, Date.now(), 60000, true, {})];
  const receipt = kind === 'storyboard' ? new VerifiedStoryboardSheet(env.VIDEO_ASSETS, versions[0]!, board, 'unused')
    : new VerifiedFrame(env.VIDEO_ASSETS, versions[0]!, frame, 'unused');
  const backend = new SessionCatalog(env);
  const reference = await backend.pin(kind === 'storyboard' ? 'storyboard_sheet' : 'frame', id, 'unused', value, Date.now(), versions,
    undefined, { frames: receipt instanceof VerifiedFrame ? [receipt] : undefined, storyboards: receipt instanceof VerifiedStoryboardSheet ? [receipt] : undefined });
  expect(reference.overrides).toEqual({});
  expect(await backend.read(reference)).toEqual(value);
});

test('provider normalization drops unknown storyboard content while preserving freshness and provider metadata', async () => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId(), value = receiptStoryboard(id), at = Date.now();
  const versions = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, value, at, 60000);
  const getOrLoad = async () => JSON.stringify({ ok: true, value: { ...value, extra: 'ignored', sheets: value.sheets.map(s => ({ ...s, extra: 'ignored' })) },
    cacheStatus: 'miss', catalogVersions: versions, fetchedAt: at });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const result = await createYouTubeAgentProvider(configured).storyboard!(id);
  expect(result.value).not.toHaveProperty('extra');
  expect(result.value.sheets[0]).not.toHaveProperty('extra');
  expect(result.value).toMatchObject({ freshness: { state: 'fresh', fetchedAt: at }, meta: { source: 'video2ctx', provider: 'youtube' } });
  const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
  try {
    const backend = new SessionCatalog(env);
    const reference = await backend.pin('storyboard_sheet', id, 'unused', result.value, at, versions, undefined, { storyboards: result.verifiedStoryboards });
    expect(read).not.toHaveBeenCalled();
    expect(await backend.read(reference)).toEqual(result.value);
  } finally { read.mockRestore(); }
});

test.each([false, true])('partial-hit storyboard misses verify source hashes, differing warnings=%s', async differingWarnings => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const { storyboardMetadata } = await import('../src/agents/providers/youtube/storyboard');
  const { captureVisualWork } = await import('../src/lib/visual-diagnostics');
  const id = videoId(), one = receiptStoryboard(id);
  const board = { ...one, frameCount: 4, manifest: { ...one.manifest, totalSheets: 2, lastSampleMs: 30000 },
    sheets: [one.sheets[0]!, { ...one.sheets[0]!, firstFrameIndex: 2, imageBase64: '/9j/AQ==' }] };
  const old = { ...board, sheets: [board.sheets[0]!], meta: { partial: false, warnings: differingWarnings ? ['old warning'] : [] } };
  const manifestRefs = await saveVideoResource(env, { kind: 'storyboard', id, metadataOnly: true }, storyboardMetadata(board), Date.now(), 60000);
  const oldRefs = await saveVideoResource(env, { kind: 'storyboard', id, sheetIndexes: [0] }, old, Date.now(), 60000);
  const getOrLoad = vi.fn(async () => {
    const hit = await catalog().readVersion<typeof board>(oldRefs[0]!);
    expect(hit).not.toBeNull();
    const fresh = { ...board, sheets: [board.sheets[1]!], meta: { partial: false, warnings: differingWarnings ? ['new warning'] : [] } };
    const freshRefs = await saveVideoResource(env, { kind: 'storyboard', id, sheetIndexes: [1] }, fresh, Date.now(), 60000);
    const combined = { ...board, selection: { mode: 'spread' }, sheets: [...hit!.value.sheets, ...fresh.sheets],
      meta: { partial: false, warnings: [...hit!.value.meta.warnings, ...fresh.meta.warnings] } };
    return JSON.stringify({ ok: true, value: combined, cacheStatus: 'miss', catalogVersions: [...manifestRefs, ...oldRefs, ...freshRefs], fetchedAt: Date.now() });
  });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  // Coordinator work has its own production diagnostic scope. Count attachment separately.
  const fetched = await createYouTubeAgentProvider(configured).storyboard!(id, undefined, { maxSheets: 2 });
  expect(fetched.verifiedStoryboards).toHaveLength(differingWarnings ? 0 : 2);
  await within(`partial-storyboard-receipts-${differingWarnings}`, async ({ store, reopen }) => {
    const upstream = vi.fn(async () => fetched);
    const p = { storyboard: upstream } as unknown as YouTubeAgentProvider;
    const cold = await captureVisualWork('tool', 'storyboard', () => sessionProvider(p, store).storyboard!(id, undefined, { maxSheets: 2 }));
    expect(cold.diagnostics.counters.catalogR2Gets).toBe(differingWarnings ? 5 : 1);
    const warm = await sessionProvider(p, reopen()).storyboard!(id, undefined, { maxSheets: 2 });
    expect(warm.sessionReused).toBe(true);
    expect(warm.value.sheets).toEqual(cold.value.value.sheets);
    expect(warm.value.meta).toEqual(cold.value.value.meta);
    expect(upstream).toHaveBeenCalledOnce();
  });
});

test.each(['inline', 'non-hex', 'fractional-index'] as const)('provider rejects storyboard receipts for %s references or mappings', async mode => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId(), value = receiptStoryboard(id);
  const versions = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, value, Date.now(), 60000);
  if (mode === 'inline') versions[0]!.imageStorage = 'inline';
  if (mode === 'non-hex') versions[0]!.contentHash = 'z'.repeat(64);
  if (mode === 'fractional-index') Object.assign(value.sheets[0]!, { firstFrameIndex: 1, frameCount: 1 });
  const getOrLoad = async () => JSON.stringify({ ok: true, value, cacheStatus: 'miss', catalogVersions: versions, fetchedAt: Date.now() });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const result = await createYouTubeAgentProvider(configured).storyboard!(id);
  expect(result.verifiedStoryboards).toHaveLength(0);
});

test('storyboard receipt fallback can accept a large envelope identical to the stored version', async () => {
  const { VerifiedStoryboardSheet } = await import('../src/lib/verified-storyboard');
  const id = videoId(), board = receiptStoryboard(id);
  board.meta.warnings = ['x'.repeat(32001)];
  const versions = await saveVideoResource(env, { kind: 'storyboard', id, maxSheets: 1 }, board, Date.now(), 60000);
  // A stale receipt envelope cannot authorize a large override, but normal readback can verify it.
  const receipt = new VerifiedStoryboardSheet(env.VIDEO_ASSETS, versions[0]!, { ...board, meta: { partial: false, warnings: [] } }, 'unused');
  const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
  try {
    const reference = await new SessionCatalog(env).pin('storyboard_sheet', id, 'unused', board, Date.now(), versions, undefined, { storyboards: [receipt] });
    expect(read).toHaveBeenCalledOnce();
    expect(reference.overrides).toEqual({});
  } finally { read.mockRestore(); }
});

test('receipt serialization preserves existing split-image and inline-frame storage hashes', async () => {
  const { prepareVideoAssetContent, videoImageKey } = await import('../src/lib/video-catalog');
  const { sha256 } = await import('../src/lib/http');
  const id = videoId(), value = { z: 1, a: { imageBase64: '/9j/AA==' } };
  const imageKey = await videoImageKey(id, Uint8Array.from(atob(value.a.imageBase64), c => c.charCodeAt(0)));
  const key = { videoId: id, kind: 'storyboard_sheet', variant: 'compatibility' };
  const expected = JSON.stringify({ z: 1, a: { imageBase64: { r2Image: imageKey } } });
  const prepared = await prepareVideoAssetContent(key, value);
  expect(prepared.payload).toBe(expected); // Intentionally not alphabetized.
  expect(prepared.contentHash).toBe(await sha256(expected));
  const saved = await catalog().save(key, value, Date.now(), 60000, true, {});
  expect(saved.contentHash).toBe(prepared.contentHash);
  const object = await env.VIDEO_ASSETS.get(`youtube/videos/${id}/${key.kind}/${await sha256(key.variant)}/${saved.contentHash}.json`);
  expect(await object!.text()).toBe(expected);
  const frameKey = { ...key, kind: 'frame' }, frameValue = { videoId: id, frames: [{ imageBase64: '/9j/AA==' }] };
  const inline = await prepareVideoAssetContent(frameKey, frameValue, true);
  expect(inline.payload).toBe(JSON.stringify(frameValue));
  expect(inline.contentHash).toBe(await sha256(JSON.stringify(frameValue)));
  expect(inline.images).toHaveLength(0);
});

test.each([['transcript', false], ['transcript', true], ['comments', false], ['comments', true]] as const)('completed %s saves skip attachment readback, refresh=%s', async (kind, refresh) => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId();
  const value = kind === 'transcript' ? transcript(id) : {
    videoId: id, comments: [{ id: 'comment-1', text: 'A useful public comment',
      author: { name: 'Viewer', thumbnails: [] }, isPinned: false, isHearted: false, replies: [] }],
    meta: transcript(id).meta,
  };
  const operation = kind === 'transcript' ? { kind, id, granularity: 'word' as const } : { kind, id };
  const getOrLoad = vi.fn(async () => {
    const catalogVersions = await saveVideoResource(env, operation, value, Date.now(), 60000);
    return JSON.stringify({ ok: true, value, cacheStatus: 'miss', catalogVersions, fetchedAt: Date.now() });
  });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  await within(`text-save-receipts-${kind}-${refresh}`, async ({ store, reopen }) => {
    const upstream = createYouTubeAgentProvider(configured);
    const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
    try {
      const p = sessionProvider(upstream, store);
      const cold = kind === 'transcript' ? await p.transcript(id, undefined, { refresh })
        : await p.comments(id, { refresh });
      expect(cold.assetVersions).toHaveLength(1);
      expect(read).not.toHaveBeenCalled();
      const restored = sessionProvider(upstream, reopen());
      const warm = kind === 'transcript' ? await restored.transcript(id) : await restored.comments(id);
      expect(warm.sessionReused).toBe(true);
      expect(warm.value).toEqual(cold.value);
      expect(read).toHaveBeenCalledOnce();
      expect(getOrLoad).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); }
  });
});

test.each(['hit', 'coalesced', 'stale'] as const)('text %s responses keep independent attachment verification', async cacheStatus => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId(), value = transcript(id);
  const catalogVersions = await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, value, Date.now(), 60000);
  const getOrLoad = async () => JSON.stringify({ ok: true, value, cacheStatus, catalogVersions, fetchedAt: Date.now() });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  await within(`text-status-${cacheStatus}`, async ({ store }) => {
    const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
    try {
      const result = await sessionProvider(createYouTubeAgentProvider(configured), store).transcript(id, undefined, { refresh: true });
      expect(result.verifiedTextSource).toBeUndefined();
      expect(read).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); }
  });
});

test.each(['transcript', 'comments'] as const)('a changed coordinator %s payload cannot authorize the fast path', async kind => {
  const { createYouTubeAgentProvider } = await import('../src/agents/providers/youtube/provider');
  const id = videoId(), value = kind === 'transcript' ? transcript(id) : { videoId: id, comments: [], meta: transcript(id).meta };
  const operation = kind === 'transcript' ? { kind, id, granularity: 'word' as const } : { kind, id };
  const catalogVersions = await saveVideoResource(env, operation, value, Date.now(), 60000);
  const changed = { ...value, unexpected: 'Coordinator differs from completed storage' };
  const getOrLoad = async () => JSON.stringify({ ok: true, value: changed, cacheStatus: 'miss', catalogVersions, fetchedAt: Date.now() });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const p = createYouTubeAgentProvider(configured);
  const result = kind === 'transcript' ? await p.transcript(id, undefined, { refresh: true }) : await p.comments(id, { refresh: true });
  expect(result.verifiedTextSource).toBeUndefined();
  const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
  try {
    await expect(new SessionCatalog(env).pin(kind, id, 'unused', result.value, Date.now(), result.catalogVersions,
      undefined, { text: result.verifiedTextSource })).rejects.toThrow('does not match');
    expect(read).toHaveBeenCalledOnce();
  } finally { read.mockRestore(); }
});

test.each(['serialized', 'different-bucket', 'changed-payload', 'changed-reference'] as const)(
  'a text receipt with %s cannot bypass storage verification', async mode => {
    const { VerifiedTextSource } = await import('../src/lib/verified-text-source');
    const id = videoId(), value = transcript(id);
    const key = videoResourceKey({ kind: 'transcript', id, granularity: 'word' })!;
    const versions = await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, value, Date.now(), 60000);
    const receipt = await VerifiedTextSource.fromPersisted(mode === 'different-bucket' ? {} as R2Bucket : env.VIDEO_ASSETS,
      key, versions[0]!, value);
    expect(receipt).toBeDefined();
    const supplied = mode === 'serialized' ? JSON.parse(JSON.stringify(receipt)) : receipt;
    if (mode === 'changed-payload') value.segments[0]!.text = 'Changed after receipt';
    if (mode === 'changed-reference') versions[0]!.contentHash = 'f'.repeat(64);
    const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
    try {
      const pending = new SessionCatalog(env).pin('transcript', id, 'unused', value, Date.now(), versions,
        undefined, { text: supplied });
      if (mode === 'changed-payload' || mode === 'changed-reference') await expect(pending).rejects.toThrow('does not match');
      else await expect(pending).resolves.toBeDefined();
      expect(read).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); }
  });

test.each(['video', 'kind', 'variant', 'inline', 'non-hex', 'missing', 'multiple'] as const)(
  'text receipt issuance rejects %s catalog references', async mode => {
    const { getVideoResource } = await import('../src/lib/youtube');
    const id = videoId(), value = transcript(id), operation = { kind: 'transcript' as const, id, granularity: 'word' as const };
    let catalogVersions = await saveVideoResource(env, operation, value, Date.now(), 60000);
    if (mode === 'video') catalogVersions[0]!.videoId = videoId();
    if (mode === 'kind') catalogVersions[0]!.kind = 'comments';
    if (mode === 'variant') catalogVersions[0]!.variant = '{"language":"fr","granularity":"word"}';
    if (mode === 'inline') catalogVersions[0]!.imageStorage = 'inline';
    if (mode === 'non-hex') catalogVersions[0]!.contentHash = 'z'.repeat(64);
    if (mode === 'missing') catalogVersions = [];
    if (mode === 'multiple') catalogVersions.push(catalogVersions[0]!);
    const getOrLoad = async () => JSON.stringify({ ok: true, value, cacheStatus: 'miss', catalogVersions, fetchedAt: Date.now() });
    const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
    expect((await getVideoResource(configured, operation, true, undefined, true)).verifiedTextSource).toBeUndefined();
  });

test('public text retrieval avoids receipt work and language, continuation, and all-comments variants remain bound', async () => {
  const { getVideoResource, getTranscriptWithCache, getCommentsWithCache, getAllCommentsWithCache } = await import('../src/lib/youtube');
  const id = videoId();
  const getOrLoad = vi.fn(async (wire: string) => {
    const { operation } = JSON.parse(wire);
    const value = operation.kind === 'transcript' ? { ...transcript(id), translatedTo: { languageCode: 'fr', languageName: 'French' } }
      : { videoId: id, comments: [], complete: true, continuation: 'next-page', meta: transcript(id).meta };
    const catalogVersions = await saveVideoResource(env, operation, value, Date.now(), 60000);
    return JSON.stringify({ ok: true, value, cacheStatus: 'miss', catalogVersions, fetchedAt: Date.now() });
  });
  const configured = { ...env, YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const publicResult = await getVideoResource(configured, { kind: 'transcript', id, granularity: 'word' }, true);
  expect(publicResult.verifiedTextSource).toBeUndefined();
  const results = [
    await getTranscriptWithCache(configured, id, 'fr', undefined, true, Date.now() + 60000, true),
    await getCommentsWithCache(configured, id, 'page-token', true, true),
    await getAllCommentsWithCache(configured, id, true, true),
  ];
  const read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
  try {
    for (const result of results) {
      expect(result.verifiedTextSource).toBeDefined();
      const ref = result.catalogVersions![0]!;
      const backend = new SessionCatalog(env);
      const pinned = await backend.pin(ref.kind === 'transcript' ? 'transcript' : 'comments', id, 'unused', result.value,
        Date.now(), [ref], undefined, { text: result.verifiedTextSource });
      expect(read).not.toHaveBeenCalled();
      expect(await backend.read(pinned)).toEqual(result.value);
      read.mockClear();
    }
    expect(results.map(r => r.catalogVersions![0]!.variant)).toEqual([
      '{"language":"fr","granularity":"word"}', '{"continuation":"page-token"}', '{"maxPages":5}',
    ]);
  } finally { read.mockRestore(); }
});

test('text receipts preserve envelope projection limits and keep large source metadata out of SQLite', async () => {
  const { VerifiedTextSource } = await import('../src/lib/verified-text-source');
  const id = videoId(), value = transcript(id);
  value.meta.warnings = ['x'.repeat(33000)];
  const key = videoResourceKey({ kind: 'transcript', id, granularity: 'word' })!;
  const versions = await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, value, Date.now(), 60000);
  const receipt = await VerifiedTextSource.fromPersisted(env.VIDEO_ASSETS, key, versions[0]!, value);
  const backend = new SessionCatalog(env), read = vi.spyOn(VideoCatalog.prototype, 'readVersion');
  try {
    const pinned = await backend.pin('transcript', id, 'unused', { ...value, freshness: { state: 'fresh' } }, Date.now(), versions,
      undefined, { text: receipt });
    expect(pinned.overrides).toEqual({ freshness: { state: 'fresh' } });
    expect(read).not.toHaveBeenCalled();
    const changed = { ...value, meta: { ...value.meta, warnings: ['y'.repeat(33000)] } };
    await expect(backend.pin('transcript', id, 'unused', changed, Date.now(), versions,
      undefined, { text: receipt })).rejects.toThrow('does not match');
    expect(read).toHaveBeenCalledOnce();
  } finally { read.mockRestore(); }
});

test.each(['cancel', 'delete'] as const)('a verified text save cannot restore evidence after %s', async mode => {
  const { VerifiedTextSource } = await import('../src/lib/verified-text-source');
  const id = videoId(), value = transcript(id);
  const key = videoResourceKey({ kind: 'transcript', id, granularity: 'word' })!;
  const versions = await saveVideoResource(env, { kind: 'transcript', id, granularity: 'word' }, value, Date.now(), 60000);
  const receipt = await VerifiedTextSource.fromPersisted(env.VIDEO_ASSETS, key, versions[0]!, value);
  await within(`text-receipt-${mode}`, async ({ store }) => {
    const controller = new AbortController();
    await expect(store.retrieve(`transcript:${id}:default`, 'transcript', id, true, async () => {
      if (mode === 'cancel') controller.abort(new Error('cancelled'));
      else await store.delete();
      return { value, cacheStatus: 'miss', catalogVersions: versions, verifiedTextSource: receipt };
    }, () => ({}), undefined, controller.signal)).rejects.toThrow(mode === 'cancel' ? 'cancelled' : 'Session assets changed');
    expect(store.brief().assets).toEqual([]);
  });
});
