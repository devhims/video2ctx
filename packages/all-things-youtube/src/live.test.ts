import process from 'node:process';
import { describe, expect, test } from 'vitest';

import {
  getChannelInfo,
  getChannelPlaylists,
  getChannelVideos,
  getComments,
  getDetails,
  getEndscreen,
  getPlaylist,
  search,
  getTracks,
  getTranscript,
} from './index';
import { extractFrames, getWatchIndex } from './watch';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const describeLive = process.env.YOUTUBE_LIVE === '1' ? describe : describe.skip;

describeLive('live public API', () => {
  test('loads every documented resource through the standalone helpers', async () => {
    const videoId = 'MvwAWgiERBM';
    const channelId = 'UCveZqqGewoyPiacooywP5Ig';
    const playlistId = 'PLn6yDpEottdgtKuLDWNMMLAhmxE2DgygM';

    const searchResults = await search({
      query: '3Blue1Brown convolution',
      type: 'video',
      captionsOnly: true,
    });
    const details = await getDetails({ videoId });
    const tracks = await getTracks({ videoId });
    const transcript = await getTranscript({ videoId });
    const comments = await getComments({ videoId });
    const endscreen = await getEndscreen({ videoId });
    const channel = await getChannelInfo({ channelId });
    const videos = await getChannelVideos({ channelId, sort: 'latest' });
    const playlists = await getChannelPlaylists({ channelId, sort: 'newest' });
    const playlist = await getPlaylist({ playlistId });

    expect(searchResults.videos.length).toBeGreaterThan(0);
    expect(searchResults.videos.every((video) => video.hasCaptions)).toBe(true);
    expect(details.id).toBe(videoId);
    expect(tracks.sourceTracks.length).toBeGreaterThan(0);
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(Array.isArray(comments.comments)).toBe(true);
    expect(Array.isArray(endscreen)).toBe(true);
    expect(channel.id).toBe(channelId);
    expect(videos.videos.length).toBeGreaterThan(0);
    expect(playlists.playlists.length).toBeGreaterThan(0);
    expect(playlist.id).toBe(playlistId);
  }, 120_000);

  test('loads a storyboard index and exact best-effort frames', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'all-things-youtube-live-watch-'));
    try {
      const index = await getWatchIndex({
        videoId: '4vItmdk8F_M', outputDir, maxStoryboardSheets: 1,
      });
      const frames = await extractFrames({
        videoId: '4vItmdk8F_M', outputDir, timestampsMs: [30_000, 686_000, 1_000_000],
      });
      expect(index.storyboard?.sheets.length).toBe(1);
      expect(index.transcript?.segments.length).toBeGreaterThan(0);
      expect(frames.frames).toHaveLength(3);
      expect(JSON.stringify({ index, frames })).not.toContain('googlevideo.com');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 180_000);
});
