import { getVideoFrames } from '../src/lib/youtube-frames';
import { getYouTubeMediaFrames } from '../src/lib/youtube-media-frames';
import { acquireFrameLease } from '../src/lib/frame-media-admission';
import { FrameMediaError } from '../src/lib/frame-media-io';
import { getContainer } from '@cloudflare/containers';

vi.mock('../src/lib/youtube-media-frames', () => ({ getYouTubeMediaFrames: vi.fn() }));
vi.mock('../src/lib/frame-media-admission', () => ({ acquireFrameLease: vi.fn() }));
vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));
const env = { YOUTUBE_FRAMES_BACKEND: 'media' } as Env;
const input = { videoId: 'abcdefghijk', timestampsMs: [1000], maxWidth: 640 };
beforeEach(() => vi.clearAllMocks());

test('FFmpeg admission exhaustion returns PROCESSOR_BUSY with the Media extraction ID', async () => {
  const extractionId = crypto.randomUUID();
  vi.mocked(getYouTubeMediaFrames).mockImplementation(async (_env, _input, _signal, diagnostic) => {
    diagnostic?.({ version: 1, kind: 'frames', backend: 'media', videoId: input.videoId, extractionId,
      attempt: 1, slot: 0, recordedAt: Date.now(), elapsedMs: 1, outcome: 'fallback', capture: 'available', events: [], droppedEvents: 0 });
    return { frames: [], reason: 'source' };
  });
  vi.mocked(acquireFrameLease).mockRejectedValue(new FrameMediaError('capacity'));
  const diagnostic = vi.fn();
  await expect(getVideoFrames(env, input, undefined, undefined, diagnostic)).rejects.toMatchObject({
    status: 503, code: 'PROCESSOR_BUSY', details: { extractionId },
  });
  expect(acquireFrameLease).toHaveBeenCalledWith(env, 'ffmpeg-job', expect.any(AbortSignal));
  expect(getContainer).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledOnce();
});

test('partial Media success survives full FFmpeg capacity with a retryable busy failure', async () => {
  const frame = { timestampMs: 1000, width: 640, height: 360, mimeType: 'image/jpeg' as const, imageBase64: '/9j/AA==' };
  vi.mocked(getYouTubeMediaFrames).mockResolvedValue({ frames: [frame], reason: 'source' });
  vi.mocked(acquireFrameLease).mockRejectedValue(new FrameMediaError('capacity'));
  const result = await getVideoFrames(env, { ...input, timestampsMs: [1000,2000] });
  expect(result.frames).toEqual([frame]);
  expect(result.failures).toEqual([expect.objectContaining({ timestampMs: 2000, code: 'PROCESSOR_BUSY', retryable: true })]);
  expect(getContainer).not.toHaveBeenCalled();
});
