import type { CapabilityRouteDecision } from '../contracts';
import type { YouTubeAgentProvider } from '../providers/youtube/provider';

type ExecutableRoute = Extract<CapabilityRouteDecision, { route: 'topic_research' | 'inspect_video' }>;

/** Beneath session reuse, so even incidental analyst metadata reads cannot fetch. */
export function savedOnlyProvider(): YouTubeAgentProvider {
  const unavailable = async (): Promise<never> => {
    throw new Error('Fresh retrieval is prohibited for this saved-only request. Read existing session evidence or report the missing source.');
  };
  return { search: unavailable, browse: unavailable, trends: unavailable, video: unavailable,
    tracks: unavailable, transcript: unavailable, comments: unavailable, endscreen: unavailable,
    channel: unavailable, channelVideos: unavailable, channelPlaylists: unavailable, playlist: unavailable,
    frames: unavailable, storyboard: unavailable };
}

export function createCapabilityProvider(
  provider: YouTubeAgentProvider,
  decision: ExecutableRoute,
): YouTubeAgentProvider {
  const savedProvider = provider;
  provider = {
    ...provider,
    video: (id, options) => decision.refreshDynamicData || decision.refreshEvidence
      ? savedProvider.video(id, { ...options, refresh: true, ...(decision.refreshDynamicData ? { includeSignals: true } : {}) }) : savedProvider.video(id, options),
    // A pinned saved-page read continues a page this session already holds; it never refreshes.
    comments: (id, options) => decision.refreshDynamicData && !options?.pageVersion
      ? savedProvider.comments(id, { ...options, refresh: true }) : savedProvider.comments(id, options),
  };
  if (decision.useStoryboard === false) provider = { ...provider, storyboard: undefined, frames: undefined };
  if (decision.route === 'topic_research') return provider;
  const requirePinnedVideo = (videoId: string) => {
    if (videoId !== decision.videoId) {
      throw new Error(`inspect_video is pinned to video ${decision.videoId}.`);
    }
  };

  return {
    frames: async (request, signal, limits, onDiagnostic, onReady) => {
      requirePinnedVideo(request.videoId);
      if (!provider.frames) throw new Error('Frame provider is unavailable.');
      return provider.frames(request, signal, limits, onDiagnostic, ...(onReady ? [onReady] : []));
    },
    storyboard: async (videoId, timestampsMs, options, onDiagnostic, onReady) => {
      requirePinnedVideo(videoId);
      if (!provider.storyboard) throw new Error('Storyboard provider is unavailable.');
      return provider.storyboard(videoId, timestampsMs, options, onDiagnostic, ...(onReady ? [onReady] : []));
    },
    search: (query, filters) => provider.search(query, filters),
    browse: (options) => provider.browse(options),
    trends: (query, limit, includeAiInsights) => provider.trends(query, limit, includeAiInsights),
    video: async (videoId, options) => {
      requirePinnedVideo(videoId);
      return await provider.video(videoId, options);
    },
    tracks: async (videoId) => {
      requirePinnedVideo(videoId);
      return await provider.tracks(videoId);
    },
    transcript: async (videoId, language, options, onDiagnostic, onReady) => {
      requirePinnedVideo(videoId);
      if (onReady) return provider.transcript(videoId, language, options, onDiagnostic, onReady);
      if (onDiagnostic) return provider.transcript(videoId, language, options, onDiagnostic);
      return provider.transcript(videoId, language, options);
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
