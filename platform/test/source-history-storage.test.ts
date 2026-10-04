import { getChannelWithCache, getPlaylistWithCache, searchYouTubeWithCache, withYouTubeMetadata } from '../src/lib/youtube';
import { referenceSource, restoreSource } from '../src/lib/source-history-storage';
import { YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';
import type { SaveSourceInput } from '../src/lib/source-history';
import { readSourceResponse, saveSourceResponse } from '../src/lib/source-response-storage';
import { sha256 } from '../src/lib/http';

const videoId = 'U-V7IfBwN1I';
const channelId = 'UCB_qr75-ydFVKSF9Dmo6izg';
const metadata = { id: videoId, title: 'Race Highlights', channel: { id: channelId } };
vi.mock('../src/lib/video-catalog', () => ({
  VideoCatalogWriteError: class extends Error {},
  videoCatalog: () => ({
    readSaved: async () => ({ value: metadata, catalogVersions: [{ videoId, kind: 'video_metadata', variant: '{}', contentHash: 'a'.repeat(64) }] }),
    readVersion: async () => ({ value: metadata, fetchedAt: Date.now() }),
  }),
}));

function fixture() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, value: string) => { objects.set(key, value); }),
    get: vi.fn(async (key: string) => {
      const payload = objects.get(key);
      return payload === undefined ? null : { text: async () => payload, json: async () => JSON.parse(payload) };
    }),
  };
  // KV keeps returning the negative lookup made before extraction, including
  // after the write finishes and after the coordinator loses its memory.
  const cache = { get: vi.fn(async (): Promise<unknown> => null), put: vi.fn(async () => {}) };
  const env = { YOUTUBE_CACHE: cache, VIDEO_ASSETS: bucket } as unknown as Env;
  const values = {
    channel: { id: channelId, name: 'FORMULA 1', thumbnails: [], url: `https://youtube.com/channel/${channelId}`,
      about: { links: [], moreInfo: {} }, meta: { source: 'youtube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } },
    playlist: { id: 'PLhistory', title: 'Race highlights', videos: [] },
    search: { query: 'private search terms', results: [{ type: 'video', id: videoId, title: 'Race Highlights', thumbnails: [] }] },
  };
  const load = vi.fn(async (_env: Env, operation: { kind: string }) => values[operation.kind as keyof typeof values]);
  const coordinators = new Map<string, YouTubeCacheCoordinatorCore>();
  env.YOUTUBE_REQUEST_COORDINATOR = { getByName: (key: string) => ({
    getOrLoad: async (wire: string) => {
      let core = coordinators.get(key);
      if (!core) { core = new YouTubeCacheCoordinatorCore(env, load); coordinators.set(key, core); }
      return JSON.stringify(await core.getOrLoad(JSON.parse(wire)));
    },
  }) } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  return { env, objects, bucket, cache, values, load, coordinators };
}

function inspection(type: 'video' | 'channel' | 'playlist', id: string): SaveSourceInput {
  return { input: `https://youtube.com/${type}/${id}`, snapshot: { kind: 'inspection', inspector: {
    provider: 'youtube', type, id, requestedData: type === 'video' ? ['channel'] : [], dataErrors: {},
    loadedData: type === 'video' ? ['metadata', 'channel'] : ['metadata'],
  } } };
}

test.each(['video with channel', 'channel', 'playlist', 'search'] as const)(
  'remembers and restores a completed %s while KV still reports missing', async kind => {
    const f = fixture();
    let input: SaveSourceInput;
    if (kind === 'search') {
      await expect(searchYouTubeWithCache(f.env, 'private search terms', { type: 'video' })).resolves.toMatchObject({ cacheStatus: 'miss' });
      input = { input: 'private search terms', snapshot: { kind: 'search', selectedData: ['transcript'] } };
    } else if (kind === 'playlist') {
      await expect(getPlaylistWithCache(f.env, 'PLhistory')).resolves.toMatchObject({ cacheStatus: 'miss' });
      input = inspection('playlist', 'PLhistory');
    } else {
      await expect(getChannelWithCache(f.env, channelId)).resolves.toMatchObject({ value: withYouTubeMetadata(f.values.channel), cacheStatus: 'miss' });
      input = kind === 'channel' ? inspection('channel', channelId) : inspection('video', videoId);
    }
    expect(f.cache.put).toHaveBeenCalledOnce();
    f.coordinators.clear();
    const saved = await referenceSource(f.env, input);
    const restored = await restoreSource(f.env, saved.snapshot);
    if (kind === 'search') expect(restored).toMatchObject({ kind: 'search', items: f.values.search.results });
    else if (kind === 'playlist') expect(restored).toMatchObject({ inspector: { data: f.values.playlist } });
    else if (kind === 'channel') expect(restored).toMatchObject({ inspector: { data: withYouTubeMetadata(f.values.channel) } });
    else expect(restored).toMatchObject({ inspector: { data: metadata, channel: withYouTubeMetadata(f.values.channel) } });
    expect(f.load).toHaveBeenCalledOnce();
    expect([...f.objects.values()].join('\n')).not.toContain('private search terms');
  },
);

test('does not return a fresh response until its public data is durable', async () => {
  const f = fixture();
  let finish!: () => void;
  f.bucket.put.mockImplementationOnce(async (key, value) => {
    await new Promise<void>(resolve => { finish = resolve; });
    f.objects.set(key, value);
  });
  let completed = false;
  const pending = getChannelWithCache(f.env, channelId).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(f.bucket.put).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  expect(f.cache.put).not.toHaveBeenCalled();
  finish();
  await pending;
  await expect(referenceSource(f.env, inspection('video', videoId))).resolves.toMatchObject({ title: metadata.title });
});

test('a failed durable write prevents a successful fresh response', async () => {
  const f = fixture();
  f.bucket.put.mockRejectedValue(new Error('R2 unavailable'));
  await expect(getChannelWithCache(f.env, channelId)).rejects.toMatchObject({ code: 'SOURCE_STORAGE_UNAVAILABLE', status: 503 });
  expect(f.cache.put).not.toHaveBeenCalled();
  expect(f.objects.size).toBe(0);
});

test.each(['missing', 'older', 'newer'] as const)('chooses the newest available response with a %s retained entry', async state => {
  const f = fixture();
  const stamp = Date.now();
  const key = `youtube:v1:${await sha256(JSON.stringify(['playlist-v2', 'PLhistory']))}`;
  const entry = { version: 1 as const, value: { ...f.values.playlist, title: 'KV title' }, fetchedAt: stamp, freshUntil: stamp + 60_000 };
  const retained = { ...entry, value: { ...f.values.playlist, title: 'R2 title' }, fetchedAt: stamp + (state === 'newer' ? 1000 : -1000) };
  if (state !== 'missing') await saveSourceResponse(f.env, key, 'playlist-v2', retained, 7 * 86400_000);
  f.cache.get.mockResolvedValue(entry);
  const saved = await referenceSource(f.env, inspection('playlist', 'PLhistory'));
  expect(saved.title).toBe(state === 'newer' ? 'R2 title' : 'KV title');
  expect(f.load).not.toHaveBeenCalled();
});

test('retained responses expire and missing sources do not trigger extraction', async () => {
  const f = fixture();
  const key = `youtube:v1:${await sha256(JSON.stringify(['playlist-v2', 'PLhistory']))}`;
  await saveSourceResponse(f.env, key, 'playlist-v2', {
    version: 1, value: f.values.playlist, fetchedAt: Date.now() - 2000, freshUntil: Date.now() - 1000,
  }, 1000);
  expect(await readSourceResponse(f.env, key, 'playlist-v2')).toBeNull();
  await expect(referenceSource(f.env, inspection('playlist', 'PLhistory'))).rejects.toMatchObject({ code: 'SOURCE_ASSET_NOT_SAVED' });
  expect(f.load).not.toHaveBeenCalled();
});

test('zero-result searches remain saveable without storing private inputs', async () => {
  const f = fixture();
  f.values.search.results = [];
  await searchYouTubeWithCache(f.env, 'private search terms', { type: 'video' });
  const saved = await referenceSource(f.env, { input: 'private search terms', snapshot: { kind: 'search', selectedData: ['transcript'] } });
  expect(await restoreSource(f.env, saved.snapshot)).toEqual({ kind: 'search', selectedData: ['transcript'], items: [] });
  expect([...f.objects.values()].join('\n')).not.toContain('private search terms');
});
