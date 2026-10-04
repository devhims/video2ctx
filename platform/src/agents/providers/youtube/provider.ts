import type { ExtractionDiagnosticSink } from '../../../lib/extraction-diagnostics';
import { getVideoFrames, validateFrameResponse, type VideoFrames, type frameRequestSchema } from '../../../lib/youtube-frames';
import { VerifiedStoryboardSheet } from '../../../lib/verified-storyboard';
import { sheetKey, storyboardSheetSource } from '../../../lib/video-resources';
import { VerifiedFrame } from '../../../lib/verified-frame';
import type { VerifiedImage } from '../../../lib/verified-image';
import { videoCatalog, videoImageKey, prepareVideoAssetContent } from '../../../lib/video-catalog';
import { sha256 } from '../../../lib/http';
import type { z } from 'zod';
import { runYouTubeOperation } from '../../../lib/youtube-processor-client';
import { ALL_COMMENTS_MAX_PAGES, withYouTubeMetadata, getTranscriptWithCache, getVideoResource, getVideoSignalsWithCache } from '../../../lib/youtube';
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
  VideoSignals,
} from 'all-things-youtube';
import type { CachedResult } from '../../../lib/youtube';
import type { TrendReport } from '../../../lib/trends';
import { getProvider, type ProviderAdapter } from '../../../providers';

export type AgentVideo = Video & { signals?: VideoSignals & { freshness?: Record<string, unknown> } };

export interface YouTubeAgentProvider {
  frames?(request: z.input<typeof frameRequestSchema>, signal?: AbortSignal,
    limits?: { extractionTimeoutMs: number; refresh?: boolean }, onDiagnostic?: ExtractionDiagnosticSink): Promise<CachedResult<VideoFrames>>;
  storyboard?(videoId: string, timestampsMs?: number[], options?: StoryboardSelectionOptions, onDiagnostic?: ExtractionDiagnosticSink): Promise<CachedResult<Storyboard>>;
  search(query: string, filters?: SearchFilters): Promise<CachedResult<SearchResponse>>;
  browse(options?: BrowseOptions): Promise<CachedResult<BrowseResponse>>;
  trends(query: string, limit: number, includeAiInsights: boolean): Promise<CachedResult<TrendReport>>;
  video(videoId: string, options?: { refresh?: boolean; includeSignals?: boolean }): Promise<CachedResult<AgentVideo>>;
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
  researchDeadlineAt?: number,
): YouTubeAgentProvider {
  return {
    frames: async (request, signal, limits, onDiagnostic) => {
      if (!videoCatalog(env)) return { value:await getVideoFrames(env,request,signal,limits,onDiagnostic),cacheStatus:'miss' };
      signal?.throwIfAborted();
      const result = await abortable(getVideoResource(env,{kind:'frames',id:request.videoId,
        timestampsMs:request.timestampsMs,maxWidth:request.maxWidth??1920,extractionTimeoutMs:limits?.extractionTimeoutMs??45_000},
      limits?.refresh,event=>{if(!signal?.aborted) onDiagnostic?.(event);}),signal);
      // The private coordinator responds only after publishing every returned
      // frame. Carry that receipt locally instead of downloading the batch again.
      // Cache/stale results and missing references retain independent verification.
      if (env.YOUTUBE_FRAMES_BACKEND !== 'media' || result.cacheStatus !== 'miss') return result;
      const frames = validateFrameResponse({ ...request, maxWidth: request.maxWidth ?? 1920 }, result.value);
      const verifiedImages: VerifiedImage[] = [];
      const verifiedFrames = await Promise.all(frames.frames.map(async frame => {
        const reference = result.catalogVersions?.find(ref => ref.kind === 'frame' && ref.videoId === request.videoId
          && ref.variant === `v1:${request.maxWidth ?? 1920}:${frame.timestampMs}`);
        if (!reference || !/^[a-f0-9]{64}$/.test(reference.contentHash)) return undefined;
        const bytes = Uint8Array.from(atob(frame.imageBase64), c => c.charCodeAt(0));
        const frameKey = reference.imageStorage === 'inline'
          ? `youtube/videos/${request.videoId}/frame/${await sha256(reference.variant)}/${reference.contentHash}.json` : undefined;
        const receipt = new VerifiedFrame(env.VIDEO_ASSETS, reference, frame, await videoImageKey(request.videoId, bytes), frameKey);
        verifiedImages.push(receipt.match(env.VIDEO_ASSETS, reference, { videoId: request.videoId, frames: [frame] })!);
        return receipt;
      }));
      signal?.throwIfAborted();
      return { ...result, verifiedImages, verifiedFrames: verifiedFrames.filter((value): value is VerifiedFrame => !!value) };
    },
    storyboard: async (videoId, timestampsMs, options = {}, onDiagnostic) => {
      const { signal, deadlineAt: requestedDeadlineAt, ...selection } = options;
      const deadlineAt = requestedDeadlineAt === undefined ? researchDeadlineAt
        : Math.min(requestedDeadlineAt, researchDeadlineAt ?? Infinity);
      const operation = { kind: 'storyboard' as const, id: videoId, timestampsMs, ...selection,
        ...(deadlineAt === undefined ? {} : { deadlineAt }) };
      signal?.throwIfAborted();
      const diagnostic: ExtractionDiagnosticSink = event => { if (!signal?.aborted) onDiagnostic?.(event); };
      const sharedCatalog = videoCatalog(env);
      const result: CachedResult<Storyboard & { freshness?: Record<string, unknown> }> = await abortable(sharedCatalog
        ? getVideoResource(env, operation, selection.refresh, diagnostic)
        : runYouTubeOperation(env, operation, diagnostic)
          .then(value => ({value:storyboardSchema.parse(value), cacheStatus:'miss' as const})), signal);
      if (!sharedCatalog) return result;
      const board = storyboardSchema.parse(result.value);
      const value = { ...withYouTubeMetadata(board),
        ...(result.value.freshness ? { freshness: result.value.freshness } : {}) };
      // A miss includes new saves and partial-cache selections. Reconstruct each
      // immutable source and check its hash before trusting the completed response.
      // Aggregated warnings can differ from an older sheet; those use readback.
      if (result.cacheStatus !== 'miss' || board.videoId !== videoId || !board.manifest) return { ...result, value };
      const verifiedStoryboards = await Promise.all(board.sheets.map(async sheet => {
        const index = sheet.firstFrameIndex / board.manifest!.framesPerSheet;
        if (!Number.isSafeInteger(index)) return undefined;
        const key = await sheetKey(board, index);
        const reference = result.catalogVersions?.find(ref => ref.kind === key.kind
          && ref.videoId === key.videoId && ref.variant === key.variant);
        if (!reference || reference.imageStorage !== undefined || !/^[a-f0-9]{64}$/.test(reference.contentHash)) return undefined;
        const source = storyboardSheetSource(board, index);
        const content = await prepareVideoAssetContent(key, source);
        if (content.contentHash !== reference.contentHash || content.images.length !== 1) return undefined;
        return new VerifiedStoryboardSheet(env.VIDEO_ASSETS, reference, source, content.images[0]!.key);
      }));
      signal?.throwIfAborted();
      return { ...result, value, verifiedStoryboards: verifiedStoryboards.filter((receipt): receipt is VerifiedStoryboardSheet => !!receipt) };
    },
    search: (query, filters = {}) => provider.search(env, query, filters),
    browse: (options = {}) => provider.browse(env, provider.normalizeBrowseOptions(options)),
    trends: async (query, limit, includeAiInsights) => ({
      value: await provider.trends(env, query, limit, includeAiInsights),
      cacheStatus: 'miss',
    }),
    video: async (videoId, options) => {
      if (!options?.includeSignals) return provider.getVideo(env, videoId, options?.refresh);
      const [metadata, signals] = await Promise.all([
        provider.getVideo(env, videoId, options.refresh),
        getVideoSignalsWithCache(env, videoId, options.refresh),
      ]);
      return { ...metadata, value: { ...metadata.value, signals: signals.value } };
    },
    tracks: async (videoId) => ({
      value: await provider.getTracks(env, videoId),
      cacheStatus: 'miss',
    }),
    transcript: async (videoId, language, options, onDiagnostic) => researchDeadlineAt !== undefined
      ? getTranscriptWithCache(env, videoId, language, onDiagnostic, options?.refresh, researchDeadlineAt, true)
      : options?.refresh && videoCatalog(env)
      ? getVideoResource(env,{kind:'transcript',id:videoId,lang:language,granularity:'word'},true,onDiagnostic,true)
      : options?.refresh
      ? {value: await runYouTubeOperation(env, {kind:'transcript',id:videoId,lang:language,granularity:'word'}, onDiagnostic),cacheStatus:'miss'}
      : provider.getTranscript(env, videoId, language, onDiagnostic, false, undefined, true),
    comments: async (videoId, options = {}) => options.refresh && videoCatalog(env)
      ? getVideoResource(env,options.all ? {kind:'all-comments',id:videoId,maxPages:ALL_COMMENTS_MAX_PAGES}
        : {kind:'comments',id:videoId,continuation:options.continuation},true,undefined,true)
      : options.refresh
      ? {value: options.all ? await runYouTubeOperation(env, {kind:'all-comments',id:videoId,maxPages:ALL_COMMENTS_MAX_PAGES}) : await runYouTubeOperation(env, {kind:'comments',id:videoId,continuation:options.continuation}),cacheStatus:'miss'}
      : options.all
      ? provider.getAllComments(env, videoId, false, true)
      : provider.getComments(env, videoId, options.continuation, false, true),
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
