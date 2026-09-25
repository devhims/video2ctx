import { researchTrendTopic } from '../src/lib/trends';
import { getVideo, getVideoSignals, searchYouTube } from '../src/lib/youtube';
vi.mock('../src/lib/youtube', () => ({ getVideo: vi.fn(), getVideoSignals: vi.fn(), searchYouTube: vi.fn() }));

test('records current signal counts and skips failed refreshes instead of recording saved counts', async () => {
  const ids = ['abcdefghijk', 'lmnopqrstuv'];
  vi.mocked(searchYouTube).mockResolvedValue({ videos: ids.map(id => ({ id, channel: { id, name: id } })) } as never);
  vi.mocked(getVideo).mockImplementation(async (_env, id) => ({
    id, title: id, channel: { id: 'channel', name: 'Channel' }, viewCount: 999,
    thumbnails: [], keywords: [], url: `https://youtu.be/${id}`,
  }) as never);
  vi.mocked(getVideoSignals).mockImplementation(async (_env, id, refresh) => {
    expect(refresh).toBe(true);
    if (id === ids[1]) throw new Error('Statistics unavailable');
    return { videoId: id, viewCount: 123, likeCount: 5, publishedTimeText: '2 hours ago' } as never;
  });
  const writes: unknown[][] = [];
  const env = { DB: {
    prepare: (sql: string) => ({ bind: (...args: unknown[]) => {
      if (sql.startsWith('INSERT')) writes.push(args);
      return { all: async () => ({ results: [] }) };
    } }), batch: vi.fn(),
  } } as unknown as Env;
  const report = await researchTrendTopic(env, 'agents', 8, false);
  expect(report.videos).toHaveLength(1);
  expect(report.videos[0]).toMatchObject({ id: ids[0], viewCount: 123, likeCount: 5 });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.slice(2, 4)).toEqual([123, 5]);
  expect(report.warnings).toContain('Statistics unavailable');
});
