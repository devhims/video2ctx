import { loadMediaCandidateGroup } from '../watch/media';
import { startMediaRangeProxy, TransferBudget, type MediaRangeProxy } from '../watch/range-proxy';
import { MediaError, probeMaster, type MasterInfo } from './media';

/** Upper bound on bytes pulled from YouTube for one shots or render run. */
const SOURCE_TRANSFER_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export interface YouTubeSource {
  url: string;
  info: MasterInfo;
  formatId?: number;
  close(): Promise<void>;
}

/**
 * Open YouTube's progressive stream (video with audio, usually 360p) behind a local
 * range proxy, so FFmpeg can seek straight to each cut without downloading the video.
 */
export async function openYouTubeSource(ffmpeg: string, videoId: string, requestFetch: typeof fetch): Promise<YouTubeSource> {
  const budget = new TransferBudget(SOURCE_TRANSFER_LIMIT_BYTES);
  let lastError: unknown;
  for (const profileIndex of [1, 0, 2, 3]) {
    const group = await loadMediaCandidateGroup(profileIndex, videoId, 1920, { fetch: requestFetch });
    for (const candidate of group?.candidates.filter((item) => item.progressive) ?? []) {
      let proxy: MediaRangeProxy | undefined;
      try {
        proxy = await startMediaRangeProxy(candidate, requestFetch, budget);
        const info = await probeMaster(ffmpeg, proxy.url);
        if (!info.hasAudio) throw new MediaError('The YouTube stream has no audio.');
        const opened = proxy;
        return { url: opened.url, info, formatId: candidate.formatId, close: () => opened.close() };
      } catch (error) {
        lastError = error;
        await proxy?.close();
      }
    }
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new MediaError(`Could not open a YouTube stream with audio for ${videoId}.${detail}`);
}
