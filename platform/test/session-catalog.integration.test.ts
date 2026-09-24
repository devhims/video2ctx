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

test('legacy backfill preserves citation identities, retires the private copy and keeps the newer public pointer', async () => {
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
    expect(await env.RESEARCH.get(blob)).toBeNull();
    expect((await env.RESEARCH.list({ prefix })).objects).toEqual([]);
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
    expect(await env.RESEARCH.get(blob)).toBeNull();
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
    expect(upstream.storyboard).toHaveBeenCalledTimes(2);
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
