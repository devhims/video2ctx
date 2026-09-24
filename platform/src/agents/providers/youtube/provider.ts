import type { ExtractionDiagnosticSink } from '../../../lib/extraction-diagnostics';
import { getVideoFrames, type VideoFrames, type frameRequestSchema } from '../../../lib/youtube-frames';
import type { z } from 'zod';
import { runYouTubeOperation } from '../../../lib/youtube-processor-client';
import { getVideoResource } from '../../../lib/youtube';
import { videoCatalog } from '../../../lib/video-catalog';
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
    limits?: { extractionTimeoutMs: number; refresh?: boolean }, onDiagnostic?: ExtractionDiagnosticSink): Promise<CachedResult<VideoFrames>>;
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
    frames: async (request, signal, limits, onDiagnostic) => {
      if (!videoCatalog(env)) return { value:await getVideoFrames(env,request,signal,limits,onDiagnostic),cacheStatus:'miss' };
      signal?.throwIfAborted();
      return abortable(getVideoResource(env,{kind:'frames',id:request.videoId,
        timestampsMs:request.timestampsMs,maxWidth:request.maxWidth??1920,extractionTimeoutMs:limits?.extractionTimeoutMs??45_000},
      limits?.refresh,event=>{if(!signal?.aborted) onDiagnostic?.(event);}),signal);
    },
    storyboard: async (videoId, timestampsMs, options = {}, onDiagnostic) => videoCatalog(env)
      ? getVideoResource(env,{kind:'storyboard',id:videoId,timestampsMs,...options},options.refresh,onDiagnostic)
      : ({ value: storyboardSchema.parse(await runYouTubeOperation(env, { kind: 'storyboard', id: videoId, timestampsMs, ...options }, onDiagnostic)), cacheStatus: 'miss' }),
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
    transcript: async (videoId, language, options, onDiagnostic) => options?.refresh && videoCatalog(env)
      ? getVideoResource(env,{kind:'transcript',id:videoId,lang:language,granularity:'word'},true,onDiagnostic)
      : options?.refresh
      ? {value: await runYouTubeOperation(env, {kind:'transcript',id:videoId,lang:language,granularity:'word'}, onDiagnostic),cacheStatus:'miss'}
      : provider.getTranscript(env, videoId, language, onDiagnostic),
    comments: async (videoId, options = {}) => options.refresh && videoCatalog(env)
      ? getVideoResource(env,options.all ? {kind:'all-comments',id:videoId,maxPages:100}
        : {kind:'comments',id:videoId,continuation:options.continuation},true)
      : options.refresh
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

// Cancelling one waiter must not cancel extraction shared with another run.
async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let cancel!: () => void;
  const aborted = new Promise<never>((_,reject)=> {
    cancel=()=>reject(signal.reason);
    signal.addEventListener('abort',cancel,{once:true});
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([work,aborted]); }
  finally { signal.removeEventListener('abort',cancel); }
}
