import { beforeEach, describe, expect, test, vi } from 'vitest';

import { YouTubeClientError } from 'all-things-youtube';

const mocks = vi.hoisted(() => ({
  getDetails: vi.fn(),
  getTranscript: vi.fn(),
  getStoryboard: vi.fn(),
  resolveFfmpegExecutable: vi.fn(),
  extractJpeg: vi.fn(),
  loadMediaCandidateGroup: vi.fn(),
  startMediaRangeProxy: vi.fn(),
  proxyClose: vi.fn(),
}));

vi.mock('all-things-youtube', async (importOriginal) => ({
  ...await importOriginal<typeof import('all-things-youtube')>(),
  getDetails: mocks.getDetails,
  getTranscript: mocks.getTranscript,
  getStoryboard: mocks.getStoryboard,
}));
vi.mock('./ffmpeg', () => ({
  resolveFfmpegExecutable: mocks.resolveFfmpegExecutable,
  extractJpeg: mocks.extractJpeg,
}));
vi.mock('./media', () => ({ loadMediaCandidateGroup: mocks.loadMediaCandidateGroup }));
vi.mock('./range-proxy', () => ({
  TransferBudget: class TransferBudget {},
  startMediaRangeProxy: mocks.startMediaRangeProxy,
}));

import { extractFrames, getWatchIndex } from './workflow';

const video = {
  id: 'abcdefghijk',
  type: 'video',
  title: 'Example',
  channel: { id: 'UC1', name: 'Channel', url: 'https://youtube.test/channel/UC1' },
  thumbnails: [],
  isLive: false,
  url: 'https://youtube.test/watch?v=abcdefghijk',
  keywords: [],
  durationSeconds: 60,
  availability: { status: 'OK', playable: true },
  meta: { source: 'allthingsyoutube', fetchedAt: 'now', partial: false, warnings: [] },
};

const transcript = {
  videoId: 'abcdefghijk',
  track: {
    id: 'en', name: 'English', languageCode: 'en', kind: 'manual',
    isTranslatable: true, isDefault: true,
  },
  segments: [{ startMs: 0, durationMs: 1_000, endMs: 1_000, text: 'Hello' }],
  granularity: 'segment',
  text: 'Hello',
  meta: { source: 'allthingsyoutube', fetchedAt: 'now', partial: false, warnings: [] },
};

const storyboard = {
  videoId: 'abcdefghijk',
  level: 2,
  frameCount: 25,
  intervalMs: 10_000,
  sheets: [{
    path: '/tmp/sheet.jpg', tileWidth: 160, tileHeight: 90, columns: 5, rows: 5,
    firstFrameIndex: 0, frameCount: 25, intervalMs: 10_000,
  }],
  meta: { source: 'allthingsyoutube', fetchedAt: 'now', partial: false, warnings: [] },
};

describe('youtube-ctx visual workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDetails.mockResolvedValue(video);
    mocks.getTranscript.mockResolvedValue(transcript);
    mocks.getStoryboard.mockResolvedValue(storyboard);
    mocks.resolveFfmpegExecutable.mockResolvedValue('/usr/local/bin/ffmpeg');
    mocks.loadMediaCandidateGroup.mockImplementation(async (profileIndex: number) =>
      profileIndex === 0 ? {
        profile: 'ios',
        candidates: [{
          url: 'https://signed.googlevideo.test/secret', width: 640, height: 360,
          mimeType: 'video/mp4', progressive: true, contentLength: 1_000,
        }],
      } : undefined
    );
    mocks.startMediaRangeProxy.mockResolvedValue({
      url: 'http://127.0.0.1:1234/token', close: mocks.proxyClose,
    });
  });

  test('uses segment timing by default and returns contact-sheet evidence', async () => {
    const result = await getWatchIndex({ videoId: 'abcdefghijk', outputDir: '/tmp/watch-test' });

    expect(mocks.getTranscript).toHaveBeenCalledWith({
      videoId: 'abcdefghijk', lang: undefined, granularity: 'segment',
    });
    expect(result).toMatchObject({ strategy: 'storyboard-transcript', transcript, storyboard });
  });

  test('keeps a storyboard-only index usable when captions fail', async () => {
    mocks.getTranscript.mockRejectedValue(new YouTubeClientError('NOT_FOUND', 'No captions.'));

    const result = await getWatchIndex({ videoId: 'abcdefghijk', outputDir: '/tmp/watch-test' });

    expect(result.strategy).toBe('storyboard-only');
    expect(result.transcript).toBeUndefined();
    expect(result.meta).toMatchObject({ partial: true, warnings: ['Transcript: NOT_FOUND'] });
  });

  test('rejects only when neither transcript nor storyboard is usable', async () => {
    mocks.getTranscript.mockRejectedValue(new YouTubeClientError('NOT_FOUND', 'No captions.'));
    mocks.getStoryboard.mockRejectedValue(new YouTubeClientError('NOT_FOUND', 'No storyboard.'));

    await expect(getWatchIndex({
      videoId: 'abcdefghijk', outputDir: '/tmp/watch-test',
    })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  test('returns successful frames and per-timestamp failures without leaking media URLs', async () => {
    mocks.extractJpeg.mockImplementation(async (
      _ffmpeg: string,
      _input: string,
      _output: string,
      _videoId: string,
      timestampMs: number,
    ) => {
      if (timestampMs === 2_000) {
        throw new YouTubeClientError('FRAME_EXTRACTION_FAILED', 'Could not decode.', { retryable: true });
      }
      return {
        timestampMs, path: `/tmp/frame-${timestampMs}.jpg`, mimeType: 'image/jpeg',
        width: 640, height: 360, sourceWidth: 640, sourceHeight: 360,
      };
    });

    const result = await extractFrames({
      videoId: 'abcdefghijk', outputDir: '/tmp/watch-test', timestampsMs: [1_000, 2_000],
    });

    expect(result.frames).toHaveLength(1);
    expect(result.failures).toEqual([expect.objectContaining({
      timestampMs: 2_000, code: 'FRAME_EXTRACTION_FAILED', retryable: true,
    })]);
    expect(result.meta.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain('googlevideo');
    expect(mocks.extractJpeg).toHaveBeenCalledWith(
      '/usr/local/bin/ffmpeg', 'http://127.0.0.1:1234/token', expect.any(String),
      'abcdefghijk', 1_000, 1_280, 640, 360,
    );
    expect(mocks.proxyClose).toHaveBeenCalled();
  });

  test('classifies a missing FFmpeg dependency before resolving media', async () => {
    mocks.resolveFfmpegExecutable.mockRejectedValue(new YouTubeClientError(
      'DEPENDENCY_MISSING', 'FFmpeg is required.',
    ));

    await expect(extractFrames({
      videoId: 'abcdefghijk', outputDir: '/tmp/watch-test', timestampsMs: [1_000],
    })).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
    expect(mocks.loadMediaCandidateGroup).not.toHaveBeenCalled();
  });
});
