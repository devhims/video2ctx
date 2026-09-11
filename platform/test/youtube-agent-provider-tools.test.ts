import type { VideoSummary } from 'all-things-youtube';
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { executeBrowseYouTube } from '../src/agents/providers/youtube/tools/browse-youtube';
import { executeGetChannelPlaylists } from '../src/agents/providers/youtube/tools/get-channel-playlists';
import { executeGetChannelVideos } from '../src/agents/providers/youtube/tools/get-channel-videos';
import { executeGetChannel } from '../src/agents/providers/youtube/tools/get-channel';
import { executeGetPlaylist } from '../src/agents/providers/youtube/tools/get-playlist';
import { executeGetVideoComments } from '../src/agents/providers/youtube/tools/get-video-comments';
import { executeGetVideoTracks } from '../src/agents/providers/youtube/tools/get-video-tracks';
import { executeGetVideo } from '../src/agents/providers/youtube/tools/get-video';
import { discoverInitialEvidence } from '../src/agents/research/initial-discovery';

describe('YouTube agent provider-operation tools', () => {
  it('resolves channel identity before reading its catalog and searching with its canonical ID', async () => {
    const provider: YouTubeAgentProvider = providerFixture();
    provider.search = vi.fn<YouTubeAgentProvider['search']>(async (_query, filters) => {
      expect(provider.channel).toHaveBeenCalledWith('@agentdesign');
      expect(filters?.channelId).toBe('channel-1');
      return { cacheStatus: 'hit', value: { query: 'design', results: [], videos: [], channels: [], playlists: [], meta: meta() } };
    });
    await discoverInitialEvidence({ route: 'topic_research', channelId: '@agentdesign', searchQuery: 'design' }, toolContext(provider), false);
    expect(provider.channelVideos).toHaveBeenCalledWith('channel-1', undefined, 'latest');
    expect(provider.search).toHaveBeenCalledOnce();
  });

  it('does not silently spend the search budget on global results when channel resolution fails', async () => {
    const provider = providerFixture();
    provider.channel = vi.fn(async () => { throw new Error('Channel unavailable'); });
    provider.search = vi.fn();
    await expect(discoverInitialEvidence({ route: 'topic_research', channelId: '@missing', searchQuery: 'design' }, toolContext(provider), false)).rejects.toThrow('Channel unavailable');
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.channelVideos).not.toHaveBeenCalled();
  });

  it('does not repeat search on recovery after the one-search budget was consumed', async () => {
    const provider = providerFixture();
    provider.search = vi.fn();
    await discoverInitialEvidence({ route: 'topic_research', channelId: '@agentdesign', searchQuery: 'design' }, toolContext(provider), true);
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.channelVideos).toHaveBeenCalledOnce();
  });

  it('rejects a handle resolution that returned a different channel', async () => {
    const provider = providerFixture();
    provider.search = vi.fn();
    await expect(discoverInitialEvidence({ route: 'topic_research', channelId: '@different', searchQuery: 'design' }, toolContext(provider), false)).rejects.toThrow(/does not match/);
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.channelVideos).not.toHaveBeenCalled();
  });
  it('maps each added tool wrapper to exactly one provider operation', async () => {
    const provider = providerFixture();
    const context = toolContext(provider);
    const packets = await Promise.all([
      executeBrowseYouTube({ category: 'news' }, context, 'browse-1'),
      executeGetVideo({ videoId: 'abcdefghijk' }, context, 'video-1'),
      executeGetVideoTracks({ videoId: 'abcdefghijk' }, context, 'tracks-1'),
      executeGetVideoComments({
        videoId: 'abcdefghijk', all: false,
      }, context, 'comments-1'),
      executeGetChannel({ channelId: 'channel-1' }, context, 'channel-1'),
      executeGetChannelVideos({
        channelId: 'channel-1', sort: 'latest',
      }, context, 'channel-videos-1'),
      executeGetChannelPlaylists({
        channelId: 'channel-1', sort: 'newest',
      }, context, 'channel-playlists-1'),
      executeGetPlaylist({ playlistId: 'playlist-1' }, context, 'playlist-1'),
    ]);

    expect(packets.map((packet) => packet.kind)).toEqual([
      'youtube_browse',
      'youtube_video',
      'youtube_tracks',
      'youtube_comments',
      'youtube_channel',
      'youtube_channel_videos',
      'youtube_channel_playlists',
      'youtube_playlist',
    ]);
    expect(packets.map((packet) => packet.usage[0]?.operation)).toEqual([
      'browse',
      'video',
      'tracks',
      'comments',
      'channel',
      'channelVideos',
      'channelPlaylists',
      'playlist',
    ]);

    for (const method of [
      provider.browse,
      provider.video,
      provider.tracks,
      provider.comments,
      provider.channel,
      provider.channelVideos,
      provider.channelPlaylists,
      provider.playlist,
    ]) expect(method).toHaveBeenCalledTimes(1);
  });
});

function providerFixture() {
  const video = videoFixture();
  const channel = {
    type: 'channel' as const,
    id: 'channel-1',
    name: 'Agent Design Channel',
    handle: '@agentdesign',
    thumbnails: [],
    url: 'https://www.youtube.com/@agentdesign',
    about: {
      description: 'Practical agent design lessons.',
      links: [],
      moreInfo: {
        canonicalChannelUrl: 'https://www.youtube.com/channel/channel-1',
        subscriberCount: 1000,
        subscriberCountText: '1K subscribers',
        videoCount: 20,
        videoCountText: '20 videos',
        viewCount: 100000,
        viewCountText: '100K views',
        businessEmailAvailable: false,
      },
    },
    meta: meta(),
  };
  const playlistSummary = {
    type: 'playlist' as const,
    id: 'playlist-1',
    title: 'Agent design playlist',
    description: 'A focused playlist.',
    channel: video.channel,
    thumbnails: [],
    videoCount: 1,
    videoCountText: '1 video',
    isPodcast: false,
    url: 'https://www.youtube.com/playlist?list=playlist-1',
  };

  return {
    search: vi.fn(async () => { throw new Error('Unexpected search call.'); }),
    browse: vi.fn(async () => ({
      cacheStatus: 'hit' as const,
      value: {
        category: 'news', browseId: 'FEnews', title: 'News',
        results: [video], videos: [video], channels: [], playlists: [], meta: meta(),
      },
    })),
    trends: vi.fn(async () => ({
      cacheStatus: 'miss' as const,
      value: {
        query: 'agent design',
        generatedAt: new Date().toISOString(),
        sampleSize: 1,
        methodologyVersion: '2.0' as const,
        methodology: 'Test methodology.',
        sample: { candidateVideos: 1, enrichedVideos: 1, channels: 1, observedVideos: 0 },
        confidence: { score: 50, level: 'medium' as const, reasons: ['Small sample.'] },
        summary: { totalViews: 1000, medianViewsPerHour: 10, publishedLast7Days: 1, breakoutCount: 0, acceleratingCount: 0 },
        videos: [{
          ...video,
          description: video.description ?? '',
          viewCount: video.viewCount ?? 0,
          channel: { id: video.channel.id, name: video.channel.name },
          signalSource: 'estimated' as const,
          confidenceScore: 50,
          hashtags: ['#agents'],
          keywords: ['agents'],
          trendScore: 50,
          trendBand: 'Steady' as const,
        }],
        hashtags: [],
        titlePatterns: [],
        durationMix: [],
        plan: { angle: 'Explain the workflow.', titleIdeas: [], observedHashtags: [], evidence: [] },
        warnings: [],
      },
    })),
    video: vi.fn(async () => ({
      cacheStatus: 'hit' as const,
      value: {
        ...video,
        keywords: ['agents', 'design'],
        availability: { status: 'OK', playable: true },
        meta: meta(),
      },
    })),
    tracks: vi.fn(async () => ({
      cacheStatus: 'miss' as const,
      value: {
        tracks: [{
          id: 'en', name: 'English', languageCode: 'en', kind: 'manual' as const,
          isTranslatable: true, isDefault: true,
        }],
        sourceTracks: [{
          id: 'en', name: 'English', languageCode: 'en', kind: 'manual' as const,
          isTranslatable: true, isDefault: true,
        }],
        translationLanguages: [], autoTranslationTargets: [], defaultTrackId: 'en', meta: meta(),
      },
    })),
    transcript: vi.fn(async () => { throw new Error('Unexpected transcript call.'); }),
    comments: vi.fn(async () => ({
      cacheStatus: 'hit' as const,
      value: {
        videoId: video.id,
        totalCount: 1,
        comments: [{
          id: 'comment-1', author: { name: 'Viewer', thumbnails: [] },
          text: 'The concrete example was useful.', likeCount: 3, likeCountText: '3',
          replyCount: 0, isPinned: false, isHearted: false, replies: [],
        }],
        replyContinuations: [], meta: meta(),
      },
    })),
    endscreen: vi.fn(async () => ({
      cacheStatus: 'miss' as const,
      value: [{
        type: 'video' as const, title: 'Next lesson', videoId: 'zyxwvutsrqp',
        startMs: 590000, endMs: 600000, thumbnails: [],
      }],
    })),
    channel: vi.fn(async () => ({ cacheStatus: 'hit' as const, value: channel })),
    channelVideos: vi.fn(async () => ({
      cacheStatus: 'hit' as const,
      value: { channelId: channel.id, sort: 'latest' as const, videos: [video], meta: meta() },
    })),
    channelPlaylists: vi.fn(async () => ({
      cacheStatus: 'hit' as const,
      value: { channelId: channel.id, sort: 'newest' as const, playlists: [playlistSummary], meta: meta() },
    })),
    playlist: vi.fn(async () => ({
      cacheStatus: 'hit' as const,
      value: { ...playlistSummary, videos: [video], meta: meta() },
    })),
  } satisfies YouTubeAgentProvider;
}

function toolContext(provider: YouTubeAgentProvider): AgentToolContext {
  return {
    runId: crypto.randomUUID(),
    provider,
    transcriptPolicy: { mode: 'complete_transcript' },
    signal: new AbortController().signal,
    executeEvidenceTool: (execution) => execution.execute(),
    finalize: vi.fn(async () => { throw new Error('Unexpected finalization.'); }),
  };
}

function videoFixture(): VideoSummary {
  return {
    type: 'video',
    id: 'abcdefghijk',
    title: 'Agent design lesson',
    description: 'A practical lesson about agent design.',
    channel: {
      id: 'channel-1', name: 'Agent Design Channel',
      url: 'https://www.youtube.com/channel/channel-1',
    },
    thumbnails: [],
    durationSeconds: 600,
    durationText: '10:00',
    publishedTimeText: '1 day ago',
    viewCount: 1000,
    viewCountText: '1K views',
    isLive: false,
    hasCaptions: true,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
  };
}

function meta() {
  return {
    source: 'allthingsyoutube' as const,
    fetchedAt: new Date().toISOString(),
    partial: false,
    warnings: [],
  };
}
