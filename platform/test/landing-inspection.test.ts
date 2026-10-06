import { beforeEach, expect, it, vi } from 'vitest';
import { loadLandingInspection } from '../src/lib/landing-inspection';
import { runYouTubeOperation } from '../src/lib/youtube-processor-client';
import { inspection } from './fixtures/landing-inspection';

const provider = vi.hoisted(() => ({ getVideo: vi.fn(), getTranscript: vi.fn(), getComments: vi.fn(), getChannel: vi.fn() }));
vi.mock('../src/providers', () => ({ getProvider: () => provider }));
vi.mock('../src/lib/youtube-processor-client', () => ({ runYouTubeOperation: vi.fn() }));
const env = {} as Env;
const fixture = inspection();
const transcript = fixture.transcript.status === 'ready' ? fixture.transcript : undefined;
const comments = fixture.comments.status === 'ready' ? fixture.comments : undefined;
const channel = fixture.channel.status === 'ready' ? fixture.channel.channel : undefined;

beforeEach(() => {
  vi.resetAllMocks();
  provider.getVideo.mockResolvedValue({ value: fixture.video });
  provider.getTranscript.mockResolvedValue({ value: { ...transcript, meta: { partial: false } } });
  provider.getComments.mockResolvedValue({ value: { ...comments, meta: { partial: false } } });
  provider.getChannel.mockResolvedValue({ value: channel });
  vi.mocked(runYouTubeOperation).mockImplementation(async (_env, operation) => {
    const value = { video: fixture.video, transcript, comments, channel }[operation.kind as 'video' | 'transcript' | 'comments' | 'channel'];
    return value as never;
  });
});

it('retains the normal provider cache path for ordinary inspections', async () => {
  expect(await loadLandingInspection(env, fixture.video.id)).toMatchObject({ video: fixture.video, partial: false });
  expect(provider.getVideo).toHaveBeenCalledWith(env, fixture.video.id);
  expect(provider.getChannel).toHaveBeenCalledWith(env, fixture.video.channel.id);
  expect(runYouTubeOperation).not.toHaveBeenCalled();
});

it('uses extraction directly during a sample storage outage, including channel details', async () => {
  expect(await loadLandingInspection(env, fixture.video.id, true)).toMatchObject({ video: fixture.video, partial: false });
  expect(runYouTubeOperation).toHaveBeenCalledTimes(4);
  expect(runYouTubeOperation).toHaveBeenCalledWith(env, { kind: 'channel', id: fixture.video.channel.id });
  for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
});

it('marks successful but partial upstream data so it cannot become a permanent sample', async () => {
  provider.getComments.mockResolvedValue({ value: { ...comments, meta: { partial: true } } });
  expect(await loadLandingInspection(env, fixture.video.id)).toHaveProperty('partial', true);
});

it('keeps the inspection usable when the fallback channel request fails', async () => {
  provider.getChannel.mockRejectedValue(new Error('Unavailable'));
  expect(await loadLandingInspection(env, fixture.video.id)).toMatchObject({ partial: true, channel: { status: 'unavailable' } });
});
