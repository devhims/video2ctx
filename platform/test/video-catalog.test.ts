import { captureVisualWork } from '../src/lib/visual-diagnostics';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { VideoCatalog } from '../src/lib/video-catalog';
import {
  readVideoResource,
  saveVideoResource,
  loadVideoResource,
  videoResourceKey,
} from '../src/lib/video-resources';
import { YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';
import { getTranscriptWithCache, getVideoResource } from '../src/lib/youtube';
import { runYouTubeOperation } from '../src/lib/youtube-processor-client';
import { getVideoFrames } from '../src/lib/youtube-frames';
import type { Storyboard } from '../src/agents/providers/youtube/storyboard';

vi.mock('../src/lib/youtube-processor-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/youtube-processor-client')>()),
  runYouTubeOperation: vi.fn(),
}));
vi.mock('../src/lib/youtube-frames', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/youtube-frames')>()),
  getVideoFrames: vi.fn(),
}));

// Execute the actual catalog SQL in SQLite, including uniqueness, transactions,
// foreign keys and query plans. R2 is an in-memory object transport.
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(
    readFileSync(new URL('../video-catalog-migrations/0001_video_catalog.sql', import.meta.url), 'utf8'),
  );
  sql.exec(readFileSync(new URL('../video-catalog-migrations/0003_historical_asset_versions.sql', import.meta.url), 'utf8'));
  let failCommit = false;
  const queries: string[] = [];
  const batches: string[][] = [];
  const sqlStatements = new WeakMap<D1PreparedStatement, { query: string; params: (string | number | null)[] }>();
  function prepare(query: string, params: (string | number | null)[] = []): D1PreparedStatement {
    const statement = {
      bind: (...values: (string | number | null)[]) => prepare(query, values),
      first: async () => { queries.push(query); return sql.prepare(query).get(...params) ?? null; },
      all: async () => { queries.push(query); return { success: true, results: sql.prepare(query).all(...params) }; },
      run: async () => {
        queries.push(query);
        sql.prepare(query).run(...params);
        return { success: true };
      },
    } as D1PreparedStatement;
    sqlStatements.set(statement, { query, params });
    return statement;
  }
  const db = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      const batchQueries = statements.map(statement => sqlStatements.get(statement)!.query);
      batches.push(batchQueries);
      queries.push(...batchQueries);
      if (failCommit && statements.some(statement => sqlStatements.get(statement)!.query.includes("SET state='ready'"))) throw new Error('simulated database outage');
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          const { query, params } = sqlStatements.get(statement)!;
          const resultsRows = sql.prepare(query).all(...params);
          results.push({ success: true, results: resultsRows });
        }
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as D1Database;
  const objects = new Map<string, Uint8Array>();
  let failPut = false;
  const bucket = {
    put: vi.fn(async (key: string, value: string | Uint8Array) => {
      if (failPut) throw new Error('simulated R2 outage');
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
      return {};
    }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    }),
  } as unknown as R2Bucket;
  const kv = { get: vi.fn(async (): Promise<unknown> => null), put: vi.fn() };
  const env = { VIDEO_CATALOG: db, VIDEO_ASSETS: bucket, YOUTUBE_CACHE: kv } as unknown as Env;
  return {
    sql,
    queries,
    batches,
    db,
    bucket,
    objects,
    env,
    kv,
    store: new VideoCatalog(db, bucket),
    failCommit: (value: boolean) => {
      failCommit = value;
    },
    failPut: (value: boolean) => {
      failPut = value;
    },
  };
}
const id = 'abcdefghijk';
const transcriptOp = { kind: 'transcript', id, lang: 'en', granularity: 'word' } as const;
const transcript = (text = 'Hello', partial = false) => ({
  segments: [{ text, startMs: 0, endMs: 1000 }],
  track: { id: 'en', languageCode: 'en' },
  meta: { partial, warnings: [] },
});
const request = {
  cacheKey: 'test-transcript',
  resourceType: 'transcript-v5',
  maxAgeMs: 60_000,
  operation: transcriptOp,
};
const jpeg = '/9j/AA==';
function storyboard(indexes: number[] = []): Storyboard {
  return {
    videoId: id,
    intervalMs: 10_000,
    frameCount: 6,
    manifest: {
      totalSheets: 3,
      framesPerSheet: 2,
      tileWidth: 120,
      tileHeight: 90,
      columns: 2,
      rows: 1,
      lastSampleMs: 50_000,
    },
    selection: indexes.length ? { mode: 'indexes', requestedSheetIndexes: indexes } : { mode: 'metadata' },
    sheets: indexes.map((index) => ({
      tileWidth: 120,
      tileHeight: 90,
      columns: 2,
      rows: 1,
      firstFrameIndex: index * 2,
      frameCount: 2,
      intervalMs: 10_000,
      imageBase64: jpeg,
    })),
    meta: { partial: false, warnings: [] },
  };
}
const frame = (timestampMs: number) => ({
  timestampMs,
  width: 640,
  height: 360,
  mimeType: 'image/jpeg' as const,
  imageBase64: jpeg,
});
beforeEach(() => vi.clearAllMocks());

test('metadata migration preserves R2 references and version history, with legacy read compatibility', async () => {
  const f = fixture();
  const key = { videoId: id, kind: 'video', variant: '{}' };
  const value = { id, title: 'Video details' };
  await f.store.save(key, value, Date.now(), 60_000, true);
  const before = (await f.store.inventory(id)).results[0]!;
  expect(await readVideoResource(f.env, { kind: 'video', id })).toMatchObject({ value });

  f.sql.exec(readFileSync(new URL('../video-catalog-migrations/0002_video_metadata_kind.sql', import.meta.url), 'utf8'));
  expect((await f.store.inventory(id)).results).toEqual([
    { ...before, kind: 'video_metadata' },
  ]);
  expect(f.sql.prepare('SELECT kind, object_key FROM video_asset_versions').all()).toEqual([
    { kind: 'video_metadata', object_key: before.object_key },
  ]);
  expect(await readVideoResource(f.env, { kind: 'video', id })).toMatchObject({ value });
  expect([...f.objects.keys()]).toEqual([before.object_key]);
});

test('video details use the metadata kind and retain the operation freshness policy', async () => {
  const f = fixture();
  const value = { id, title: 'Video details' };
  const coordinator = new YouTubeCacheCoordinatorCore(f.env, async () => value);
  const requests: { maxAgeMs: number; operation: { kind: string } }[] = [];
  Object.assign(f.env, { YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({
    getOrLoad: async (wire: string) => {
      const request = JSON.parse(wire);
      requests.push(request);
      return JSON.stringify(await coordinator.getOrLoad(request));
    },
  }) } });
  await getVideoResource(f.env, { kind: 'video', id });
  expect(requests).toMatchObject([{ maxAgeMs: 30 * 60_000, operation: { kind: 'video' } }]);
  expect((await f.store.inventory(id)).results).toMatchObject([{ kind: 'video_metadata' }]);
  expect([...f.objects.keys()][0]).toContain('/video_metadata/');
  expect(await getVideoResource(f.env, { kind: 'video', id })).toMatchObject({ cacheStatus: 'hit' });
  expect(requests).toHaveLength(1);
});

test('a later comment fetch adds to the same video without replacing its transcript', async () => {
  const f = fixture();
  const now = Date.now();
  await saveVideoResource(f.env, transcriptOp, transcript(), now, 60_000);
  await saveVideoResource(
    f.env,
    { kind: 'comments', id },
    { comments: [{ text: 'A comment' }], meta: { partial: false } },
    now,
    60_000,
  );
  expect(f.sql.prepare('SELECT COUNT(*) n FROM videos').get()).toMatchObject({ n: 1 });
  expect((await f.store.inventory(id)).results.map((asset) => asset.kind)).toEqual([
    'comments',
    'transcript',
  ]);
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({ value: transcript(), complete: true });
  expect([...f.objects.keys()].every((key) => key.startsWith(`youtube/videos/${id}/`))).toBe(true);
});

test('variants isolate language, comments pages, and case-sensitive video IDs', async () => {
  const f = fixture();
  await saveVideoResource(f.env, transcriptOp, transcript(), Date.now(), 60_000);
  for (const op of [
    { ...transcriptOp, lang: 'hi' },
    { ...transcriptOp, id: 'Abcdefghijk' },
  ])
    expect(await readVideoResource(f.env, op)).toBeNull();
  const page = { kind: 'comments', id, continuation: 'page-two' } as const;
  await saveVideoResource(f.env, page, { comments: [], meta: { partial: false } }, Date.now(), 60_000);
  expect(await readVideoResource(f.env, { kind: 'comments', id })).toBeNull();
});

test('keeps partial and older snapshots without replacing the complete current source', async () => {
  const f = fixture();
  const now = Date.now();
  await saveVideoResource(f.env, transcriptOp, transcript('current'), now, 60_000);
  await saveVideoResource(f.env, transcriptOp, transcript('partial', true), now + 1, 60_000);
  await saveVideoResource(f.env, transcriptOp, transcript('late old request'), now - 1, 60_000);
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({
    value: transcript('current'),
    fetchedAt: now,
  });
  expect(f.sql.prepare('SELECT COUNT(*) n FROM video_asset_versions').get()).toMatchObject({ n: 3 });
});

test('a partial transcript is stored but is never a fresh reusable cache hit', async () => {
  const f = fixture();
  const now = Date.now();
  await saveVideoResource(f.env, transcriptOp, transcript('partial', true), now, 60_000);
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({ complete: false, freshUntil: now });
  const loader = vi.fn(async () => transcript('complete'));
  await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request);
  expect(loader).toHaveBeenCalledOnce();
});

test('DB and R2 hit bypasses both KV and the coordinator on the API retrieval path', async () => {
  const f = fixture();
  await saveVideoResource(f.env, transcriptOp, transcript(), Date.now(), 60_000);
  const getByName = vi.fn();
  Object.assign(f.env, { YOUTUBE_REQUEST_COORDINATOR: { getByName } });
  expect(await getTranscriptWithCache(f.env, id, 'en')).toMatchObject({
    value: { segments: transcript().segments },
    cacheStatus: 'hit',
  });
  expect(getByName).not.toHaveBeenCalled();
  expect(f.env.YOUTUBE_CACHE.get).not.toHaveBeenCalled();
});

test('coalesces misses, saves once, and a new coordinator reuses persisted evidence', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  const loader = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const coordinator = new YouTubeCacheCoordinatorCore(f.env, loader);
  const first = coordinator.getOrLoad(request);
  await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
  const second = coordinator.getOrLoad(request);
  finish(transcript());
  const loaded = await first;
  expect(loaded).toMatchObject({ cacheStatus: 'miss', catalogVersions: [{...videoResourceKey(transcriptOp),contentHash:expect.any(String)}] });
  expect(await second).toMatchObject({ cacheStatus: 'coalesced',catalogVersions:loaded.catalogVersions });
  expect(await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request)).toMatchObject({
    cacheStatus: 'hit', catalogVersions:loaded.catalogVersions,
  });
  expect(loader).toHaveBeenCalledOnce();
});

test('explicit refresh bypasses persisted evidence and never disguises a failed refresh as success', async () => {
  const f = fixture();
  const old = Date.now() - 1000;
  await saveVideoResource(f.env, transcriptOp, transcript('old'), old, 60_000);
  const loader = vi.fn(async () => {
    throw new Error('upstream unavailable');
  });
  expect(
    await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad({ ...request, refresh: true }),
  ).toMatchObject({ ok: false });
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({
    value: transcript('old'),
    fetchedAt: old,
  });
});

test('reuses old complete evidence without an upstream attempt or a renewed timestamp', async () => {
  const f = fixture();
  const old = Date.now() - 30 * 86400_000;
  await saveVideoResource(f.env, transcriptOp, transcript(), old, 60_000);
  const loader = vi.fn(async () => { throw new Error('must not fetch'); });
  expect(await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request))
    .toMatchObject({ ok: true, cacheStatus: 'hit', fetchedAt: old });
  expect(loader).not.toHaveBeenCalled();
  expect(await getTranscriptWithCache(f.env, transcriptOp.id, transcriptOp.lang))
    .toMatchObject({ cacheStatus: 'hit', value: { freshness: { state: 'stored', fetchedAt: old } } });
});

test('promotes a legacy KV hit with its original fetch timestamp', async () => {
  const f = fixture();
  const old = Date.now() - 500;
  f.kv.get.mockResolvedValue({ version: 1, value: transcript(), fetchedAt: old, freshUntil: old + 60_000 });
  const loader = vi.fn();
  expect(await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request)).toMatchObject({
    cacheStatus: 'hit',
  });
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({ fetchedAt: old });
  expect(loader).not.toHaveBeenCalled();
});

test('no current pointer is published if R2 fails', async () => {
  const f = fixture();
  f.failPut(true);
  await expect(saveVideoResource(f.env, transcriptOp, transcript(), Date.now(), 60_000)).rejects.toThrow(
    'Video evidence could not be saved',
  );
  expect(f.sql.prepare('SELECT COUNT(*) n FROM video_assets').get()).toMatchObject({ n: 0 });
});

test('a persistence outage is reported even when stale evidence exists', async () => {
  const f = fixture();
  await saveVideoResource(f.env, transcriptOp, transcript('old'), Date.now() - 120_000, 60_000);
  f.failPut(true);
  expect(
    await new YouTubeCacheCoordinatorCore(f.env, async () => transcript('new')).getOrLoad({ ...request, refresh: true }),
  ).toMatchObject({
    ok: false,
    error: { status: 503, message: 'Video evidence could not be saved. Please retry.' },
  });
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({ value: transcript('old') });
});

test('a partial legacy KV response does not become a fresh catalog hit', async () => {
  const f = fixture();
  const now = Date.now();
  f.kv.get.mockResolvedValue({
    version: 1,
    value: transcript('incomplete', true),
    fetchedAt: now,
    freshUntil: now + 60_000,
  });
  const loader = vi.fn(async () => transcript('complete'));
  expect(await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request)).toMatchObject({
    cacheStatus: 'miss',
  });
  expect(loader).toHaveBeenCalledOnce();
});

test('API and agent resource helpers share the same coordinator identity', async () => {
  const f = fixture();
  const getOrLoad = vi.fn(async () =>
    JSON.stringify({ ok: true, value: transcript(), fetchedAt: Date.now(), cacheStatus: 'miss' }),
  );
  const getByName = vi.fn(() => ({ getOrLoad }));
  Object.assign(f.env, { YOUTUBE_REQUEST_COORDINATOR: { getByName } });
  await getTranscriptWithCache(f.env, id, 'en');
  await getVideoResource(f.env, transcriptOp);
  expect(getByName.mock.calls[0]).toEqual(getByName.mock.calls[1]);
  const calls = getOrLoad.mock.calls as unknown as [string][];
  expect(JSON.parse(calls[0]![0]).cacheKey).toBe(JSON.parse(calls[1]![0]).cacheKey);
});

test('reconciles an object written before a failed database commit', async () => {
  const f = fixture();
  f.failCommit(true);
  await expect(
    saveVideoResource(f.env, transcriptOp, transcript(), Date.now() - 600_000, 60_000),
  ).rejects.toThrow('Video evidence could not be saved');
  expect(await readVideoResource(f.env, transcriptOp)).toBeNull();
  f.failCommit(false);
  expect(await f.store.reconcile()).toBe(1);
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({ value: transcript() });
});

test('missing or corrupt R2 payloads cause refetch rather than returning broken evidence', async () => {
  const f = fixture();
  await saveVideoResource(f.env, transcriptOp, transcript(), Date.now(), 60_000);
  const key = [...f.objects.keys()][0]!;
  f.objects.set(key, new TextEncoder().encode('{}'));
  expect(await readVideoResource(f.env, transcriptOp)).toBeNull();
  const loader = vi.fn(async () => transcript('repaired'));
  await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request);
  expect(await readVideoResource(f.env, transcriptOp)).toMatchObject({ value: transcript('repaired') });
});

test('storyboard sheets are stored as JPEGs and assembled across different selections', async () => {
  const f = fixture();
  const now = Date.now();
  await saveVideoResource(f.env, { kind: 'storyboard', id, metadataOnly: true }, storyboard(), now, 60_000);
  await saveVideoResource(
    f.env,
    { kind: 'storyboard', id, sheetIndexes: [0, 1] },
    storyboard([0, 1]),
    now,
    60_000,
  );
  expect(await readVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [1] })).toMatchObject({
    value: { sheets: storyboard([1]).sheets },
  });
  const json = [...f.objects]
    .filter(([key]) => key.endsWith('.json'))
    .map(([, bytes]) => new TextDecoder().decode(bytes))
    .join('');
  expect(json).not.toContain(jpeg);
  expect(json).toContain('r2Image');
  expect([...f.objects.keys()].filter((key) => key.endsWith('.jpg'))).toHaveLength(1);
  expect(await readVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [2] })).toBeNull();
});

test('storyboard loader reuses old sheets and only fetches missing sheets', async () => {
  const f = fixture();
  const old = Date.now() - 30 * 86400_000;
  await saveVideoResource(f.env, { kind: 'storyboard', id, metadataOnly: true }, storyboard(), old, 60_000);
  await saveVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [0] }, storyboard([0]), old, 60_000);
  vi.mocked(runYouTubeOperation).mockResolvedValue(storyboard([1]));
  const result = await loadVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [0, 1] });
  expect(result).toMatchObject({ sheets: storyboard([0, 1]).sheets });
  expect(runYouTubeOperation).toHaveBeenCalledWith(
    f.env,
    expect.objectContaining({ sheetIndexes: [1], maxSheets: 1 }),
    undefined,
  );
  expect(await readVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [0] })).toMatchObject({
    fetchedAt: old,
  });
});

test('successful frames from a partial extraction can be reused in another batch', async () => {
  const f = fixture();
  const op = {
    kind: 'frames',
    id,
    timestampsMs: [1000, 2000],
    maxWidth: 640,
    extractionTimeoutMs: 5000,
  } as const;
  const mutable = { ...op, timestampsMs: [1000, 2000] };
  await saveVideoResource(
    f.env,
    mutable,
    {
      videoId: id,
      frames: [frame(1000)],
      failures: [{ timestampMs: 2000, code: 'TIMEOUT', message: 'timeout', retryable: true }],
      meta: { partial: true, warnings: [] },
    },
    Date.now(),
    60_000,
  );
  vi.mocked(getVideoFrames).mockResolvedValue({
    videoId: id,
    frames: [frame(2000)],
    failures: [],
    meta: { partial: false, warnings: [] },
  });
  const onVersions=vi.fn();
  expect(await loadVideoResource(f.env, mutable,undefined,false,onVersions)).toMatchObject({ frames: [frame(1000), frame(2000)] });
  expect(onVersions).toHaveBeenCalledWith([
    expect.objectContaining({kind:'frame',variant:'v1:640:1000',contentHash:expect.any(String)}),
    expect.objectContaining({kind:'frame',variant:'v1:640:2000',contentHash:expect.any(String)}),
  ]);
  expect(getVideoFrames).toHaveBeenCalledWith(
    f.env,
    { videoId: id, timestampsMs: [2000], maxWidth: 640 },
    undefined,
    { extractionTimeoutMs: 5000 },
    undefined,
  );
  expect(await readVideoResource(f.env, { ...mutable, timestampsMs: [1000], maxWidth: 1920 })).toBeNull();
});

test('empty endscreen arrays retain their public array shape on shared hits', async () => {
  const f = fixture();
  const op = { kind: 'endscreen', id } as const;
  await saveVideoResource(f.env, op, [], Date.now(), 60_000);
  expect(await getVideoResource(f.env, op)).toMatchObject({ value: [], cacheStatus: 'hit' });
});

test('the hot lookup uses an index and warm reads do not update activity each time', async () => {
  const f = fixture();
  await saveVideoResource(f.env, transcriptOp, transcript(), Date.now(), 60_000);
  const before = f.sql.prepare('SELECT total_changes() n').get();
  await readVideoResource(f.env, transcriptOp);
  await readVideoResource(f.env, transcriptOp);
  expect(f.sql.prepare('SELECT total_changes() n').get()).toEqual(before);
  const key = videoResourceKey(transcriptOp)!;
  const plan = f.sql
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM video_assets WHERE video_id=? AND kind=? AND variant=?')
    .all(id, key.kind, key.variant);
  expect(plan.some((row) => String(row.detail).includes('SEARCH video_assets USING INDEX'))).toBe(true);
});

test('exact version reads retain old content while historical backfill never advances current freshness', async () => {
  const f = fixture(),
    key = videoResourceKey(transcriptOp)!;
  const at = Date.now();
  const original = await f.store.save(key, transcript('Original'), at - 1000, 60_000, true);
  await f.store.save(key, transcript('Current'), at, 60_000, true);
  const historical = await f.store.save(
    key,
    transcript('Uncatalogued legacy'),
    at + 1000,
    0,
    true,
    {},
    false,
  );
  expect(await f.store.readVersion(original)).toMatchObject({ value: transcript('Original') });
  expect(await f.store.readVersion(historical)).toMatchObject({ value: transcript('Uncatalogued legacy') });
  expect(await f.store.read(key)).toMatchObject({
    value: transcript('Current'),
    fetchedAt: at,
    freshUntil: at + 60_000,
  });
  await f.store.save(key, transcript('Original'), at + 2000, 0, true, {}, false);
  expect(await f.store.readVersion(original)).toMatchObject({
    fetchedAt: at - 1000,
    freshUntil: at - 1000 + 60_000,
  });
});

test('recovery commits a historical-only version without creating or replacing a current pointer', async () => {
  const f = fixture(),
    key = videoResourceKey(transcriptOp)!;
  const at = Date.now() - 600_000;
  f.failCommit(true);
  await expect(f.store.save(key, transcript('Historical'), at, 0, true, {}, false)).rejects.toThrow();
  f.failCommit(false);
  expect(await f.store.reconcile()).toBe(1);
  expect(await f.store.read(key)).toBeNull();
  const row = f.sql.prepare('SELECT * FROM video_asset_versions').get()!;
  expect(row).toMatchObject({ state: 'ready', publish_current: 0 });
  expect(await f.store.readVersion({ ...key, contentHash: row.content_hash as string })).toMatchObject({
    value: transcript('Historical'),
  });
});

test('backfilling the payload of an interrupted live write preserves its recovery intent', async () => {
  const f = fixture(),
    key = videoResourceKey(transcriptOp)!;
  const at = Date.now() - 600_000;
  f.failPut(true);
  await expect(f.store.save(key, transcript(), at, 60_000, true)).rejects.toThrow();
  f.failPut(false);
  await f.store.save(key, transcript(), at + 1000, 0, true, {}, false);
  expect(f.sql.prepare('SELECT state,publish_current,fetched_at FROM video_asset_versions').get()).toEqual({
    state: 'pending',
    publish_current: 1,
    fetched_at: at,
  });
  expect(await f.store.reconcile()).toBe(1);
  expect(await f.store.read(key)).toMatchObject({
    value: transcript(),
    fetchedAt: at,
    freshUntil: at + 60_000,
  });
});


test('reuses a historical-only import without publishing it as current', async () => {
  const f = fixture(), key = videoResourceKey(transcriptOp)!;
  const fetchedAt = Date.now() - 90 * 86400_000;
  const reference = await f.store.save(key, transcript('Imported'), fetchedAt, 0, true, {}, false);
  expect(await f.store.read(key)).toBeNull();
  expect(await getTranscriptWithCache(f.env, transcriptOp.id, transcriptOp.lang)).toMatchObject({
    cacheStatus: 'hit', catalogVersions: [reference],
    value: { segments: [{ text: 'Imported' }], freshness: { state: 'stored', fetchedAt } },
  });
  expect(await f.store.read(key)).toBeNull();
});

test.each([
  [{ kind: 'video', id: 'abcdefghijk' }, { id: 'abcdefghijk', title: 'Saved title', viewCount: 100 }],
  [{ kind: 'comments', id: 'abcdefghijk' }, { videoId: 'abcdefghijk', comments: [] }],
] as const)('reuses old %j and replaces it only on explicit refresh', async (operation, value) => {
  const f = fixture(), fetchedAt = Date.now() - 90 * 86400_000;
  const [reference] = await saveVideoResource(f.env, operation, value, fetchedAt, 60_000);
  const req = { ...request, operation, resourceType: operation.kind };
  const updated = { ...value, updated: true };
  const loader = vi.fn(async () => updated);
  const core = new YouTubeCacheCoordinatorCore(f.env, loader);
  expect(await core.getOrLoad(req)).toMatchObject({ cacheStatus: 'hit', fetchedAt, value });
  expect(loader).not.toHaveBeenCalled();
  expect(await core.getOrLoad({ ...req, refresh: true })).toMatchObject({ cacheStatus: 'miss', value: updated });
  expect(loader).toHaveBeenCalledOnce();
  expect(await f.store.readVersion(reference!)).toMatchObject({ fetchedAt, value });
});

test('normalizes fresh storyboard metadata before returning and pinning its saved version', async () => {
  const { env } = fixture();
  const op = { kind: 'storyboard', id, metadataOnly: true } as const;
  const raw = { ...storyboard(), level: 2 };
  vi.mocked(runYouTubeOperation).mockResolvedValueOnce(raw);
  const result = await loadVideoResource(env, op);
  expect(result).not.toHaveProperty('level');
  const refs = await saveVideoResource(env, op, result, Date.now(), 60_000);
  const { SessionCatalog } = await import('../src/agents/runtime/session-catalog');
  await expect(new SessionCatalog(env).pin('storyboard_manifest', id, 'manifest', result, Date.now(), refs))
    .resolves.toMatchObject({ asset: refs[0] });
});

test('persists frames with bounded R2 concurrency and returns references in timestamp order', async () => {
  const f = fixture();
  const put = vi.mocked(f.bucket.put).getMockImplementation()!;
  let active = 0, peak = 0;
  vi.mocked(f.bucket.put).mockImplementation(async (...args) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    try { return await put(...args); }
    finally { active--; }
  });
  const times = [1000, 2000, 3000, 4000, 5000, 6000];
  const refs = await saveVideoResource(f.env, { kind: 'frames', id, timestampsMs: times, maxWidth: 640, extractionTimeoutMs: 5000 },
    { videoId: id, frames: times.map(frame), failures: [], meta: { partial: false, warnings: [] } }, Date.now(), 60_000);
  expect(peak).toBe(6);
  expect(active).toBe(0);
  expect(refs.map(ref => ref.variant)).toEqual(times.map(time => `v1:640:${time}`));
  expect(f.batches).toHaveLength(2);
});

test('settles all six started frame writes before rejecting', async () => {
  const f = fixture();
  let settled = 0;
  vi.mocked(f.bucket.put).mockImplementation(async () => {
    const index = vi.mocked(f.bucket.put).mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, index === 1 ? 0 : 10));
    settled++;
    throw new Error('storage unavailable');
  });
  const times = [1000, 2000, 3000, 4000, 5000, 6000];
  await expect(saveVideoResource(f.env, { kind: 'frames', id, timestampsMs: times, maxWidth: 640, extractionTimeoutMs: 5000 },
    { videoId: id, frames: times.map(frame), failures: [], meta: { partial: false, warnings: [] } }, Date.now(), 60_000)).rejects.toThrow('could not be saved');
  expect(f.bucket.put).toHaveBeenCalledTimes(6);
  expect(settled).toBe(6);
});

test('attaches catalog timings to extraction diagnostics even when persistence fails', async () => {
  const { extractionFixture } = await import('./fixtures/extraction-diagnostic');
  const f = fixture();
  vi.mocked(getVideoFrames).mockImplementation(async (_env, _request, _signal, _options, diagnostic) => {
    diagnostic?.({ ...extractionFixture, kind: 'frames' });
    return { videoId: id, frames: [frame(1000)], failures: [], meta: { partial: false, warnings: [] } };
  });
  const diagnostic = vi.fn();
  const save = vi.spyOn(VideoCatalog.prototype, 'saveMany').mockRejectedValue(new Error('storage unavailable'));
  try {
    await expect(loadVideoResource(f.env, { kind: 'frames', id, timestampsMs: [1000], maxWidth: 640, extractionTimeoutMs: 5000 }, diagnostic))
      .rejects.toThrow('storage unavailable');
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ events: expect.arrayContaining([
      expect.objectContaining({ stage: 'catalog_lookup', elapsedMs: expect.any(Number) }),
      expect.objectContaining({ stage: 'catalog_write', elapsedMs: expect.any(Number) }),
    ]) }));
  } finally { save.mockRestore(); }
});

test('forwards extraction diagnostics before a stalled catalog write', async () => {
  const { extractionFixture } = await import('./fixtures/extraction-diagnostic');
  const f = fixture();
  const diagnostic = vi.fn();
  vi.mocked(getVideoFrames).mockImplementation(async (_env, _request, _signal, _options, sink) => {
    sink?.({ ...extractionFixture, kind: 'frames' });
    return { videoId: id, frames: [frame(1000)], failures: [], meta: { partial: false, warnings: [] } };
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = VideoCatalog.prototype.saveMany;
  const save = vi.spyOn(VideoCatalog.prototype, 'saveMany').mockImplementation(async function (this: VideoCatalog, ...args) {
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0]![0]).toMatchObject({ events: extractionFixture.events });
    release();
    return original.apply(this, args);
  });
  try {
    const pending = loadVideoResource(f.env, { kind: 'frames', id, timestampsMs: [1000], maxWidth: 640, extractionTimeoutMs: 5000 }, diagnostic);
    await gate;
    await pending;
    expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'catalog', outcome: 'success' }));
  } finally { save.mockRestore(); }
});

test('storyboard cold-path simulation uses one container and one catalog lookup pass', async () => {
  const f = fixture();
  const reads = vi.spyOn(VideoCatalog.prototype, 'readSaved');
  const core = new YouTubeCacheCoordinatorCore(f.env);
  f.env.YOUTUBE_REQUEST_COORDINATOR = { getByName: () => ({
    getOrLoad: async (wire: string) => JSON.stringify(await core.getOrLoad(JSON.parse(wire))),
  }) } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  vi.mocked(runYouTubeOperation).mockImplementation(async (_env, op) =>
    storyboard(op.kind === 'storyboard' && op.metadataOnly ? [] : [0, 1, 2]) as never);
  try {
    const result = await getVideoResource(f.env, { kind: 'storyboard', id, maxSheets: 3 });
    expect(result.value.sheets).toHaveLength(3);
    expect(runYouTubeOperation).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls.map(([key]) => key.kind)).toEqual(['storyboard_manifest']);
    expect(result.catalogVersions).toHaveLength(4);
  } finally { reads.mockRestore(); }
});

test('storyboard partial-cache simulation retains hits across the coordinator lookup', async () => {
  const f = fixture();
  await saveVideoResource(f.env, { kind: 'storyboard', id, metadataOnly: true }, storyboard(), 1, 60_000);
  await saveVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [0] }, storyboard([0]), 1, 60_000);
  const reads = vi.spyOn(VideoCatalog.prototype, 'readSaved');
  const batchReads = vi.spyOn(VideoCatalog.prototype, 'readSavedMany');
  const core = new YouTubeCacheCoordinatorCore(f.env);
  f.env.YOUTUBE_REQUEST_COORDINATOR = { getByName: () => ({
    getOrLoad: async (wire: string) => JSON.stringify(await core.getOrLoad(JSON.parse(wire))),
  }) } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  vi.mocked(runYouTubeOperation).mockResolvedValue(storyboard([1, 2]));
  try {
    const result = await getVideoResource(f.env, { kind: 'storyboard', id, maxSheets: 3 });
    expect(result.value.sheets).toHaveLength(3);
    expect(runYouTubeOperation).toHaveBeenCalledExactlyOnceWith(f.env,
      expect.objectContaining({ sheetIndexes: [1, 2], maxSheets: 2 }), expect.any(Function));
    expect(reads.mock.calls.filter(([key]) => key.kind === 'storyboard_manifest')).toHaveLength(1);
    expect(batchReads).toHaveBeenCalledTimes(1);
    expect(batchReads.mock.calls[0]![0]).toHaveLength(3);
  } finally { reads.mockRestore(); batchReads.mockRestore(); }
});


test('eight-sheet miss simulation batches lookups into two D1 calls and one activity update', async () => {
  const f = fixture();
  const board = { ...storyboard(), frameCount: 16,
    manifest: { ...storyboard().manifest!, totalSheets: 8, lastSampleMs: 150_000 } };
  await saveVideoResource(f.env, { kind: 'storyboard', id, metadataOnly: true }, board, Date.now(), 60_000);
  f.queries.length = 0;
  f.batches.length = 0;
  const { readStoryboardSelection } = await import('../src/lib/video-resources');
  const lookup = await readStoryboardSelection(f.env, {kind: 'storyboard', id, maxSheets: 12});
  expect(lookup.missing).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(f.batches.map(batch => batch.length)).toEqual([8, 9]);
  expect(f.queries.filter(query => query.includes('INSERT INTO videos'))).toHaveLength(1);
  // One manifest SELECT plus 17 sheet/activity statements, previously 3 * 24 for sheets alone.
  expect(f.queries).toHaveLength(18);
});

test('cold storyboard requests coalesce, then reuse all saved sheets without another container', async () => {
  const f = fixture();
  const core = new YouTubeCacheCoordinatorCore(f.env);
  const op = {kind: 'storyboard', id, maxSheets: 3} as const;
  const selection = {...request, cacheKey: 'storyboard-cold', operation: op, resourceType: 'storyboard'};
  let finish!: (board: Storyboard) => void;
  const pending = new Promise<Storyboard>(resolve => { finish = resolve; });
  vi.mocked(runYouTubeOperation).mockReturnValue(pending as never);
  const first = core.getOrLoad(selection);
  const second = core.getOrLoad(selection);
  finish(storyboard([0, 1, 2]));
  const results = await Promise.all([first, second]);
  expect(results.map(result => result.cacheStatus)).toEqual(['miss', 'coalesced']);
  expect(results[1]!.visualDiagnostics?.operationId).toBe(results[0]!.visualDiagnostics?.operationId);
  expect(results[0]!.visualDiagnostics?.counters.catalogLookupPasses).toBe(1);
  expect(results.every(result => result.catalogVersions?.length === 4)).toBe(true);
  const warm = await new YouTubeCacheCoordinatorCore(f.env).getOrLoad(selection);
  expect(warm).toMatchObject({ok:true, cacheStatus:'hit', value:{sheets:storyboard([0,1,2]).sheets}});
  expect(runYouTubeOperation).toHaveBeenCalledTimes(1);
});

test('storyboard refresh gets a new manifest and sheets together and a failure cannot return stale data', async () => {
  const f = fixture();
  await saveVideoResource(f.env, {kind:'storyboard',id,metadataOnly:true}, storyboard(), 1, 60_000);
  const core = new YouTubeCacheCoordinatorCore(f.env);
  const selection = {...request, cacheKey:'storyboard-refresh', resourceType:'storyboard', refresh:true,
    operation:{kind:'storyboard',id,maxSheets:3} as const};
  const updated = storyboard([0,1,2]);
  updated.intervalMs = 20_000;
  updated.manifest!.lastSampleMs = 100_000;
  updated.sheets.forEach(sheet => {sheet.intervalMs = 20_000;});
  vi.mocked(runYouTubeOperation).mockResolvedValueOnce(updated);
  expect(await core.getOrLoad(selection)).toMatchObject({ok:true,value:updated});
  expect(runYouTubeOperation).toHaveBeenCalledTimes(1);
  expect(await readVideoResource(f.env, selection.operation)).toMatchObject({value:{intervalMs:20_000}});
  vi.mocked(runYouTubeOperation).mockRejectedValueOnce(new Error('Container unavailable'));
  expect(await core.getOrLoad(selection)).toMatchObject({ok:false});
});

test('legacy storyboard promotion includes the manifest reference for one-call session pinning', async () => {
  const f = fixture();
  f.kv.get.mockResolvedValue({version:1, value:storyboard([0,1,2]), fetchedAt:123, freshUntil:124});
  const result = await new YouTubeCacheCoordinatorCore(f.env).getOrLoad({...request,
    resourceType:'storyboard', operation:{kind:'storyboard', id, maxSheets:3}});
  expect(result).toMatchObject({ok:true,cacheStatus:'hit',fetchedAt:123});
  expect(result.catalogVersions?.map(asset=>asset.kind)).toEqual([
    'storyboard_manifest','storyboard_sheet','storyboard_sheet','storyboard_sheet']);
  expect(await readVideoResource(f.env,{kind:'storyboard',id,metadataOnly:true})).toMatchObject({fetchedAt:123});
  expect(runYouTubeOperation).not.toHaveBeenCalled();
});

test('eight storyboard sheets publish with two D1 batches while retaining per-image journal ordering', async () => {
  const f = fixture();
  const board = { ...storyboard(), frameCount:16, selection:{mode:'spread' as const},
    manifest:{...storyboard().manifest!,totalSheets:8,lastSampleMs:150000},
    sheets:Array.from({length:8},(_,index)=>({...storyboard([0]).sheets[0]!,firstFrameIndex:index*2})) };
  const put = vi.mocked(f.bucket.put).getMockImplementation()!;
  vi.mocked(f.bucket.put).mockImplementation(async (...args) => {
    expect(f.sql.prepare("SELECT count(*) AS n FROM video_asset_versions WHERE state='pending'").get()).toMatchObject({n:8});
    expect(f.sql.prepare('SELECT count(*) AS n FROM video_assets').get()).toMatchObject({n:0});
    if (String(args[0]).endsWith('.json')) expect([...f.objects.keys()].some(key=>key.endsWith('.jpg'))).toBe(true);
    return put(...args);
  });
  const versions = await saveVideoResource(f.env,{kind:'storyboard',id,maxSheets:8},board,Date.now(),60000);
  expect(versions).toHaveLength(8);
  expect(f.batches.map(batch=>batch.length)).toEqual([9,16]);
  expect(f.sql.prepare("SELECT count(*) AS n FROM video_asset_versions WHERE state='ready'").get()).toMatchObject({n:8});
});

test('batched writes drain started uploads, preserve successes and leave later sheets unstarted on failure', async () => {
  const f = fixture();
  const inputs = Array.from({length:8}, (_,index) => ({key:{videoId:id,kind:'test',variant:String(index)},
    value:{index,imageBase64:jpeg}, fetchedAt:Date.now()-600000,maxAgeMs:60000,complete:true}));
  const put = vi.mocked(f.bucket.put).getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const manifests: number[] = [];
  vi.mocked(f.bucket.put).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.json')) {
      const index = JSON.parse(args[1] as string).index as number;
      manifests.push(index);
      if (index===0) throw new Error('simulated manifest upload failure');
      if (index===1) await gate;
    }
    return put(...args);
  });
  let settled = false;
  const pending = f.store.saveMany(inputs);
  const rejected = expect(pending).rejects.toThrow('could not be saved');
  void pending.then(()=>{settled=true;},()=>{settled=true;});
  await vi.waitFor(()=>expect(manifests).toHaveLength(4));
  expect(settled).toBe(false);
  expect(f.batches).toHaveLength(1);
  release();
  await rejected;
  expect(manifests.sort()).toEqual([0,1,2,3]);
  expect(f.batches.map(batch=>batch.length)).toEqual([9,6]);
  expect(f.sql.prepare('SELECT variant FROM video_assets ORDER BY variant').all()).toEqual([{variant:'1'},{variant:'2'},{variant:'3'}]);
  await f.store.reconcile();
  expect(f.sql.prepare("SELECT count(*) AS n FROM video_asset_versions WHERE state='pending'").get()).toMatchObject({n:0});
});

test('batched writes recover all uploaded assets after a failed publication and upload nothing after journal failure', async () => {
  const f = fixture();
  const inputs = Array.from({length:8}, (_,index) => ({key:{videoId:id,kind:'test',variant:String(index)},
    value:{index,imageBase64:jpeg}, fetchedAt:Date.now()-600000,maxAgeMs:60000,complete:true}));
  f.failCommit(true);
  await expect(f.store.saveMany(inputs)).rejects.toThrow('could not be saved');
  expect(f.sql.prepare('SELECT count(*) AS n FROM video_assets').get()).toMatchObject({n:0});
  expect([...f.objects.keys()].filter(key=>key.endsWith('.json'))).toHaveLength(8);
  f.failCommit(false);
  expect(await f.store.reconcile()).toBe(8);
  expect((await f.store.readSavedMany(inputs.map(input=>input.key))).every(Boolean)).toBe(true);
  const g = fixture();
  vi.spyOn(g.db,'batch').mockRejectedValueOnce(new Error('journal unavailable'));
  await expect(g.store.saveMany(inputs)).rejects.toThrow('could not be saved');
  expect(g.bucket.put).not.toHaveBeenCalled();
});

test.each([false,true])('cold metadata and sheet persistence overlap and drain both writes on metadata failure=%s', async failure => {
  const f = fixture();
  vi.mocked(runYouTubeOperation).mockResolvedValue(storyboard([0,1,2]));
  let release!: () => void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const started: string[] = [];
  const save = vi.spyOn(VideoCatalog.prototype,'save').mockImplementation(async key=>{
    started.push('metadata');
    if (failure) throw new Error('metadata failure');
    await gate;
    return {...key,contentHash:'metadata'};
  });
  const many = vi.spyOn(VideoCatalog.prototype,'saveMany').mockImplementation(async inputs=>{
    started.push('sheets');
    await gate;
    return inputs.map(input=>({...input.key,contentHash:'sheet'}));
  });
  try {
    let settled=false;
    const pending=loadVideoResource(f.env,{kind:'storyboard',id,maxSheets:3});
    const result = failure ? expect(pending).rejects.toThrow('metadata failure') : expect(pending).resolves.toMatchObject({sheets:storyboard([0,1,2]).sheets});
    void pending.then(()=>{settled=true;},()=>{settled=true;});
    await vi.waitFor(()=>expect(started.sort()).toEqual(['metadata','sheets']));
    expect(settled).toBe(false);
    release();
    await result;
  } finally {save.mockRestore();many.mockRestore();release();}
});

test('six-frame cold simulation performs one lookup pass and two write batches', async () => {
  const f=fixture();
  const times=[1000,2000,3000,4000,5000,6000];
  const core=new YouTubeCacheCoordinatorCore(f.env);
  f.env.YOUTUBE_REQUEST_COORDINATOR={getByName:()=>({
    getOrLoad:async(wire:string)=>JSON.stringify(await core.getOrLoad(JSON.parse(wire))),
  })} as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  let lookupStatements=0;
  vi.mocked(getVideoFrames).mockImplementation(async()=>{
    lookupStatements=f.queries.length;
    return {videoId:id,frames:times.map(frame),failures:[],meta:{partial:false,warnings:[]}};
  });
  const {value:result,diagnostics}=await captureVisualWork('tool','frames',()=>getVideoResource(f.env,{kind:'frames',id,timestampsMs:times,maxWidth:640,extractionTimeoutMs:5000}));
  const measured=diagnostics.linked[0]!.work;
  expect(measured.counters).toMatchObject({catalogLookupPasses:1,catalogMisses:6,catalogD1Statements:f.queries.length,catalogD1Batches:f.batches.length, catalogR2Puts:vi.mocked(f.bucket.put).mock.calls.length});
  expect(diagnostics.counters.catalogD1Statements).toBeUndefined();
  expect(result.value.frames.map(frame=>frame.timestampMs)).toEqual(times);
  expect(getVideoFrames).toHaveBeenCalledTimes(1);
  expect(lookupStatements).toBe(13);
  expect(f.batches.map(batch=>batch.length)).toEqual([6,7,7,12]);
  expect(result.catalogVersions).toHaveLength(6);
});

test('frame coordinator retains partial cache hits, coalesces extraction, and retries only failed timestamps', async () => {
  const f=fixture();
  const op={kind:'frames' as const,id,timestampsMs:[1000,2000,3000],maxWidth:640,extractionTimeoutMs:5000};
  await saveVideoResource(f.env,{...op,timestampsMs:[1000]},
    {videoId:id,frames:[frame(1000)],failures:[],meta:{partial:false,warnings:[]}},123,60000);
  const core=new YouTubeCacheCoordinatorCore(f.env);
  const request={cacheKey:'frames-partial',resourceType:'frames',operation:op,maxAgeMs:60000};
  vi.mocked(getVideoFrames).mockResolvedValueOnce({videoId:id,frames:[frame(2000)],
    failures:[{timestampMs:3000,code:'TIMEOUT',message:'timeout',retryable:true}],meta:{partial:true,warnings:[]}});
  const lookup=vi.spyOn(VideoCatalog.prototype,'readSavedMany');
  try {
    const [first,second]=await Promise.all([core.getOrLoad(request),core.getOrLoad(request)]);
    expect(first).toMatchObject({ok:true,cacheStatus:'miss',value:{frames:[frame(1000),frame(2000)],meta:{partial:true}}});
    expect(second.cacheStatus).toBe('coalesced');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(getVideoFrames).toHaveBeenCalledExactlyOnceWith(f.env,{videoId:id,timestampsMs:[2000,3000],maxWidth:640},
      undefined,{extractionTimeoutMs:5000},expect.any(Function));
    vi.mocked(getVideoFrames).mockResolvedValueOnce({videoId:id,frames:[frame(3000)],failures:[],meta:{partial:false,warnings:[]}});
    expect(await core.getOrLoad(request)).toMatchObject({ok:true,value:{frames:[frame(1000),frame(2000),frame(3000)]}});
    expect(getVideoFrames).toHaveBeenLastCalledWith(f.env,{videoId:id,timestampsMs:[3000],maxWidth:640},
      undefined,{extractionTimeoutMs:5000},expect.any(Function));
    expect(await new YouTubeCacheCoordinatorCore(f.env).getOrLoad(request)).toMatchObject({cacheStatus:'hit'});
    expect(getVideoFrames).toHaveBeenCalledTimes(2);
    expect(await readVideoResource(f.env,{...op,timestampsMs:[1000]})).toMatchObject({fetchedAt:123});
    expect(await readVideoResource(f.env,{...op,timestampsMs:[1000],maxWidth:320})).toBeNull();
  } finally {lookup.mockRestore();}
});

test('frame refresh bypasses saved lookup, preserves its budget and cannot return stale data on failure', async () => {
  const f=fixture();
  const op={kind:'frames' as const,id,timestampsMs:[1000],maxWidth:640,extractionTimeoutMs:17000};
  const value={videoId:id,frames:[frame(1000)],failures:[],meta:{partial:false,warnings:[]}};
  await saveVideoResource(f.env,op,value,1,60000);
  const lookup=vi.spyOn(VideoCatalog.prototype,'readSavedMany');
  const core=new YouTubeCacheCoordinatorCore(f.env);
  const request={cacheKey:'frames-refresh',resourceType:'frames',operation:op,maxAgeMs:60000,refresh:true};
  try {
    vi.mocked(getVideoFrames).mockResolvedValueOnce(value);
    expect(await core.getOrLoad(request)).toMatchObject({ok:true,cacheStatus:'miss'});
    expect(lookup).not.toHaveBeenCalled();
    expect(getVideoFrames).toHaveBeenLastCalledWith(f.env,{videoId:id,timestampsMs:[1000],maxWidth:640},
      undefined,{extractionTimeoutMs:17000},expect.any(Function));
    vi.mocked(getVideoFrames).mockRejectedValueOnce(new Error('extraction failed'));
    expect(await core.getOrLoad(request)).toMatchObject({ok:false});
  } finally {lookup.mockRestore();}
});

test('single-sheet cold, warm, and refreshed storyboards select the processor middle sheet', async () => {
  const f = fixture();
  const core = new YouTubeCacheCoordinatorCore(f.env);
  f.env.YOUTUBE_REQUEST_COORDINATOR = { getByName: () => ({
    getOrLoad: async (wire: string) => JSON.stringify(await core.getOrLoad(JSON.parse(wire))),
  }) } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  vi.mocked(runYouTubeOperation).mockResolvedValue(storyboard([1]));
  const op = { kind: 'storyboard', id, maxSheets: 1 } as const;
  for (const refresh of [false, false, true]) {
    const result = await getVideoResource(f.env, op, refresh);
    expect(result.value.sheets.map(sheet => sheet.firstFrameIndex)).toEqual([2]);
    expect(result.catalogVersions).toHaveLength(2);
  }
  expect(runYouTubeOperation).toHaveBeenCalledTimes(2);
});

test.each(['storyboard', 'frames'] as const)('complete %s catalog hits survive coordinator RPC failure, but refresh does not', async kind => {
  const f = fixture();
  const operation = kind === 'storyboard' ? { kind, id, maxSheets: 1 }
    : { kind, id, timestampsMs: [1000], maxWidth: 640, extractionTimeoutMs: 5000 };
  if (kind === 'storyboard') await saveVideoResource(f.env, { kind, id, metadataOnly: true }, storyboard(), 123, 60000);
  const value = kind === 'storyboard' ? storyboard([1])
    : { videoId: id, frames: [frame(1000)], failures: [], meta: { partial: false, warnings: [] } };
  await saveVideoResource(f.env, operation, value, 123, 60000);
  const getOrLoad = vi.fn(async () => { throw new Error('coordinator offline'); });
  f.env.YOUTUBE_REQUEST_COORDINATOR = { getByName: () => ({ getOrLoad }) } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  const fallback = await getVideoResource(f.env, operation);
  expect(fallback).toMatchObject({ cacheStatus: 'stale', value: {
    freshness: { state: 'stale', fetchedAt: 123 } }, catalogVersions: expect.any(Array) });
  expect('sheets' in fallback.value ? fallback.value.sheets : fallback.value.frames)
    .toEqual(kind === 'storyboard' ? storyboard([1]).sheets : [frame(1000)]);
  await expect(getVideoResource(f.env, operation, true)).rejects.toMatchObject({ status: 503, code: 'CACHE_COORDINATOR_UNAVAILABLE' });
  expect(runYouTubeOperation).not.toHaveBeenCalled();
  expect(getVideoFrames).not.toHaveBeenCalled();
  const missing = kind === 'storyboard' ? { kind, id, sheetIndexes: [2] }
    : { kind, id, timestampsMs: [2000], maxWidth: 640, extractionTimeoutMs: 5000 };
  await expect(getVideoResource(f.env, missing)).rejects.toMatchObject({ status: 503, code: 'CACHE_COORDINATOR_UNAVAILABLE' });
});

test('storyboard metadata-only hit bypasses the coordinator', async () => {
  const f = fixture();
  const op = { kind: 'storyboard', id, metadataOnly: true } as const;
  await saveVideoResource(f.env, op, storyboard(), 123, 60000);
  const getByName = vi.fn();
  f.env.YOUTUBE_REQUEST_COORDINATOR = { getByName } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  expect(await getVideoResource(f.env, op)).toMatchObject({ cacheStatus: 'hit', value: { manifest: { totalSheets: 3 } } });
  expect(getByName).not.toHaveBeenCalled();
});

test.each([{ sheetIndexes: [3] }, { timestampsMs: [60000] }, { timestampsMs: [0, 40000], maxSheets: 1 }])(
  'invalid cold storyboard selection returns ranges after one metadata recovery: %j', async selection => {
    const { YouTubeProcessorError } = await import('../src/lib/youtube-processor-client');
    const f = fixture();
    const core = new YouTubeCacheCoordinatorCore(f.env);
    vi.mocked(runYouTubeOperation).mockRejectedValueOnce(new YouTubeProcessorError('INVALID_INPUT', 'Selection out of range.'))
      .mockResolvedValueOnce(storyboard());
    const result = await core.getOrLoad({ ...request, operation: { kind: 'storyboard', id, ...selection } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', apiStatus: 422, retryable: false,
      message: expect.stringContaining('Available sheet indexes are 0 through 2; timestamps must be below 60000 ms') } });
    expect(runYouTubeOperation).toHaveBeenCalledTimes(2);
    expect(runYouTubeOperation).toHaveBeenLastCalledWith(f.env, { kind: 'storyboard', id, metadataOnly: true }, expect.any(Function));
  });

test('warm invalid storyboard selection returns guidance without container calls', async () => {
  const f = fixture();
  await saveVideoResource(f.env, { kind: 'storyboard', id, metadataOnly: true }, storyboard(), 123, 60000);
  const result = await new YouTubeCacheCoordinatorCore(f.env).getOrLoad({ ...request,
    operation: { kind: 'storyboard', id, sheetIndexes: [3] } });
  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', apiStatus: 422,
    message: expect.stringContaining('Available sheet indexes are 0 through 2') } });
  expect(runYouTubeOperation).not.toHaveBeenCalled();
});

test('storyboard counters count images rather than the manifest', async () => {
  const f = fixture();
  await saveVideoResource(f.env, { kind: 'storyboard', id, metadataOnly: true }, storyboard(), 123, 60000);
  await saveVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [0] }, storyboard([0]), 123, 60000);
  vi.mocked(runYouTubeOperation).mockResolvedValue(storyboard([1, 2]));
  const result = await new YouTubeCacheCoordinatorCore(f.env).getOrLoad({ ...request,
    operation: { kind: 'storyboard', id, maxSheets: 3 } });
  expect(result.visualDiagnostics?.counters).toMatchObject({ catalogHits: 1, catalogMisses: 2 });
});

test('image verification hashing is opt-in and still rejects proof for mismatched bytes', async () => {
  const f = fixture();
  const [reference] = await saveVideoResource(f.env, { kind: 'storyboard', id, sheetIndexes: [1] }, storyboard([1]), 123, 60000);
  const digest = vi.spyOn(crypto.subtle, 'digest');
  try {
    expect((await f.store.readVersion(reference!))?.verifiedImages).toBeUndefined();
    expect(digest).toHaveBeenCalledTimes(1); // JSON integrity only.
    digest.mockClear();
    expect((await f.store.readVersion(reference!, true))?.verifiedImages).toHaveLength(1);
    expect(digest).toHaveBeenCalledTimes(2); // JSON and the image proof.
    const key = [...f.objects.keys()].find(key => key.endsWith('.jpg'))!;
    f.objects.set(key, new Uint8Array([255, 216, 255, 1]));
    expect((await f.store.readVersion(reference!, true))?.verifiedImages).toEqual([]);
  } finally { digest.mockRestore(); }
});

test.each([false, true])('publishes ready Media frames during decoding and drains writes on failure=%s', async fail => {
  const f = fixture();
  f.env.YOUTUBE_FRAMES_BACKEND = 'media';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = VideoCatalog.prototype.saveMany;
  let entered = false, finished = false;
  const save = vi.spyOn(VideoCatalog.prototype, 'saveMany').mockImplementation(async function(this: VideoCatalog, ...args) {
    entered = true;
    await gate;
    finished = true;
    if (fail) throw new Error('storage unavailable');
    return original.apply(this, args);
  });
  vi.mocked(getVideoFrames).mockImplementation(async (_env, _request, _signal, _limits, _diagnostic, ready) => {
    ready?.(frame(1000));
    await Promise.resolve();
    expect(entered).toBe(true);
    return { videoId: id, frames: [frame(1000)], failures: [], meta: { partial: false, warnings: [] } };
  });
  let settled = false;
  const pending = loadVideoResource(f.env, {kind:'frames',id,timestampsMs:[1000],maxWidth:640,extractionTimeoutMs:5000})
    .finally(() => { settled = true; });
  const outcome = fail ? expect(pending).rejects.toThrow('storage unavailable') : expect(pending).resolves.toMatchObject({frames:[frame(1000)]});
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(settled).toBe(false);
    expect(finished).toBe(false);
  } finally { release(); }
  await outcome;
  expect(finished).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  save.mockRestore();
});

test('drains a started frame publication before propagating an extraction failure', async () => {
  const f = fixture(); f.env.YOUTUBE_FRAMES_BACKEND = 'media';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const save = vi.spyOn(VideoCatalog.prototype, 'saveMany').mockImplementation(async () => { await gate; return []; });
  vi.mocked(getVideoFrames).mockImplementation(async (_env, _request, _signal, _limits, _diagnostic, ready) => {
    ready!(frame(1000)); throw new Error('extraction failed');
  });
  let settled = false;
  const pending = loadVideoResource(f.env, {kind:'frames',id,timestampsMs:[1000],maxWidth:640,extractionTimeoutMs:5000})
    .finally(() => { settled = true; });
  const outcome = expect(pending).rejects.toThrow('extraction failed');
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  release(); await outcome; save.mockRestore();
});

test('publishes only remaining fallback frames after progressive Media results', async () => {
  const f = fixture(); f.env.YOUTUBE_FRAMES_BACKEND = 'media';
  const save = vi.spyOn(VideoCatalog.prototype, 'saveMany');
  vi.mocked(getVideoFrames).mockImplementation(async (_env, _request, _signal, _limits, _diagnostic, ready) => {
    ready!(frame(1000)); ready!(frame(1000));
    return {videoId:id,frames:[frame(1000),frame(2000)],failures:[],meta:{partial:false,warnings:['Recovery used.']}};
  });
  const versions = vi.fn();
  await loadVideoResource(f.env, {kind:'frames',id,timestampsMs:[1000,2000],maxWidth:640,extractionTimeoutMs:5000}, undefined, false, versions);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls.flatMap(([inputs]) => inputs.map(input => input.key.variant)).sort()).toEqual(['v1:640:1000','v1:640:2000']);
  expect(versions.mock.calls[0]![0]).toHaveLength(2);
  save.mockRestore();
});
