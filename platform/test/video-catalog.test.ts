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
  let failCommit = false;
  function prepare(query: string, params: (string | number | null)[] = []): D1PreparedStatement {
    return {
      bind: (...values: (string | number | null)[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...params) ?? null,
      all: async () => ({ success: true, results: sql.prepare(query).all(...params) }),
      run: async () => {
        sql.prepare(query).run(...params);
        return { success: true };
      },
    } as D1PreparedStatement;
  }
  const db = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      if (failCommit) throw new Error('simulated database outage');
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
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
  expect(await first).toMatchObject({ cacheStatus: 'miss' });
  expect(await second).toMatchObject({ cacheStatus: 'coalesced' });
  expect(await new YouTubeCacheCoordinatorCore(f.env, loader).getOrLoad(request)).toMatchObject({
    cacheStatus: 'hit',
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

test('expired evidence remains available as marked stale fallback after upstream failure', async () => {
  const f = fixture();
  const old = Date.now() - 120_000;
  await saveVideoResource(f.env, transcriptOp, transcript(), old, 60_000);
  expect(
    await new YouTubeCacheCoordinatorCore(f.env, async () => {
      throw new Error('offline');
    }).getOrLoad(request),
  ).toMatchObject({ ok: true, cacheStatus: 'stale', fetchedAt: old });
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
    await new YouTubeCacheCoordinatorCore(f.env, async () => transcript('new')).getOrLoad(request),
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

test('storyboard loader fetches only missing sheets and does not renew existing sheets', async () => {
  const f = fixture();
  const old = Date.now() - 500;
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
  expect(await loadVideoResource(f.env, mutable)).toMatchObject({ frames: [frame(1000), frame(2000)] });
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
  expect(await getVideoResource(f.env, op)).toEqual({ value: [], cacheStatus: 'hit' });
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
