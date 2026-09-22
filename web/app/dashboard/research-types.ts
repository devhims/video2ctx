export type ProviderId = 'youtube';
export type PlatformHealthState = 'checking' | 'healthy' | 'unavailable';
export type EntityType = 'video' | 'channel' | 'playlist';
export type SourceDataOption = 'transcript' | 'comments' | 'channel';
export type Thumbnail = { url: string; width?: number; height?: number };
export type SearchItem = {
  provider?: ProviderId; type: EntityType; id: string; title?: string; name?: string; description?: string;
  channel?: { id: string; name: string }; thumbnails: Thumbnail[]; durationText?: string;
  viewCountText?: string; publishedTimeText?: string; isLive?: boolean; videoCountText?: string;
};
export type Segment = { text: string; startMs: number; endMs: number; durationMs: number };
export type SourceMetadata = { source: string; fetchedAt: string; partial: boolean; warnings: string[] };
export type Transcript = { videoId: string; segments: Segment[]; text: string; granularity?: 'segment' | 'word'; meta: SourceMetadata; track: { name: string; kind: string; languageCode: string } };
export type CommentRecord = {
  id: string;
  author?: { id?: string; name?: string; thumbnails?: Thumbnail[] };
  text?: string;
  publishedTimeText?: string;
  likeCount?: number;
  likeCountText?: string;
  replyCount?: number;
  isPinned?: boolean;
  isHearted?: boolean;
};
export type CommentPage = {
  videoId: string;
  comments: CommentRecord[];
  totalCount?: number;
  continuation?: string;
  meta: SourceMetadata;
};
export type ChannelInfo = {
  id: string;
  name: string;
  handle?: string;
  thumbnails: Thumbnail[];
  url: string;
  about: {
    description?: string;
    links: Array<{ title: string; displayUrl: string; url: string }>;
    moreInfo: {
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
    };
  };
  meta: SourceMetadata;
};
export type Project = { id: string; name: string; description?: string; item_count?: number };
export type ProjectItem = { id: string; provider: ProviderId; entity_type: EntityType; entity_id: string; title?: string; note?: string; start_ms?: number | null; created_at?: number };
export type ProjectDetail = Project & { items: ProjectItem[] };
export type Monitor = {
  id: string; provider: ProviderId; kind: string; target: string; query_json?: string; cadence?: string;
  interval_minutes?: number; enabled: number; last_checked_at?: number; next_check_at?: number;
};
export type Inspector = {
  provider: ProviderId;
  type: EntityType;
  id: string;
  data: Record<string, unknown>;
  requestedData: SourceDataOption[];
  dataErrors: Partial<Record<SourceDataOption | 'metadata', string>>;
  loadingData?: Array<SourceDataOption | 'metadata'>;
  transcript?: Transcript;
  comments?: CommentPage;
  channel?: ChannelInfo;
};
export type TrendVideo = {
  id: string; title: string; channel: { id: string; name: string }; thumbnails: Thumbnail[];
  durationSeconds?: number; publishedTimeText?: string; publishDate?: string; ageHours?: number;
  viewCount: number; viewsPerHour?: number; commentCount?: number; hashtags: string[]; keywords: string[];
  observedViewsPerHour?: number; effectiveViewsPerHour: number; velocityRank: number;
  signalSource: 'observed' | 'estimated';
  percentiles: { velocity: number; freshness: number; channelPerformance: number; engagement: number; acceleration: number };
  trendScore: number; trendBand: 'Breakout' | 'Rising' | 'Steady'; url: string;
};
export type TrendReport = {
  provider: ProviderId; query: string; generatedAt: string; sampleSize: number; methodology: string;
  summary: { totalViews: number; medianViewsPerHour: number; publishedLast7Days: number; breakoutCount: number; medianRecentViewsPerHour?: number; recentVelocityLift?: number };
  window: { days: number; recentCandidatesSampled: number; recentVideosEnriched: number };
  videos: TrendVideo[];
  hashtags: Array<{ tag: string; videos: number; averageViewsPerHour: number; lift: number }>;
  titlePatterns: Array<{ term: string; videos: number; averageViewsPerHour: number }>;
  durationMix: Array<{ label: string; videos: number; averageViewsPerHour: number }>;
  plan: { angle: string; recommendedDurationSeconds?: number; titleIdeas: string[]; observedHashtags: string[]; evidence: string[] };
  warnings: string[];
};
export type AiTrendPlan = {
  provider: ProviderId; model: '@cf/openai/gpt-oss-120b'; generatedAt: string; operationId: string;
  angle: string; audience: string; hook: string; recommendedDurationSeconds: number;
  outline: Array<{ section: string; goal: string }>;
  titleIdeas: string[]; hashtags: string[]; differentiation: string[];
  evidence: Array<{ claim: string; videoIds: string[] }>; caveats: string[];
};
