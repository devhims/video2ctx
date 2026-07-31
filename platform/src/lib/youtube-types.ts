export type YouTubeEntityType = 'video' | 'channel' | 'playlist';

export interface SourceMetadata {
  source: 'innertube' | 'youtube-data-api' | 'cache' | 'derived';
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
  url: string;
}

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
  meta: SourceMetadata;
}

export interface BrowseOptions {
  browseId?: string;
  categoryId?: string;
  region?: string;
  language?: string;
  continuation?: string;
}

export interface BrowseResponse extends ContinuationPage {
  browseId?: string;
  title?: string;
  results: SearchResult[];
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
  translationLanguages: TranslationLanguage[];
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

export interface MediaFormat {
  itag: number;
  mimeType: string;
  codec?: string;
  quality?: string;
  qualityLabel?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  averageBitrate?: number;
  contentLength?: number;
  durationMs?: number;
  audioQuality?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  projectionType?: string;
  isHdr: boolean;
}

export interface StoryboardLevel {
  width: number;
  height: number;
  count: number;
  columns: number;
  rows: number;
  intervalMs: number;
  urlTemplate: string;
}

export interface Storyboard {
  recommendedLevel?: number;
  levels: StoryboardLevel[];
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
  captionTracks: CaptionTrackInfo[];
  translationLanguages: TranslationLanguage[];
  media: {
    expiresAt?: string;
    aspectRatio?: number;
    videoFormats: MediaFormat[];
    audioFormats: MediaFormat[];
  };
  storyboards: Storyboard[];
  endscreen: EndscreenElement[];
  meta: SourceMetadata;
}

export interface Channel extends ChannelSummary, ContinuationPage {
  videos: VideoSummary[];
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
