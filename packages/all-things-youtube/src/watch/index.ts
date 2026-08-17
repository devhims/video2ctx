import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { createYouTubeClient } from '../youtube-client';
import { YouTubeClientError, type SourceMetadata, type YouTubeClientOptions } from '../youtube-types';
import { extractJpeg, resolveFfmpegExecutable } from './ffmpeg';
import { callIosWatchPlayer } from './innertube';
import { loadMediaCandidateGroup } from './media';
import { startMediaRangeProxy, TransferBudget } from './range-proxy';
import { downloadStoryboard } from './storyboard';
import type {
  ExtractedFrame,
  ExtractFramesRequest,
  FrameExtractionFailure,
  FrameExtractionResult,
  WatchIndex,
  WatchIndexRequest,
} from './types';

export type * from './types';

const DEFAULT_MAX_STORYBOARD_SHEETS = 12;
const MAX_STORYBOARD_SHEETS = 20;
const DEFAULT_MAX_WIDTH = 1_280;
const MAX_WIDTH = 1_920;
const MAX_TIMESTAMPS = 30;

function optionsFrom(options: YouTubeClientOptions): YouTubeClientOptions {
  return {
    fetch: options.fetch,
    language: options.language,
    region: options.region,
    retry: options.retry,
  };
}

function validateIndexRequest(options: WatchIndexRequest): number {
  if (!/^[A-Za-z0-9_-]{11}$/.test(options.videoId)) {
    throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
  }
  if (typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
    throw new YouTubeClientError('INVALID_INPUT', 'outputDir is required.');
  }
  if (options.granularity && !['segment', 'word'].includes(options.granularity)) {
    throw new YouTubeClientError('INVALID_INPUT', 'granularity must be segment or word.');
  }
  const maxSheets = options.maxStoryboardSheets ?? DEFAULT_MAX_STORYBOARD_SHEETS;
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1 || maxSheets > MAX_STORYBOARD_SHEETS) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      `maxStoryboardSheets must be an integer from 1 to ${MAX_STORYBOARD_SHEETS}.`,
    );
  }
  return maxSheets;
}

function metadata(warnings: string[], partial: boolean): SourceMetadata {
  return {
    source: 'allthingsyoutube',
    fetchedAt: new Date().toISOString(),
    partial,
    warnings,
  };
}

function safeWarning(prefix: string, error: unknown): string {
  if (error instanceof YouTubeClientError) return `${prefix}: ${error.code}`;
  return `${prefix}: unavailable`;
}

export async function getWatchIndex(options: WatchIndexRequest): Promise<WatchIndex> {
  const maxSheets = validateIndexRequest(options);
  const clientOptions = optionsFrom(options);
  const client = createYouTubeClient(clientOptions);
  const outputDir = resolve(options.outputDir);
  const [video, transcriptResult, playerResult] = await Promise.all([
    client.getVideo(options.videoId),
    client.getTranscript({
      videoId: options.videoId,
      translateTo: options.lang,
      granularity: options.granularity ?? 'segment',
    }).then((value) => ({ value })).catch((error: unknown) => ({ error })),
    callIosWatchPlayer(options.videoId, clientOptions)
      .then((value) => ({ value }))
      .catch((error: unknown) => ({ error })),
  ]);
  if (video.isLive) {
    throw new YouTubeClientError('UNAVAILABLE', 'Live videos are not supported by watch extraction.');
  }

  const warnings: string[] = [];
  const transcript = 'value' in transcriptResult ? transcriptResult.value : undefined;
  if ('error' in transcriptResult) {
    warnings.push(safeWarning('Transcript', transcriptResult.error));
  }

  let storyboard;
  if ('value' in playerResult) {
    try {
      storyboard = await downloadStoryboard(
        playerResult.value.raw,
        options.videoId,
        outputDir,
        maxSheets,
        clientOptions,
      );
      if (!storyboard) warnings.push('Storyboard: unavailable');
      else if (storyboard.sheets.length < Math.ceil(
        storyboard.frameCount / (storyboard.sheets[0]!.columns * storyboard.sheets[0]!.rows),
      )) warnings.push(`Storyboard: limited to ${storyboard.sheets.length} sheets`);
    } catch (error) {
      warnings.push(safeWarning('Storyboard', error));
    }
  } else {
    warnings.push(safeWarning('Storyboard', playerResult.error));
  }

  if (!transcript && !storyboard?.sheets.length) {
    throw new YouTubeClientError('UNAVAILABLE', 'No transcript or storyboard index is available.');
  }
  const strategy = transcript && storyboard?.sheets.length
    ? 'storyboard-transcript'
    : storyboard?.sheets.length ? 'storyboard-only' : 'transcript-only';
  return {
    videoId: options.videoId,
    video,
    strategy,
    transcript,
    storyboard,
    meta: metadata(warnings, warnings.length > 0),
  };
}

function validateFrameRequest(options: ExtractFramesRequest): { timestamps: number[]; maxWidth: number } {
  if (!/^[A-Za-z0-9_-]{11}$/.test(options.videoId)) {
    throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
  }
  if (typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
    throw new YouTubeClientError('INVALID_INPUT', 'outputDir is required.');
  }
  if (!Array.isArray(options.timestampsMs) || options.timestampsMs.length < 1
    || options.timestampsMs.length > MAX_TIMESTAMPS) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      `timestampsMs must contain between 1 and ${MAX_TIMESTAMPS} values.`,
    );
  }
  if (options.timestampsMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new YouTubeClientError('INVALID_INPUT', 'timestampsMs must contain non-negative integers.');
  }
  const timestamps = [...new Set(options.timestampsMs)].sort((a, b) => a - b);
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 320 || maxWidth > MAX_WIDTH) {
    throw new YouTubeClientError('INVALID_INPUT', `maxWidth must be an integer from 320 to ${MAX_WIDTH}.`);
  }
  return { timestamps, maxWidth };
}

function failure(timestampMs: number, error: unknown): FrameExtractionFailure {
  if (error instanceof YouTubeClientError) {
    return { timestampMs, code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    timestampMs,
    code: 'FRAME_EXTRACTION_FAILED',
    message: 'The requested frame could not be extracted.',
    retryable: true,
  };
}

async function extractConcurrent(
  timestamps: number[],
  run: (timestampMs: number) => Promise<ExtractedFrame>,
): Promise<Array<{ timestampMs: number; frame?: ExtractedFrame; error?: unknown }>> {
  const results: Array<{ timestampMs: number; frame?: ExtractedFrame; error?: unknown }> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < timestamps.length) {
      const timestampMs = timestamps[cursor++]!;
      try {
        results.push({ timestampMs, frame: await run(timestampMs) });
      } catch (error) {
        results.push({ timestampMs, error });
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}

export async function extractFrames(options: ExtractFramesRequest): Promise<FrameExtractionResult> {
  const { timestamps, maxWidth } = validateFrameRequest(options);
  const clientOptions = optionsFrom(options);
  const client = createYouTubeClient(clientOptions);
  const video = await client.getVideo(options.videoId);
  if (video.isLive) {
    throw new YouTubeClientError('UNAVAILABLE', 'Live videos are not supported by watch extraction.');
  }
  if (video.durationSeconds !== undefined) {
    const durationMs = video.durationSeconds * 1_000;
    if (timestamps.some((timestamp) => timestamp >= durationMs)) {
      throw new YouTubeClientError('INVALID_INPUT', 'Every timestamp must be within the video duration.');
    }
  }
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const ffmpegCommand = options.ffmpegPath?.trim() || process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const ffmpegPath = await resolveFfmpegExecutable(ffmpegCommand);

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const budget = new TransferBudget();
  const frames = new Map<number, ExtractedFrame>();
  const lastErrors = new Map<number, unknown>();

  for (let profileIndex = 0; profileIndex < 4 && frames.size < timestamps.length; profileIndex += 1) {
    const group = await loadMediaCandidateGroup(
      profileIndex,
      options.videoId,
      maxWidth,
      clientOptions,
    );
    if (!group) continue;
    for (const candidate of group.candidates) {
      const pending = timestamps.filter((timestamp) => !frames.has(timestamp));
      if (!pending.length) break;
      const proxy = await startMediaRangeProxy(candidate, fetchImpl, budget);
      const run = (timestampMs: number) => extractJpeg(
        ffmpegPath,
        proxy.url,
        outputDir,
        options.videoId,
        timestampMs,
        maxWidth,
        candidate.width,
        candidate.height,
      );
      try {
        const firstTimestamp = pending[0]!;
        try {
          frames.set(firstTimestamp, await run(firstTimestamp));
        } catch (error) {
          lastErrors.set(firstTimestamp, error);
          continue;
        }
        const remaining = pending.slice(1);
        for (const result of await extractConcurrent(remaining, run)) {
          if (result.frame) frames.set(result.timestampMs, result.frame);
          else lastErrors.set(result.timestampMs, result.error);
        }
      } finally {
        await proxy.close();
      }
    }
  }

  if (!frames.size) {
    throw new YouTubeClientError(
      'MEDIA_UNAVAILABLE',
      'No seekable YouTube media format could produce the requested frames.',
      { retryable: true },
    );
  }
  const failures = timestamps
    .filter((timestamp) => !frames.has(timestamp))
    .map((timestamp) => failure(timestamp, lastErrors.get(timestamp)));
  const orderedFrames = [...frames.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  const warnings = failures.length ? [`${failures.length} requested frame(s) could not be extracted.`] : [];
  if (orderedFrames.some((frame) => (frame.sourceHeight ?? 0) > 0 && (frame.sourceHeight ?? 0) < 720)) {
    warnings.push('Best-effort media fallback produced frames below 720p.');
  }
  return {
    videoId: options.videoId,
    frames: orderedFrames,
    failures,
    meta: metadata(warnings, failures.length > 0),
  };
}
