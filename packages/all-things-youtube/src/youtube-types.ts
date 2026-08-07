import type { YouTubeRetryOptions } from './youtube-transport';

export type YouTubeEntityType = 'video' | 'channel' | 'playlist';

export interface SourceMetadata {
  source: 'allthingsyoutube';
  fetchedAt: string;
  partial: boolean;
  warnings: string[];
}

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface ContinuationPage {
  continuation?: string;
  estimatedTotal?: number;
}

export interface Availability {
  status: string;
  reason?: string;
  playable: boolean;
  embeddable?: boolean;
  isPrivate?: boolean;
  isLive?: boolean;
  ratingsAllowed?: boolean;
}

export interface ChannelSummary {
  type: 'channel';
  id: string;
  name: string;
  description?: string;
  handle?: string;
  subscriberCountText?: string;
  videoCountText?: string;
  thumbnails: Thumbnail[];
  url: string;
}

export interface VideoSummary {
  type: 'video';
  id: string;
  title: string;
  description?: string;
  channel: Pick<ChannelSummary, 'id' | 'name' | 'url'>;
  thumbnails: Thumbnail[];
  durationSeconds?: number;
  durationText?: string;
  publishedTimeText?: string;
  viewCount?: number;
  viewCountText?: string;
  isLive: boolean;
  hasCaptions?: boolean;
  url: string;
}

export interface PlaylistSummary {
  type: 'playlist';
  id: string;
  title: string;
  description?: string;
  channel?: Pick<ChannelSummary, 'id' | 'name' | 'url'>;
  thumbnails: Thumbnail[];
  videoCount?: number;
  videoCountText?: string;
  updatedTimeText?: string;
  isPodcast: boolean;
  playUrl?: string;
  url: string;
}

export type ChannelVideoSort = 'latest' | 'popular' | 'oldest';
export type ChannelPlaylistSort = 'newest' | 'last-video-added';

export type SearchResult = VideoSummary | ChannelSummary | PlaylistSummary;

export interface SearchFilters {
  type?: YouTubeEntityType | 'all';
  channelId?: string;
  dateFrom?: string;
  dateTo?: string;
  duration?: 'short' | 'medium' | 'long';
  language?: string;
  captionsOnly?: boolean;
  live?: 'live' | 'upcoming' | 'completed';
  minViews?: number;
  sort?: 'relevance' | 'date' | 'views' | 'rating';
  continuation?: string;
}

export interface SearchResponse extends ContinuationPage {
  query: string;
  results: SearchResult[];
  videos: VideoSummary[];
  channels: ChannelSummary[];
  playlists: PlaylistSummary[];
  meta: SourceMetadata;
}

export interface BrowseOptions {
  browseId?: string;
  params?: string;
  categoryId?: string;
  region?: string;
  language?: string;
  continuation?: string;
}

export interface BrowseResponse extends ContinuationPage {
  category?: string;
  browseId?: string;
  title?: string;
  results: SearchResult[];
  videos: VideoSummary[];
  channels: ChannelSummary[];
  playlists: PlaylistSummary[];
  meta: SourceMetadata;
}

export interface CaptionTrackInfo {
  id: string;
  name: string;
  languageCode: string;
  kind: 'manual' | 'asr' | 'unknown';
  provenance?: 'manual' | 'asr' | 'unknown';
  isTranslatable: boolean;
  isDefault: boolean;
}

export interface TranslationLanguage {
  languageCode: string;
  name: string;
}

export interface CaptionTrackList {
  tracks: CaptionTrackInfo[];
  sourceTracks: CaptionTrackInfo[];
  translationLanguages: TranslationLanguage[];
  autoTranslationTargets: TranslationLanguage[];
  defaultTrackId?: string;
  meta: SourceMetadata;
}

export interface TranscriptWord {
  text: string;
  startMs: number;
  offsetMs: number;
}

export interface TranscriptSegment {
  startMs: number;
  durationMs: number;
  endMs: number;
  text: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  videoId: string;
  track: CaptionTrackInfo;
  translatedTo?: TranslationLanguage;
  segments: TranscriptSegment[];
  granularity?: 'segment' | 'word';
  text: string;
  meta: SourceMetadata;
}

export interface TranscriptOptions {
  videoId: string;
  language?: string;
  trackId?: string;
  translateTo?: string;
  granularity?: 'segment' | 'word';
}

export interface EndscreenElement {
  type: 'video' | 'playlist' | 'channel' | 'unknown';
  title?: string;
  metadata?: string;
  videoId?: string;
  playlistId?: string;
  channelId?: string;
  startMs: number;
  endMs: number;
  thumbnails: Thumbnail[];
  position?: {
    left?: number;
    top?: number;
    width?: number;
    aspectRatio?: number;
  };
}

export interface Video extends VideoSummary {
  keywords: string[];
  availability: Availability;
  meta: SourceMetadata;
}

export interface VideoSignals {
  videoId: string;
  publishDate?: string;
  publishedTimeText?: string;
  viewCount?: number;
  commentCount?: number;
  likeCount?: number;
  meta: SourceMetadata;
}

export interface ChannelLink {
  title: string;
  displayUrl: string;
  url: string;
}

export interface ChannelMoreInfo {
  canonicalChannelUrl: string;
  displayCanonicalChannelUrl?: string;
  joinedDate?: string;
  joinedDateText?: string;
  subscriberCount?: number;
  subscriberCountText?: string;
  videoCount?: number;
  videoCountText?: string;
  viewCount?: number;
  viewCountText?: string;
  businessEmailAvailable: boolean;
}

export interface Channel {
  type: 'channel';
  id: string;
  name: string;
  handle?: string;
  thumbnails: Thumbnail[];
  url: string;
  about: {
    description?: string;
    links: ChannelLink[];
    moreInfo: ChannelMoreInfo;
  };
  meta: SourceMetadata;
}

export interface ChannelVideos extends ContinuationPage {
  channelId: string;
  sort: ChannelVideoSort;
  videos: VideoSummary[];
  meta: SourceMetadata;
}

export interface ChannelPlaylists extends ContinuationPage {
  channelId: string;
  sort: ChannelPlaylistSort;
  playlists: PlaylistSummary[];
  meta: SourceMetadata;
}

export interface Playlist extends PlaylistSummary, ContinuationPage {
  videos: VideoSummary[];
  meta: SourceMetadata;
}

export interface Comment {
  id: string;
  author: {
    id?: string;
    name: string;
    thumbnails: Thumbnail[];
  };
  text: string;
  publishedTimeText?: string;
  likeCount?: number;
  likeCountText?: string;
  replyCount?: number;
  isPinned: boolean;
  isHearted: boolean;
  replies: Comment[];
}

export interface CommentPage extends ContinuationPage {
  videoId: string;
  totalCount?: number;
  comments: Comment[];
  replyContinuations: string[];
  newestContinuation?: string;
  meta: SourceMetadata;
}

export interface CommentCollection extends CommentPage {
  complete: boolean;
  pagesFetched: number;
  topLevelCount: number;
  replyCount: number;
  remainingContinuations: number;
}

export interface YouTubeClientOptions {
  fetch?: typeof fetch;
  language?: string;
  region?: string;
  retry?: YouTubeRetryOptions;
}

export interface CommentOptions {
  videoId: string;
  continuation?: string;
}

export interface AllCommentOptions {
  videoId: string;
  maxPages?: number;
}

export type YouTubeErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE';

export class YouTubeClientError extends Error {
  readonly code: YouTubeErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: YouTubeErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message);
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    this.name = 'YouTubeClientError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
