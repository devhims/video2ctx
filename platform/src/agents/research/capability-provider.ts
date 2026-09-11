import type { CapabilityRouteDecision } from '../contracts';
import type { YouTubeAgentProvider } from '../providers/youtube/provider';

type ExecutableRoute = Extract<CapabilityRouteDecision, { route: 'topic_research' | 'inspect_video' }>;

export function createCapabilityProvider(
  provider: YouTubeAgentProvider,
  decision: ExecutableRoute,
): YouTubeAgentProvider {
  if (decision.useStoryboard === false) provider = { ...provider, storyboard: undefined };
  if (decision.route === 'topic_research') return provider;
  const requirePinnedVideo = (videoId: string) => {
    if (videoId !== decision.videoId) {
      throw new Error(`inspect_video is pinned to video ${decision.videoId}.`);
    }
  };

  return {
    storyboard: async (videoId, timestampsMs, options) => {
      requirePinnedVideo(videoId);
      if (!provider.storyboard) throw new Error('Storyboard provider is unavailable.');
      return provider.storyboard(videoId, timestampsMs, options);
    },
    search: (query, filters) => provider.search(query, filters),
    browse: (options) => provider.browse(options),
    trends: (query, limit, includeAiInsights) => provider.trends(query, limit, includeAiInsights),
    video: async (videoId) => {
      requirePinnedVideo(videoId);
      return await provider.video(videoId);
    },
    tracks: async (videoId) => {
      requirePinnedVideo(videoId);
      return await provider.tracks(videoId);
    },
    transcript: async (videoId, language) => {
      requirePinnedVideo(videoId);
      return await provider.transcript(videoId, language);
    },
    comments: async (videoId, options) => {
      requirePinnedVideo(videoId);
      return await provider.comments(videoId, options);
    },
    endscreen: async (videoId) => {
      requirePinnedVideo(videoId);
      return await provider.endscreen(videoId);
    },
    channel: (channelId) => provider.channel(channelId),
    channelVideos: (channelId, continuation, sort) =>
      provider.channelVideos(channelId, continuation, sort),
    channelPlaylists: (channelId, continuation, sort) =>
      provider.channelPlaylists(channelId, continuation, sort),
    playlist: (playlistId) => provider.playlist(playlistId),
  };
}
