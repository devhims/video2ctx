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
  getTracks,
  getTranscript,
} from './index';

const describeLive = process.env.YOUTUBE_LIVE === '1' ? describe : describe.skip;

describeLive('live public API', () => {
  test('loads every documented resource through the standalone helpers', async () => {
    const videoId = 'MvwAWgiERBM';
    const channelId = 'UCveZqqGewoyPiacooywP5Ig';
    const playlistId = 'PLn6yDpEottdgtKuLDWNMMLAhmxE2DgygM';

    const details = await getDetails({ videoId });
    const tracks = await getTracks({ videoId });
    const transcript = await getTranscript({ videoId });
    const comments = await getComments({ videoId });
    const endscreen = await getEndscreen({ videoId });
    const channel = await getChannelInfo({ channelId });
    const videos = await getChannelVideos({ channelId, sort: 'latest' });
    const playlists = await getChannelPlaylists({ channelId, sort: 'newest' });
    const playlist = await getPlaylist({ playlistId });

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
});
