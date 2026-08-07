import { createYouTubeClient, type YouTubeClient } from './youtube-client';
import { YouTubeClientError } from './youtube-types';
import type {
  Channel,
  ChannelPlaylistSort,
  ChannelPlaylists,
  ChannelVideoSort,
  ChannelVideos,
  CommentCollection,
  CommentPage,
  EndscreenElement,
  Playlist,
  Transcript,
  Video,
  CaptionTrackList,
  YouTubeClientOptions,
} from './youtube-types';

export { YouTubeClientError };
export type * from './youtube-types';
export type * from './youtube-transport';

export interface LibraryOptions extends YouTubeClientOptions {}

export interface VideoRequest extends LibraryOptions {
  videoId: string;
}

export interface TranscriptRequest extends VideoRequest {
  /** Desired output language. The source track is selected automatically. */
  lang?: string;
  granularity?: 'segment' | 'word';
}

export interface CommentsRequest extends VideoRequest {
  continuation?: string;
  all?: false;
}

export interface AllCommentsRequest extends VideoRequest {
  all: true;
  maxPages?: number;
}

export interface ChannelRequest extends LibraryOptions {
  /** A YouTube channel ID or @handle. */
  channelId: string;
}

export interface ChannelVideosRequest extends ChannelRequest {
  continuation?: string;
  sort?: ChannelVideoSort;
}

export interface ChannelPlaylistsRequest extends ChannelRequest {
  continuation?: string;
  sort?: ChannelPlaylistSort;
}

export interface PlaylistRequest extends LibraryOptions {
  playlistId: string;
  continuation?: string;
}

export type CommentsPage = Omit<CommentPage, 'replyContinuations' | 'newestContinuation'>;
export type CommentsCollection = Omit<CommentCollection, 'replyContinuations' | 'newestContinuation'>;

function optionsFrom(options: LibraryOptions): YouTubeClientOptions {
  return {
    fetch: options.fetch,
    language: options.language,
    region: options.region,
    retry: options.retry,
  };
}

function assertChannelVideoSort(sort: unknown): asserts sort is ChannelVideoSort | undefined {
  if (sort !== undefined && !['latest', 'popular', 'oldest'].includes(String(sort))) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      'sort must be one of: latest, popular, oldest.'
    );
  }
}

function assertChannelPlaylistSort(
  sort: unknown
): asserts sort is ChannelPlaylistSort | undefined {
  if (sort !== undefined && !['newest', 'last-video-added'].includes(String(sort))) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      'sort must be one of: newest, last-video-added.'
    );
  }
}

function assertPlaylistId(playlistId: string): void {
  if (
    !/^[A-Za-z0-9_-]{2,}$/.test(playlistId) ||
    (playlistId.startsWith('PL') && playlistId.length !== 34)
  ) {
    throw new YouTubeClientError('INVALID_INPUT', 'playlistId is malformed.');
  }
}

async function resolveChannelId(client: YouTubeClient, channelId: string): Promise<string> {
  if (!channelId.startsWith('@')) return channelId;
  const result = await client.search(channelId, { type: 'channel' });
  const channel = result.channels[0];
  if (!channel) {
    throw new YouTubeClientError(
      'NOT_FOUND',
      `Could not resolve YouTube channel handle ${channelId}.`,
      { status: 404 }
    );
  }
  return channel.id;
}

/** Return source caption tracks and supported auto-translation targets. */
export function getTracks(options: VideoRequest): Promise<CaptionTrackList> {
  return createYouTubeClient(optionsFrom(options)).getCaptionTracks(options.videoId);
}

/** Return a timed transcript, translated to `lang` when requested. */
export function getTranscript(options: TranscriptRequest): Promise<Transcript> {
  return createYouTubeClient(optionsFrom(options)).getTranscript({
    videoId: options.videoId,
    translateTo: options.lang,
    granularity: options.granularity,
  });
}

export function getComments(options: AllCommentsRequest): Promise<CommentsCollection>;
export function getComments(options: CommentsRequest): Promise<CommentsPage>;
export async function getComments(
  options: CommentsRequest | AllCommentsRequest
): Promise<CommentsPage | CommentsCollection> {
  const client = createYouTubeClient(optionsFrom(options));
  const result = options.all
    ? await client.getAllComments({ videoId: options.videoId, maxPages: options.maxPages })
    : await client.getComments({ videoId: options.videoId, continuation: options.continuation });
  const {
    replyContinuations: _replyContinuations,
    newestContinuation: _newestContinuation,
    ...publicResult
  } = result;
  return publicResult;
}

/** Return core video metadata without transcript, track, or endscreen subresources. */
export function getDetails(options: VideoRequest): Promise<Video> {
  return createYouTubeClient(optionsFrom(options)).getVideo(options.videoId);
}

/** Return the interactive elements shown during the video's end screen. */
export function getEndscreen(options: VideoRequest): Promise<EndscreenElement[]> {
  return createYouTubeClient(optionsFrom(options)).getEndscreen(options.videoId);
}

/** Return channel identity and the public About information shown by YouTube. */
export async function getChannelInfo(options: ChannelRequest): Promise<Channel> {
  const client = createYouTubeClient(optionsFrom(options));
  return client.getChannel(await resolveChannelId(client, options.channelId));
}

/** Return one page from a channel's Videos tab. */
export async function getChannelVideos(options: ChannelVideosRequest): Promise<ChannelVideos> {
  assertChannelVideoSort(options.sort);
  const client = createYouTubeClient(optionsFrom(options));
  const channelId = await resolveChannelId(client, options.channelId);
  return client.getChannelVideos(channelId, options.continuation, options.sort);
}

/** Return one page from a channel's Playlists tab. */
export async function getChannelPlaylists(
  options: ChannelPlaylistsRequest
): Promise<ChannelPlaylists> {
  assertChannelPlaylistSort(options.sort);
  const client = createYouTubeClient(optionsFrom(options));
  const channelId = await resolveChannelId(client, options.channelId);
  return client.getChannelPlaylists(channelId, options.continuation, options.sort);
}

/** Return playlist metadata and one page of videos. */
export async function getPlaylist(options: PlaylistRequest): Promise<Playlist> {
  assertPlaylistId(options.playlistId);
  return await createYouTubeClient(optionsFrom(options)).getPlaylist(
    options.playlistId,
    options.continuation
  );
}
