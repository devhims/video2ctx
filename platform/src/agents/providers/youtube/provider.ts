import type { ExtractionDiagnosticSink } from '../../../lib/extraction-diagnostics';
import { getVideoFrames, type VideoFrames, type frameRequestSchema } from '../../../lib/youtube-frames';
import type { z } from 'zod';
import { runYouTubeOperation } from '../../../lib/youtube-processor-client';
import { storyboardSchema, type Storyboard, type StoryboardSelectionOptions } from './storyboard';
import type {
  BrowseOptions,
  BrowseResponse,
  CaptionTrackList,
  Channel,
  ChannelPlaylistSort,
  ChannelPlaylists,
  ChannelVideoSort,
  ChannelVideos,
  CommentsCollection,
  CommentsPage,
  EndscreenElement,
  Playlist,
  SearchFilters,
  SearchResponse,
  Transcript,
  Video,
} from 'all-things-youtube';
import type { CachedResult } from '../../../lib/youtube';
import type { TrendReport } from '../../../lib/trends';
import { getProvider, type ProviderAdapter } from '../../../providers';

export interface YouTubeAgentProvider {
  frames?(request: z.input<typeof frameRequestSchema>, signal?: AbortSignal,
    limits?: { extractionTimeoutMs: number }, onDiagnostic?: ExtractionDiagnosticSink): Promise<CachedResult<VideoFrames>>;
  storyboard?(videoId: string, timestampsMs?: number[], options?: StoryboardSelectionOptions, onDiagnostic?: ExtractionDiagnosticSink): Promise<CachedResult<Storyboard>>;
  search(query: string, filters?: SearchFilters): Promise<CachedResult<SearchResponse>>;
  browse(options?: BrowseOptions): Promise<CachedResult<BrowseResponse>>;
  trends(query: string, limit: number, includeAiInsights: boolean): Promise<CachedResult<TrendReport>>;
  video(videoId: string): Promise<CachedResult<Video>>;
  tracks(videoId: string): Promise<CachedResult<CaptionTrackList>>;
  transcript(videoId: string, language?: string, options?: { refresh?: boolean }, onDiagnostic?: ExtractionDiagnosticSink): Promise<CachedResult<Transcript>>;
  comments(
    videoId: string,
    options?: { continuation?: string; all?: boolean; refresh?: boolean },
  ): Promise<CachedResult<CommentsPage | CommentsCollection>>;
  endscreen(videoId: string): Promise<CachedResult<EndscreenElement[]>>;
  channel(channelId: string): Promise<CachedResult<Channel>>;
  channelVideos(
    channelId: string,
    continuation?: string,
    sort?: ChannelVideoSort,
  ): Promise<CachedResult<ChannelVideos>>;
  channelPlaylists(
    channelId: string,
    continuation?: string,
    sort?: ChannelPlaylistSort,
  ): Promise<CachedResult<ChannelPlaylists>>;
  playlist(playlistId: string): Promise<CachedResult<Playlist>>;
}

export function createYouTubeAgentProvider(
  env: Env,
  provider: ProviderAdapter = getProvider('youtube'),
): YouTubeAgentProvider {
  return {
    frames: async (request, signal, limits, onDiagnostic) => ({ value: await getVideoFrames(env, request, signal, limits, onDiagnostic), cacheStatus: 'miss' }),
    storyboard: async (videoId, timestampsMs, options = {}, onDiagnostic) => ({ value: storyboardSchema.parse(await runYouTubeOperation(env, { kind: 'storyboard', id: videoId, timestampsMs, ...options }, onDiagnostic)), cacheStatus: 'miss' }),
    search: (query, filters = {}) => provider.search(env, query, filters),
    browse: (options = {}) => provider.browse(env, provider.normalizeBrowseOptions(options)),
    trends: async (query, limit, includeAiInsights) => ({
      value: await provider.trends(env, query, limit, includeAiInsights),
      cacheStatus: 'miss',
    }),
    video: (videoId) => provider.getVideo(env, videoId),
    tracks: async (videoId) => ({
      value: await provider.getTracks(env, videoId),
      cacheStatus: 'miss',
    }),
    transcript: async (videoId, language, options, onDiagnostic) => options?.refresh
      ? {value: await runYouTubeOperation(env, {kind:'transcript',id:videoId,lang:language,granularity:'word'}, onDiagnostic),cacheStatus:'miss'}
      : provider.getTranscript(env, videoId, language, onDiagnostic),
    comments: async (videoId, options = {}) => options.refresh
      ? {value: options.all ? await runYouTubeOperation(env, {kind:'all-comments',id:videoId,maxPages:100}) : await runYouTubeOperation(env, {kind:'comments',id:videoId,continuation:options.continuation}),cacheStatus:'miss'}
      : options.all
      ? provider.getAllComments(env, videoId)
      : provider.getComments(env, videoId, options.continuation),
    endscreen: async (videoId) => ({
      value: await provider.getEndscreen(env, videoId),
      cacheStatus: 'miss',
    }),
    channel: (channelId) => provider.getChannel(env, channelId),
    channelVideos: (channelId, continuation, sort) =>
      provider.getChannelVideos(env, channelId, continuation, sort),
    channelPlaylists: (channelId, continuation, sort) =>
      provider.getChannelPlaylists(env, channelId, continuation, sort),
    playlist: (playlistId) => provider.getPlaylist(env, playlistId),
  };
}
