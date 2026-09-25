import { createYouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { getProvider } from '../src/providers';

test('fetches current signal counts only when requested and surfaces refresh failures', async () => {
  const adapter = { ...getProvider('youtube'), getVideo: vi.fn(async () => ({
    cacheStatus: 'miss', value: { id: 'abcdefghijk', viewCount: 10 },
  })) } as unknown as ReturnType<typeof getProvider>;
  const getOrLoad = vi.fn(async (input: string) => {
    expect(JSON.parse(input)).toMatchObject({ operation: { kind: 'video-signals', id: 'abcdefghijk' }, refresh: true });
    return JSON.stringify({ ok: true, cacheStatus: 'miss', fetchedAt: 1000,
      value: { videoId: 'abcdefghijk', viewCount: 11, likeCount: 2, commentCount: 1 } });
  });
  const env = { YOUTUBE_CACHE: { get: vi.fn(async () => null) },
    YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad }) } } as unknown as Env;
  const provider = createYouTubeAgentProvider(env, adapter);
  await provider.video('abcdefghijk');
  expect(getOrLoad).not.toHaveBeenCalled();
  expect(await provider.video('abcdefghijk', { refresh: true, includeSignals: true })).toMatchObject({
    value: { signals: { viewCount: 11, likeCount: 2, commentCount: 1, freshness: { state: 'fresh', fetchedAt: 1000 } } },
  });
  expect(adapter.getVideo).toHaveBeenLastCalledWith(env, 'abcdefghijk', true);
  getOrLoad.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'offline' } }));
  await expect(provider.video('abcdefghijk', { refresh: true, includeSignals: true })).rejects.toThrow('offline');
});
