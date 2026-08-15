import he from 'he';
import striptags from 'striptags';
import { createYouTubeTransport } from './youtube-transport';
import {
  normalizeBrowseCategory,
  normalizeBrowseLanguage,
  normalizeBrowseRegion,
} from './browse-contract';
import {
  AllCommentOptions,
  Availability,
  BrowseOptions,
  BrowseResponse,
  CaptionTrackInfo,
  CaptionTrackList,
  Channel,
  ChannelLink,
  ChannelPlaylistSort,
  ChannelPlaylists,
  ChannelSummary,
  ChannelVideoSort,
  ChannelVideos,
  Comment,
  CommentCollection,
  CommentOptions,
  CommentPage,
  EndscreenElement,
  Playlist,
  PlaylistSummary,
  SearchFilters,
  SearchResponse,
  SearchResult,
  SourceMetadata,
  Thumbnail,
  Transcript,
  TranscriptOptions,
  TranscriptSegment,
  TranslationLanguage,
  Video,
  VideoSignals,
  VideoSummary,
  YouTubeClientError,
  YouTubeClientOptions,
} from './youtube-types';

type JsonObject = Record<string, unknown>;

interface ClientProfile {
  name: string;
  clientName: string;
  clientVersion: string;
  clientNameHeader: string;
  userAgent: string;
  context: JsonObject;
}

interface InternalCaptionTrack {
  baseUrl: string;
  vssId?: string;
  languageCode?: string;
  kind?: string;
  name?: unknown;
  isTranslatable?: boolean;
}

interface CaptionCatalog {
  internal: InternalCaptionTrack[];
  public: CaptionTrackInfo[];
  translations: TranslationLanguage[];
  defaultTrackId?: string;
}

interface DesktopPlayerResult {
  raw: JsonObject;
  cookies?: string;
}

const WEB_PROFILE: ClientProfile = {
  name: 'web',
  clientName: 'WEB',
  clientVersion: '2.20260730.00.00',
  clientNameHeader: '1',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  context: { platform: 'DESKTOP', osName: 'Macintosh', osVersion: '10_15_7' },
};

const PLAYER_PROFILES: ClientProfile[] = [
  {
    name: 'ios',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    clientNameHeader: '5',
    userAgent:
      'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      platform: 'MOBILE',
      osName: 'iOS',
      osVersion: '18.3.2.22D82',
    },
  },
  {
    name: 'android_vr',
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.20',
    clientNameHeader: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.62.20 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      platform: 'MOBILE',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
    },
  },
  {
    name: 'mweb',
    clientName: 'MWEB',
    clientVersion: '2.20251209.01.00',
    clientNameHeader: '2',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    context: { platform: 'MOBILE', osName: 'iOS', osVersion: '17.5.1' },
  },
];

const API_ROOT = 'https://youtubei.googleapis.com/youtubei/v1';
const SEARCH_CAPTIONS_PARAM = 'EgIoAQ==';

const BROWSE_DESTINATIONS: Record<string, { category: string; browseId: string }> = {
  music: { category: 'music', browseId: 'UC-9-kyTW8ZkZNDHQJ6FgpwQ' },
  news: { category: 'news', browseId: 'UCYfdidRxbB8Qhf0Nx7ioOYw' },
  sports: { category: 'sports', browseId: 'UCEgdi0XIXXZ-qJOFPf4JSKw' },
  live: { category: 'live', browseId: 'UC4R8DWoMoI7CAwX8_LjQHig' },
};

export function browseDestination(categoryId?: string): { category: string; browseId: string } | undefined {
  try {
    const category = normalizeBrowseCategory(categoryId);
    return category ? BROWSE_DESTINATIONS[category] : undefined;
  } catch (cause) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      cause instanceof Error ? cause.message : 'Invalid browse category.'
    );
  }
}

function browseLocale(options: BrowseOptions): Pick<BrowseOptions, 'language' | 'region'> {
  try {
    return {
      region: options.region === undefined ? undefined : normalizeBrowseRegion(options.region),
      language:
        options.language === undefined ? undefined : normalizeBrowseLanguage(options.language),
    };
  } catch (cause) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      cause instanceof Error ? cause.message : 'Invalid browse locale.'
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function rendererText(value: unknown): string | undefined {
  if (typeof value === 'string') return he.decode(striptags(value)).trim();
  const source = object(value);
  const content = string(source.content);
  if (content !== undefined) return he.decode(striptags(content)).trim();
  const simple = string(source.simpleText);
  if (simple !== undefined) return he.decode(striptags(simple)).trim();
  const runs = array(source.runs)
    .map((run) => string(object(run).text) ?? '')
    .join('');
  return runs ? he.decode(striptags(runs)).trim() : undefined;
}

function rendererThumbnails(value: unknown): Thumbnail[] {
  const source = object(value);
  const thumbnails = array(
    source.thumbnails ??
    object(source.thumbnail).thumbnails ??
    source.sources ??
    object(source.image).sources
  );
  return thumbnails.flatMap((item): Thumbnail[] => {
      const thumbnail = object(item);
      const url = string(thumbnail.url);
      if (!url) return [];
      return [{
        url,
        width: number(thumbnail.width),
        height: number(thumbnail.height),
      }];
    });
}

function rendererNavigationId(value: unknown, key: string): string | undefined {
  const source = object(value);
  const navigation = object(source.navigationEndpoint);
  return string(object(navigation[key])[key === 'watchEndpoint' ? 'videoId' : 'browseId']);
}

function walkObjects(value: unknown, visit: (value: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  if (!isObject(value)) return;
  visit(value);
  for (const child of Object.values(value)) walkObjects(child, visit);
}

function findRenderers(root: unknown, name: string): JsonObject[] {
  const found: JsonObject[] = [];
  walkObjects(root, (candidate) => {
    if (isObject(candidate[name])) found.push(candidate[name] as JsonObject);
  });
  return found;
}

function continuationToken(root: unknown): string | undefined {
  let token: string | undefined;
  walkObjects(root, (candidate) => {
    if (token) return;
    const command = object(object(candidate.continuationEndpoint).continuationCommand);
    token = string(command.token);
    if (!token) token = string(object(candidate.continuationCommand).token);
    if (!token) token = string(object(candidate.nextContinuationData).continuation);
  });
  return token;
}

function directContinuationToken(value: unknown): string | undefined {
  const renderer = object(object(value).continuationItemRenderer);
  const command = object(object(renderer.continuationEndpoint).continuationCommand);
  return string(command.token) ??
    string(object(renderer.nextContinuationData).continuation) ??
    continuationToken(renderer);
}

function commentContinuationTokens(root: unknown): {
  continuation?: string;
  replyContinuations: string[];
  newestContinuation?: string;
} {
  let continuation: string | undefined;
  let newestContinuation: string | undefined;
  const replyContinuations = new Set<string>();
  for (const commandName of ['reloadContinuationItemsCommand', 'appendContinuationItemsAction']) {
    for (const command of findRenderers(root, commandName)) {
      for (const item of array(command.continuationItems)) {
        const direct = directContinuationToken(item);
        if (direct) continuation = direct;
        const thread = object(object(item).commentThreadRenderer);
        const reply = continuationToken(thread.replies);
        if (reply) replyContinuations.add(reply);
      }
    }
  }
  for (const menu of findRenderers(root, 'sortFilterSubMenuRenderer')) {
    for (const itemValue of array(menu.subMenuItems)) {
      const item = object(itemValue);
      const title = string(item.title) ?? rendererText(item.title);
      if (title?.toLowerCase().startsWith('newest')) {
        newestContinuation = continuationToken(item);
      }
    }
  }
  return { continuation, replyContinuations: [...replyContinuations], newestContinuation };
}

function parseCompactNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\u00a0/g, ' ').trim();
  const match = normalized.match(/([0-9]+(?:[.,][0-9]+)*)\s*([^\d\s]*)?/i);
  if (!match) return undefined;
  const numericToken = match[1];
  if (!numericToken) return undefined;
  const suffix = (match[2] ?? '').replace(/\./g, '').toLowerCase();
  const multiplier =
    /^(?:k|tsd|тыс)$/.test(suffix) ? 1_000 :
    /^(?:m|mio|mln|млн)$/.test(suffix) ? 1_000_000 :
    /^(?:b|mrd|млрд)$/.test(suffix) ? 1_000_000_000 :
    undefined;
  const numericText = multiplier
    ? numericToken.replace(',', '.')
    : /^[0-9]{1,3}(?:[.,][0-9]{3})+$/.test(numericToken)
      ? numericToken.replace(/[.,]/g, '')
      : numericToken.replace(',', '.');
  const base = Number(numericText);
  if (!Number.isFinite(base)) return undefined;
  return Math.round(base * (multiplier ?? 1));
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  const totalSeconds = Math.trunc(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function formatViewCount(
  viewCount: number | undefined,
  language: string,
  region: string
): string | undefined {
  if (viewCount === undefined) return undefined;
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(`${language}-${region}`, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(viewCount);
  } catch {
    formatted = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(viewCount);
  }
  return `${formatted} views`;
}

function attachCommentReplies(comments: Comment[]): Comment[] {
  const parents = new Map(
    comments
      .filter((comment) => !comment.id.includes('.'))
      .map((comment) => {
        comment.replies = [];
        return [comment.id, comment] as const;
      })
  );
  for (const reply of comments) {
    const separator = reply.id.indexOf('.');
    if (separator < 1) continue;
    const parent = parents.get(reply.id.slice(0, separator));
    if (parent && !parent.replies.some((candidate) => candidate.id === reply.id)) {
      parent.replies.push(reply);
    }
  }
  return comments;
}

function assertChannelVideoSort(sort: unknown): asserts sort is ChannelVideoSort {
  if (!['latest', 'popular', 'oldest'].includes(String(sort))) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      'sort must be one of: latest, popular, oldest.'
    );
  }
}

function assertChannelPlaylistSort(sort: unknown): asserts sort is ChannelPlaylistSort {
  if (!['newest', 'last-video-added'].includes(String(sort))) {
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

function channelFromRuns(
  value: unknown,
  navigationEndpoint?: unknown
): Pick<ChannelSummary, 'id' | 'name' | 'url'> {
  const source = object(value);
  const firstRun = object(array(source.runs)[0]);
  const commandRun = object(array(source.commandRuns)[0]);
  const navigationCandidates = [
    firstRun.navigationEndpoint,
    object(object(commandRun.onTap).innertubeCommand),
    navigationEndpoint,
    object(object(navigationEndpoint).innertubeCommand),
  ];
  const id = navigationCandidates
    .map((candidate) => string(object(object(candidate).browseEndpoint).browseId))
    .find(Boolean) ?? '';
  const rawName = string(firstRun.text) ?? rendererText(value) ?? 'Unknown channel';
  const name = id ? rawName.replace(/^by\s+/i, '') : rawName;
  return { id, name, url: id ? `https://www.youtube.com/channel/${id}` : '' };
}

function channelFromMetadataRows(
  value: unknown
): Pick<ChannelSummary, 'id' | 'name' | 'url'> | undefined {
  for (const metadata of findRenderers(value, 'contentMetadataViewModel')) {
    for (const row of array(metadata.metadataRows)) {
      for (const partValue of array(object(row).metadataParts)) {
        const part = object(partValue);
        const channel = channelFromRuns(part.text);
        if (channel.id) return channel;
      }
    }
  }
  return undefined;
}

function parseVideoRenderer(renderer: JsonObject): VideoSummary | null {
  const id = string(renderer.videoId);
  const title = rendererText(renderer.title);
  if (!id || !title) return null;
  const durationText = rendererText(renderer.lengthText);
  const viewCountText =
    rendererText(renderer.viewCountText) ?? rendererText(renderer.shortViewCountText);
  const badges = findRenderers(renderer.badges, 'metadataBadgeRenderer');
  const isLive =
    badges.some((badge) => string(badge.style)?.includes('LIVE')) ||
    findRenderers(renderer.thumbnailOverlays, 'thumbnailOverlayTimeStatusRenderer').some(
      (status) => string(status.style) === 'LIVE'
    );
  const hasCaptions = badges.some((badge) => {
    const label = `${rendererText(badge.label) ?? ''} ${rendererText(badge.tooltip) ?? ''}`.toLowerCase();
    return label.includes('caption') || label.includes('subtitles') || label === 'cc';
  });
  return {
    type: 'video',
    id,
    title,
    description:
      rendererText(renderer.descriptionSnippet) ??
      array(renderer.detailedMetadataSnippets)
        .map((snippet) => rendererText(object(snippet).snippetText))
        .filter(Boolean)
        .join(' '),
    channel: channelFromRuns(
      renderer.ownerText ?? renderer.longBylineText ?? renderer.shortBylineText
    ),
    thumbnails: rendererThumbnails(renderer.thumbnail),
    durationSeconds: parseDuration(durationText),
    durationText,
    publishedTimeText: rendererText(renderer.publishedTimeText),
    viewCount: parseCompactNumber(viewCountText),
    viewCountText,
    isLive,
    hasCaptions,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function parseChannelRenderer(renderer: JsonObject): ChannelSummary | null {
  const id = string(renderer.channelId);
  const name = rendererText(renderer.title);
  if (!id || !name) return null;
  const handle = rendererText(renderer.navigationEndpoint ? object(renderer.navigationEndpoint).commandMetadata : undefined) ??
    rendererText(renderer.subscriberCountText);
  return {
    type: 'channel',
    id,
    name,
    description: rendererText(renderer.descriptionSnippet),
    handle: string(renderer.username) ?? (handle?.startsWith('@') ? handle : undefined),
    subscriberCountText: rendererText(renderer.subscriberCountText),
    videoCountText: rendererText(renderer.videoCountText),
    thumbnails: rendererThumbnails(renderer.thumbnail),
    url: `https://www.youtube.com/channel/${id}`,
  };
}

function parsePlaylistRenderer(renderer: JsonObject): PlaylistSummary | null {
  const id = string(renderer.playlistId);
  const title = rendererText(renderer.title);
  if (!id || !title) return null;
  const videoCountText = rendererText(renderer.videoCountText);
  return {
    type: 'playlist',
    id,
    title,
    description: rendererText(renderer.descriptionSnippet),
    channel: channelFromRuns(renderer.longBylineText ?? renderer.shortBylineText),
    thumbnails: firstRendererThumbnails(
      renderer.thumbnail,
      object(array(renderer.thumbnails)[0])
    ),
    videoCount: parseCompactNumber(videoCountText),
    videoCountText,
    isPodcast: false,
    playUrl: (() => {
      const videoId = string(object(object(renderer.navigationEndpoint).watchEndpoint).videoId);
      return videoId ? `https://www.youtube.com/watch?v=${videoId}&list=${id}` : undefined;
    })(),
    url: `https://www.youtube.com/playlist?list=${id}`,
  };
}

function parseLockupViewModel(
  renderer: JsonObject,
  fallbackChannel?: Pick<ChannelSummary, 'id' | 'name' | 'url'>
): VideoSummary | PlaylistSummary | null {
  const id = string(renderer.contentId);
  const contentType = string(renderer.contentType);
  const metadata = object(object(renderer.metadata).lockupMetadataViewModel);
  const title = rendererText(metadata.title);
  if (!id || !title) return null;

  const contentMetadata = object(object(metadata.metadata).contentMetadataViewModel);
  const metadataRows = array(contentMetadata.metadataRows).map((row) =>
    array(object(row).metadataParts).map((part) => rendererText(object(part).text)).filter(
      (value): value is string => Boolean(value)
    )
  );
  const metadataParts = metadataRows.flat();
  const thumbnailRenderer = findRenderers(renderer.contentImage, 'thumbnailViewModel')[0] ?? {};
  const thumbnails = rendererThumbnails(thumbnailRenderer.image);
  const badgeTexts = findRenderers(renderer.contentImage, 'thumbnailBadgeViewModel')
    .map((badge) => rendererText(badge.text))
    .filter((value): value is string => Boolean(value));
  const metadataBadgeTexts = findRenderers(metadata, 'badgeViewModel').flatMap((badge) => [
    rendererText(badge.badgeText),
    rendererText(object(object(badge.rendererContext).accessibilityContext).label),
  ]).filter((value): value is string => Boolean(value));

  if (contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    const statsRow = metadataRows.find((row) => row.length >= 2 && row.some((value) => /\d/.test(value)));
    const viewCountText = metadataParts.find((value) => /\bviews?$/i.test(value)) ?? statsRow?.[0];
    const publishedTimeText = metadataParts.find((value) =>
      /\b(?:ago|streamed|premiered)\b/i.test(value)
    ) ?? statsRow?.[1];
    const durationText = badgeTexts.find((value) => /^\d+(?::\d+)+$/.test(value));
    const channel = channelFromMetadataRows(metadata) ??
      fallbackChannel ?? { id: '', name: 'Unknown channel', url: '' };
    return {
      type: 'video',
      id,
      title,
      channel,
      thumbnails,
      durationSeconds: parseDuration(durationText),
      durationText,
      publishedTimeText,
      viewCount: parseCompactNumber(viewCountText),
      viewCountText,
      isLive: badgeTexts.some((value) => /\blive\b/i.test(value)),
      hasCaptions: metadataBadgeTexts.some((value) => /^(?:cc|closed captions)$/i.test(value)),
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  if (contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' || contentType === 'LOCKUP_CONTENT_TYPE_PODCAST') {
    const videoCountText = badgeTexts.find((value) => /\b(?:videos?|episodes?)$/i.test(value));
    const updatedTimeText = metadataParts.find((value) => /^updated\b/i.test(value));
    const command = object(object(object(renderer.rendererContext).commandContext).onTap);
    const firstVideoId = string(object(object(command.innertubeCommand).watchEndpoint).videoId);
    return {
      type: 'playlist',
      id,
      title,
      channel: fallbackChannel,
      thumbnails,
      videoCount: parseCompactNumber(videoCountText),
      videoCountText,
      updatedTimeText,
      isPodcast: contentType === 'LOCKUP_CONTENT_TYPE_PODCAST',
      playUrl: firstVideoId
        ? `https://www.youtube.com/watch?v=${firstVideoId}&list=${id}`
        : undefined,
      url: `https://www.youtube.com/playlist?list=${id}`,
    };
  }

  return null;
}

function parseSearchResults(
  root: unknown,
  fallbackChannel?: Pick<ChannelSummary, 'id' | 'name' | 'url'>
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const renderer of findRenderers(root, 'videoRenderer')) {
    const result = parseVideoRenderer(renderer);
    if (result) results.push(result);
  }
  for (const renderer of findRenderers(root, 'compactVideoRenderer')) {
    const result = parseVideoRenderer(renderer);
    if (result && !results.some((item) => item.type === 'video' && item.id === result.id)) {
      results.push(result);
    }
  }
  for (const renderer of findRenderers(root, 'playlistVideoRenderer')) {
    const result = parseVideoRenderer(renderer);
    if (result && !results.some((item) => item.type === 'video' && item.id === result.id)) {
      results.push(result);
    }
  }
  for (const renderer of findRenderers(root, 'lockupViewModel')) {
    const result = parseLockupViewModel(renderer, fallbackChannel);
    if (result && !results.some((item) => item.type === result.type && item.id === result.id)) {
      results.push(result);
    }
  }
  for (const renderer of findRenderers(root, 'channelRenderer')) {
    const result = parseChannelRenderer(renderer);
    if (result) results.push(result);
  }
  for (const renderer of findRenderers(root, 'playlistRenderer')) {
    const result = parsePlaylistRenderer(renderer);
    if (result) results.push(result);
  }
  for (const renderer of findRenderers(root, 'gridPlaylistRenderer')) {
    const result = parsePlaylistRenderer(renderer);
    if (result && !results.some((item) => item.type === 'playlist' && item.id === result.id)) {
      results.push(result);
    }
  }
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.type}:${result.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function channelTabBrowseOptions(root: unknown, suffix: '/videos' | '/playlists'): BrowseOptions | undefined {
  for (const tab of findRenderers(root, 'tabRenderer')) {
    const endpoint = object(tab.endpoint);
    const commandUrl = string(object(object(endpoint.commandMetadata).webCommandMetadata).url);
    const browse = object(endpoint.browseEndpoint);
    const browseId = string(browse.browseId);
    const params = string(browse.params);
    if (commandUrl?.endsWith(suffix) && browseId && params) return { browseId, params };
  }
  return undefined;
}

function channelVideoSortContinuation(root: unknown, sort: ChannelVideoSort): string | undefined {
  const label = sort === 'latest' ? 'Latest' : sort === 'popular' ? 'Popular' : 'Oldest';
  for (const chip of findRenderers(root, 'chipViewModel')) {
    if (rendererText(chip.text) !== label) continue;
    const command = object(object(chip.tapCommand).innertubeCommand);
    const token = string(object(command.continuationCommand).token);
    if (token) return token;
  }
  return undefined;
}

function channelPlaylistSortBrowseOptions(
  root: unknown,
  sort: ChannelPlaylistSort
): BrowseOptions | undefined {
  const label = sort === 'newest' ? 'Date added (newest)' : 'Last video added';
  for (const menu of findRenderers(root, 'sortFilterSubMenuRenderer')) {
    for (const item of array(menu.subMenuItems)) {
      const option = object(item);
      if (string(option.title) !== label) continue;
      const browse = object(object(option.navigationEndpoint).browseEndpoint);
      const browseId = string(browse.browseId);
      const params = string(browse.params);
      if (browseId && params) return { browseId, params };
    }
  }
  return undefined;
}

function catalogContinuationToken(root: unknown): string | undefined {
  for (const rendererName of ['continuationItemRenderer', 'continuationItemViewModel']) {
    for (const renderer of findRenderers(root, rendererName)) {
      const token = continuationToken(renderer);
      if (token) return token;
    }
  }
  for (const rendererName of [
    'richGridContinuation', 'gridContinuation', 'sectionListContinuation', 'itemSectionContinuation',
  ]) {
    for (const renderer of findRenderers(root, rendererName)) {
      const token = continuationToken(renderer);
      if (token) return token;
    }
  }
  return undefined;
}

function channelHeaderCounts(root: unknown): { subscriberCountText?: string; videoCountText?: string } {
  const header = findRenderers(root, 'pageHeaderViewModel')[0];
  const metadata = header ? findRenderers(header, 'contentMetadataViewModel')[0] : undefined;
  const values = array(metadata?.metadataRows).flatMap((row) =>
    array(object(row).metadataParts).map((part) => rendererText(object(part).text)).filter(
      (value): value is string => Boolean(value)
    )
  );
  return {
    subscriberCountText: values.find((value) => /\bsubscribers?$/i.test(value)),
    videoCountText: values.find((value) => /\bvideos?$/i.test(value)),
  };
}

function directExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const candidate = new URL(value, 'https://www.youtube.com');
    const redirected = candidate.hostname.endsWith('youtube.com') && candidate.pathname === '/redirect'
      ? candidate.searchParams.get('q')
      : candidate.toString();
    if (!redirected) return undefined;
    const target = new URL(redirected);
    return ['http:', 'https:'].includes(target.protocol) ? target.toString() : undefined;
  } catch {
    return undefined;
  }
}

function channelExternalLinks(root: unknown): ChannelLink[] {
  return findRenderers(root, 'channelExternalLinkViewModel').flatMap((renderer): ChannelLink[] => {
    const title = rendererText(renderer.title);
    const link = object(renderer.link);
    const displayUrl = rendererText(link);
    const commandRun = object(array(link.commandRuns)[0]);
    const command = object(object(commandRun.onTap).innertubeCommand);
    const commandUrl = string(object(command.urlEndpoint).url) ??
      string(object(object(command.commandMetadata).webCommandMetadata).url);
    const url = directExternalUrl(commandUrl);
    return title && displayUrl && url ? [{ title, displayUrl, url }] : [];
  });
}

function normalizedChannelUrl(value: string | undefined, channelId: string): string {
  const fallback = `https://www.youtube.com/channel/${channelId}`;
  if (!value) return fallback;
  try {
    const url = new URL(value, 'https://www.youtube.com');
    url.protocol = 'https:';
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function joinedDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value.replace(/^Joined\s+/i, '').trim();
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const monthFirst = date.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  const dayFirst = date.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const monthName = monthFirst?.[1] ?? dayFirst?.[2];
  const day = Number(monthFirst?.[2] ?? dayFirst?.[1]);
  const year = Number(monthFirst?.[3] ?? dayFirst?.[3]);
  const month = monthName ? months.indexOf(monthName.toLowerCase()) + 1 : 0;
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function playlistHeaderData(root: unknown): {
  title?: string;
  description?: string;
  channel: Pick<ChannelSummary, 'id' | 'name' | 'url'>;
  thumbnails: Thumbnail[];
  videoCount?: number;
  videoCountText?: string;
  isPodcast: boolean;
} {
  const legacy = findRenderers(root, 'playlistHeaderRenderer')[0] ?? {};
  const pageHeader = findRenderers(root, 'pageHeaderRenderer')[0] ?? {};
  const primary = findRenderers(root, 'playlistSidebarPrimaryInfoRenderer')[0] ?? {};
  const secondary = findRenderers(root, 'playlistSidebarSecondaryInfoRenderer')[0] ?? {};
  const ownerRenderer = findRenderers(secondary, 'videoOwnerRenderer')[0] ?? {};
  const avatarStack = findRenderers(pageHeader, 'avatarStackViewModel')[0] ?? {};
  const metadata = findRenderers(root, 'playlistMetadataRenderer')[0] ?? {};
  const microformat = findRenderers(root, 'microformatDataRenderer')[0] ?? {};
  const playlistThumbnail = findRenderers(primary.thumbnailRenderer, 'playlistVideoThumbnailRenderer')[0] ?? {};

  const metadataValues = [
    ...findRenderers(pageHeader, 'contentMetadataViewModel').flatMap((viewModel) =>
      array(viewModel.metadataRows).flatMap((row) =>
        array(object(row).metadataParts)
          .map((part) => rendererText(object(part).text))
          .filter((value): value is string => Boolean(value))
      )
    ),
    ...array(primary.stats)
      .map((stat) => rendererText(stat))
      .filter((value): value is string => Boolean(value)),
  ];
  const videoCountText = rendererText(legacy.numVideosText) ??
    metadataValues.find((value) => /^\s*[\d,.]+\s+videos?\s*$/i.test(value));

  const channelCandidates = [
    channelFromRuns(legacy.ownerText),
    channelFromRuns(ownerRenderer.title, ownerRenderer.navigationEndpoint),
    channelFromRuns(avatarStack.text),
  ];
  const channel = channelCandidates.find((candidate) => candidate.id) ??
    channelCandidates.find((candidate) => candidate.name !== 'Unknown channel') ??
    { id: '', name: 'Unknown channel', url: '' };

  return {
    title:
      rendererText(legacy.title) ??
      string(pageHeader.pageTitle) ??
      rendererText(object(findRenderers(pageHeader, 'dynamicTextViewModel')[0]).text) ??
      rendererText(primary.title) ??
      string(metadata.title),
    description:
      rendererText(legacy.descriptionText) ??
      rendererText(primary.description) ??
      string(metadata.description) ??
      string(microformat.description),
    channel,
    thumbnails: firstRendererThumbnails(
      legacy.playlistHeaderBanner,
      playlistThumbnail.thumbnail,
      microformat.thumbnail
    ),
    videoCount: parseCompactNumber(videoCountText),
    videoCountText,
    isPodcast: metadataValues.some((value) => /^podcast$/i.test(value)),
  };
}

function meta(warnings: string[] = [], partial = false): SourceMetadata {
  return {
    source: 'allthingsyoutube',
    fetchedAt: new Date().toISOString(),
    partial,
    warnings,
  };
}

function classifyHttpError(status: number, message: string): YouTubeClientError {
  if (status === 404) return new YouTubeClientError('NOT_FOUND', message, { status });
  if (status === 401 || status === 403) {
    return new YouTubeClientError('AUTH_REQUIRED', message, { status });
  }
  if (status === 429) {
    return new YouTubeClientError('RATE_LIMITED', message, {
      status,
      retryable: true,
    });
  }
  return new YouTubeClientError('UPSTREAM_ERROR', message, {
    status,
    retryable: status >= 500,
  });
}

function firstRendererThumbnails(...values: unknown[]): Thumbnail[] {
  for (const value of values) {
    const thumbnails = rendererThumbnails(value);
    if (thumbnails.length) return thumbnails;
  }
  return [];
}

function captionTrackInfo(track: InternalCaptionTrack, index: number, defaultIndex = 0): CaptionTrackInfo {
  const id = track.vssId ?? track.languageCode ?? `track-${index}`;
  const provenance = track.kind === 'asr' || track.vssId?.startsWith('a.')
    ? 'asr' as const
    : track.vssId ? 'manual' as const : 'unknown' as const;
  return {
    id,
    name: rendererText(track.name) ?? track.languageCode ?? id,
    languageCode: track.languageCode ?? 'und',
    kind: provenance,
    provenance,
    isTranslatable: track.isTranslatable ?? false,
    isDefault: index === defaultIndex,
  };
}

function parseCaptionTracks(player: JsonObject): CaptionCatalog {
  const renderer = object(object(player.captions).playerCaptionsTracklistRenderer);
  const audioTracks = array(renderer.audioTracks).map(object);
  const defaultAudioTrackIndex = number(renderer.defaultAudioTrackIndex);
  const indexedDefaultAudioTrack = defaultAudioTrackIndex !== undefined
    ? audioTracks[defaultAudioTrackIndex]
    : undefined;
  const defaultAudioTrack = indexedDefaultAudioTrack ??
    audioTracks.find((track) => track.hasDefaultTrack === true) ??
    audioTracks[0] ??
    {};
  const defaultCaptionTrackIndex = number(defaultAudioTrack.defaultCaptionTrackIndex) ?? 0;
  const parsedTracks = array(renderer.captionTracks)
    .flatMap((item, sourceIndex): Array<{
      sourceIndex: number;
      track: InternalCaptionTrack;
    }> => {
      const track = object(item);
      const baseUrl = string(track.baseUrl);
      if (!baseUrl) return [];
      return [{
        sourceIndex,
        track: {
          baseUrl,
          vssId: string(track.vssId),
          languageCode: string(track.languageCode),
          kind: string(track.kind),
          name: track.name,
          isTranslatable: track.isTranslatable === true,
        },
      }];
    });
  const internal = parsedTracks.map(({ track }) => track);
  const parsedDefaultIndex = parsedTracks.findIndex(
    ({ sourceIndex }) => sourceIndex === defaultCaptionTrackIndex
  );
  const defaultIndex = parsedDefaultIndex >= 0 ? parsedDefaultIndex : 0;
  const publicTracks = internal.map((track, index) =>
    captionTrackInfo(track, index, defaultIndex)
  );
  const translations = array(renderer.translationLanguages).map((item) => {
    const language = object(item);
    return {
      languageCode: string(language.languageCode) ?? 'und',
      name: rendererText(language.languageName) ?? string(language.languageCode) ?? 'Unknown',
    };
  });
  return {
    internal,
    public: publicTracks,
    translations,
    defaultTrackId: publicTracks[defaultIndex]?.id,
  };
}

function mergeCaptionCatalog(primary: CaptionCatalog, desktop?: CaptionCatalog): CaptionCatalog {
  if (!desktop) return primary;
  const internal: InternalCaptionTrack[] = [];
  const seenTracks = new Set<string>();
  for (const track of [...primary.internal, ...desktop.internal]) {
    const key = track.vssId ?? track.languageCode ?? track.baseUrl;
    if (seenTracks.has(key)) continue;
    seenTracks.add(key);
    internal.push(track);
  }
  const translations: TranslationLanguage[] = [];
  const seenLanguages = new Set<string>();
  for (const language of [...desktop.translations, ...primary.translations]) {
    if (seenLanguages.has(language.languageCode)) continue;
    seenLanguages.add(language.languageCode);
    translations.push(language);
  }
  const defaultTrackId = primary.defaultTrackId ?? desktop.defaultTrackId;
  const defaultIndex = Math.max(0, internal.findIndex((track, index) =>
    (track.vssId ?? track.languageCode ?? `track-${index}`) === defaultTrackId
  ));
  return {
    internal,
    public: internal.map((track, index) => captionTrackInfo(track, index, defaultIndex)),
    translations,
    defaultTrackId,
  };
}

function extractAssignedJson(html: string, markers: string[]): JsonObject | undefined {
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = html.indexOf('{', markerIndex + marker.length);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const character = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        try {
          return object(JSON.parse(html.slice(start, index + 1)));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

function extractInitialPlayerResponse(html: string): JsonObject | undefined {
  return extractAssignedJson(html, ['var ytInitialPlayerResponse =', 'ytInitialPlayerResponse =']);
}

function extractInitialData(html: string): JsonObject | undefined {
  return extractAssignedJson(html, ['var ytInitialData =', 'ytInitialData =']);
}

function responseCookies(headers: Headers): string | undefined {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const combined = headers.get('set-cookie');
  const setCookies = values.length
    ? values
    : combined?.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) ?? [];
  const cookies = setCookies
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => [
      'VISITOR_INFO1_LIVE',
      'VISITOR_PRIVACY_METADATA',
      '__Secure-ROLLOUT_TOKEN',
    ].includes(value.split('=', 1)[0] ?? ''));
  return cookies.length ? cookies.join('; ') : undefined;
}

function chooseCaptionTrack(
  internal: InternalCaptionTrack[],
  language?: string,
  trackId?: string,
  defaultTrackId?: string,
): { track: InternalCaptionTrack; index: number } | undefined {
  const index = trackId
    ? internal.findIndex((track) => (track.vssId ?? track.languageCode) === trackId)
    : language && internal.findIndex((track) => track.vssId === `.${language}`) >= 0
      ? internal.findIndex((track) => track.vssId === `.${language}`)
      : language && internal.findIndex((track) => track.vssId === `a.${language}`) >= 0
        ? internal.findIndex((track) => track.vssId === `a.${language}`)
        : language
          ? internal.findIndex((track) => track.languageCode === language)
          : defaultTrackId
            ? internal.findIndex((track, trackIndex) =>
              (track.vssId ?? track.languageCode ?? `track-${trackIndex}`) === defaultTrackId
            )
            : -1;
  const selectedIndex = index >= 0 ? index : 0;
  const track = internal[selectedIndex];
  return track ? { track, index: selectedIndex } : undefined;
}

function parseEndscreen(player: JsonObject): EndscreenElement[] {
  return findRenderers(player.endscreen, 'endscreenElementRenderer').map((renderer) => {
    const endpoint = object(renderer.endpoint);
    const watchEndpoint = object(endpoint.watchEndpoint);
    const browseEndpoint = object(endpoint.browseEndpoint);
    const style = string(renderer.style) ?? '';
    const type = style.includes('VIDEO')
      ? 'video'
      : style.includes('PLAYLIST')
        ? 'playlist'
        : style.includes('CHANNEL')
          ? 'channel'
          : 'unknown';
    return {
      type,
      title: rendererText(renderer.title),
      metadata: rendererText(renderer.metadata),
      videoId: string(watchEndpoint.videoId),
      playlistId: string(watchEndpoint.playlistId),
      channelId:
        string(browseEndpoint.browseId) ??
        string(object(renderer.hovercardButton).channelId),
      startMs: number(renderer.startMs) ?? 0,
      endMs: number(renderer.endMs) ?? 0,
      thumbnails: rendererThumbnails(renderer.image),
      position: {
        left: number(renderer.left),
        top: number(renderer.top),
        width: number(renderer.width),
        aspectRatio: number(renderer.aspectRatio),
      },
    };
  });
}

function parseComment(renderer: JsonObject): Comment | null {
  const commentWrapper = object(renderer.comment);
  const comment = object(commentWrapper.commentRenderer ?? renderer.comment ?? renderer);
  const id = string(comment.commentId) ?? string(renderer.commentId);
  const text = rendererText(comment.contentText ?? comment.content);
  if (!id || !text) return null;
  const authorEndpoint = object(object(comment.authorEndpoint).browseEndpoint);
  return {
    id,
    author: {
      id: string(authorEndpoint.browseId),
      name: rendererText(comment.authorText) ?? 'Unknown',
      thumbnails: rendererThumbnails(comment.authorThumbnail),
    },
    text,
    publishedTimeText: rendererText(comment.publishedTimeText),
    likeCount: parseCompactNumber(rendererText(comment.voteCount)),
    likeCountText: rendererText(comment.voteCount),
    replyCount: number(renderer.replyCount) ?? number(comment.replyCount),
    isPinned: Boolean(comment.pinnedCommentBadge),
    isHearted: Boolean(comment.creatorHeart),
    replies: [],
  };
}

function parseCommentEntity(payload: JsonObject): Comment | null {
  const properties = object(payload.properties);
  const author = object(payload.author);
  const toolbar = object(payload.toolbar);
  const content = object(properties.content);
  const id = string(properties.commentId);
  const text = string(content.content);
  if (!id || !text) return null;
  const avatarUrl = string(author.avatarThumbnailUrl);
  const likeCountText = string(toolbar.likeCountNotliked) ?? string(toolbar.likeCountLiked);
  return {
    id,
    author: {
      id: string(author.channelId),
      name: string(author.displayName) ?? 'Unknown',
      thumbnails: avatarUrl ? [{ url: avatarUrl }] : [],
    },
    text,
    publishedTimeText: string(properties.publishedTime),
    likeCount: parseCompactNumber(likeCountText),
    likeCountText,
    replyCount: number(toolbar.replyCount),
    isPinned: Boolean(properties.isPinned),
    isHearted: Boolean(toolbar.heartState),
    replies: [],
  };
}

function firstRendererText(root: unknown, keys: string[]): string | undefined {
  let result: string | undefined;
  walkObjects(root, (candidate) => {
    if (result) return;
    for (const key of keys) {
      const value = rendererText(candidate[key]);
      if (value) {
        result = value;
        return;
      }
    }
  });
  return result;
}

function firstRendererNumber(root: unknown, keys: string[]): number | undefined {
  let result: number | undefined;
  walkObjects(root, (candidate) => {
    if (result !== undefined) return;
    for (const key of keys) {
      const value = candidate[key];
      const parsed = number(value) ?? parseCompactNumber(rendererText(value));
      if (parsed !== undefined) {
        result = parsed;
        return;
      }
    }
  });
  return result;
}

function parseVideoSignals(videoId: string, raw: JsonObject): VideoSignals {
  return {
    videoId,
    publishDate: firstRendererText(raw, ['publishDate', 'dateText']),
    publishedTimeText: firstRendererText(raw, ['relativeDateText', 'publishedTimeText']),
    viewCount: firstRendererNumber(raw, ['viewCountNumber', 'originalViewCount', 'viewCount']),
    commentCount: firstRendererNumber(raw, ['commentsCount', 'commentCount']),
    likeCount: firstRendererNumber(raw, [
      'likeCountIfLikedNumber', 'likeCountIfIndifferentNumber', 'likeCountNotliked', 'likeCountA11y',
    ]),
    meta: meta([], false),
  };
}

export interface YouTubeClient {
  search(query: string, filters?: SearchFilters): Promise<SearchResponse>;
  browse(options?: BrowseOptions): Promise<BrowseResponse>;
  getVideo(videoId: string): Promise<Video>;
  getVideoSignals(videoId: string): Promise<VideoSignals>;
  getChannel(channelId: string): Promise<Channel>;
  getChannelVideos(
    channelId: string,
    continuation?: string,
    sort?: ChannelVideoSort
  ): Promise<ChannelVideos>;
  getChannelPlaylists(
    channelId: string,
    continuation?: string,
    sort?: ChannelPlaylistSort
  ): Promise<ChannelPlaylists>;
  getPlaylist(playlistId: string, continuation?: string): Promise<Playlist>;
  getCaptionTracks(videoId: string): Promise<CaptionTrackList>;
  getTranscript(options: TranscriptOptions): Promise<Transcript>;
  getComments(options: CommentOptions): Promise<CommentPage>;
  getAllComments(options: AllCommentOptions): Promise<CommentCollection>;
  getEndscreen(videoId: string): Promise<EndscreenElement[]>;
}

export function createYouTubeClient(options: YouTubeClientOptions = {}): YouTubeClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const language = options.language ?? 'en';
  const region = options.region ?? 'US';

  if (!fetchImpl) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      'A fetch implementation is required in this runtime.'
    );
  }
  const transport = createYouTubeTransport({ fetch: fetchImpl, ...options.retry });

  const contextFor = (
    profile: ClientProfile,
    locale: Pick<BrowseOptions, 'language' | 'region'> = {}
  ): JsonObject => ({
    client: {
      clientName: profile.clientName,
      clientVersion: profile.clientVersion,
      hl: locale.language ?? language,
      gl: locale.region ?? region,
      ...profile.context,
    },
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
  });

  const call = async (
    endpoint: string,
    payload: JsonObject,
    profile: ClientProfile = WEB_PROFILE,
    locale: Pick<BrowseOptions, 'language' | 'region'> = {}
  ): Promise<JsonObject> => {
    const response = await transport.fetch(`youtube:${endpoint}`, () => ({
      input: `${API_ROOT}/${endpoint}?prettyPrint=false`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          'User-Agent': profile.userAgent,
          'X-YouTube-Client-Name': profile.clientNameHeader,
          'X-YouTube-Client-Version': profile.clientVersion,
          Origin: 'https://www.youtube.com',
        },
        body: JSON.stringify({ context: contextFor(profile, locale), ...payload }),
      },
    }));
    if (!response.ok) {
      throw classifyHttpError(
        response.status,
        `YouTube ${endpoint} request failed: ${response.status} ${response.statusText}`
      );
    }
    try {
      return object(await response.json());
    } catch (cause) {
      throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned invalid JSON.', {
        cause,
        retryable: true,
      });
    }
  };

  const player = async (videoId: string, requireCaptionTrack = true): Promise<JsonObject> => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
    }
    const attempts: string[] = [];
    let firstResponse: JsonObject | undefined;
    for (const profile of PLAYER_PROFILES) {
      try {
        const response = await call(
          'player',
          { videoId, contentCheckOk: true, racyCheckOk: true },
          profile
        );
        firstResponse ??= response;
        const status = string(object(response.playabilityStatus).status);
        const tracks = parseCaptionTracks(response).internal;
        if (status === 'OK' && (!requireCaptionTrack || tracks.length)) return response;
        attempts.push(`${profile.name}: ${status ?? 'UNKNOWN'}`);
      } catch (error) {
        attempts.push(
          `${profile.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (firstResponse) return firstResponse;
    throw new YouTubeClientError(
      'UNAVAILABLE',
      `Video unavailable on every client. ${attempts.join('; ')}`,
      { retryable: attempts.some((attempt) => attempt.includes('LOGIN_REQUIRED')) }
    );
  };

  const desktopPlayer = async (videoId: string): Promise<DesktopPlayerResult | undefined> => {
    try {
      const response = await transport.fetch('watch-page', () => ({
        input: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        init: {
          headers: {
            Accept: 'text/html',
            'Accept-Language': `${language}-${region},${language};q=0.9`,
            'User-Agent': WEB_PROFILE.userAgent,
          },
        },
      }));
      if (!response.ok) return undefined;
      const raw = extractInitialPlayerResponse(await response.text());
      const cookies = responseCookies(response.headers);
      return raw ? { raw, cookies } : undefined;
    } catch {
      return undefined;
    }
  };

  const desktopChannelAbout = async (channelId: string): Promise<JsonObject | undefined> => {
    try {
      const response = await transport.fetch('channel-about', () => ({
        input: `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/about`,
        init: {
          headers: {
            Accept: 'text/html',
            'Accept-Language': `${language}-${region},${language};q=0.9`,
            'User-Agent': WEB_PROFILE.userAgent,
          },
        },
      }));
      return response.ok ? extractInitialData(await response.text()) : undefined;
    } catch {
      return undefined;
    }
  };

  const playerWithCaptionCatalog = async (videoId: string): Promise<{
    raw: JsonObject;
    captions: CaptionCatalog;
    captionCookies?: string;
  }> => {
    const [raw, desktop] = await Promise.all([player(videoId, true), desktopPlayer(videoId)]);
    return {
      raw,
      captions: mergeCaptionCatalog(
        parseCaptionTracks(raw),
        desktop ? parseCaptionTracks(desktop.raw) : undefined,
      ),
      captionCookies: desktop?.cookies,
    };
  };

  const rawBrowse = async (browseOptions: BrowseOptions = {}): Promise<JsonObject> => {
    const destination = browseDestination(browseOptions.categoryId);
    const browseId = browseOptions.browseId ?? destination?.browseId;
    if (!browseOptions.continuation && !browseId) {
      throw new YouTubeClientError(
        'INVALID_INPUT',
        'A supported categoryId or browseId is required.'
      );
    }
    const payload = browseOptions.continuation
      ? { continuation: browseOptions.continuation }
      : {
          browseId,
          ...(browseOptions.params ? { params: browseOptions.params } : {}),
        };
    return call('browse', payload, WEB_PROFILE, browseLocale(browseOptions));
  };

  const getCommentsPage = async (commentOptions: CommentOptions): Promise<CommentPage> => {
    if (!commentOptions.videoId && !commentOptions.continuation) {
      throw new YouTubeClientError('INVALID_INPUT', 'A videoId is required.');
    }
    let raw = await call(
      'next',
      commentOptions.continuation
        ? { continuation: decodeContinuation(commentOptions.continuation) }
        : { videoId: commentOptions.videoId }
    );
    let totalCount = firstRendererNumber(raw, ['commentsCount', 'commentCount']);
    const comments: Comment[] = [];
    const collectComments = (response: JsonObject) => {
      for (const rendererName of ['commentThreadRenderer', 'commentRenderer']) {
        for (const renderer of findRenderers(response, rendererName)) {
          const parsed = parseComment(renderer);
          if (parsed && !comments.some((comment) => comment.id === parsed.id)) {
            comments.push(parsed);
          }
        }
      }
      for (const payload of findRenderers(response, 'commentEntityPayload')) {
        const parsed = parseCommentEntity(payload);
        if (parsed && !comments.some((comment) => comment.id === parsed.id)) {
          comments.push(parsed);
        }
      }
    };
    collectComments(raw);
    let tokens = commentContinuationTokens(raw);
    // A video-id request often returns only the token that opens the comments
    // section. Advance that bootstrap token once so callers receive comments.
    if (!commentOptions.continuation && comments.length === 0) {
      const bootstrap = tokens.continuation ?? continuationToken(raw);
      if (bootstrap) {
        raw = await call('next', { continuation: decodeContinuation(bootstrap) });
        totalCount ??= firstRendererNumber(raw, ['commentsCount', 'commentCount']);
        collectComments(raw);
        tokens = commentContinuationTokens(raw);
      }
    }
    attachCommentReplies(comments);
    return {
      videoId: commentOptions.videoId,
      totalCount,
      comments,
      continuation: tokens.continuation,
      replyContinuations: tokens.replyContinuations,
      newestContinuation: tokens.newestContinuation,
      meta: meta([], comments.length === 0),
    };
  };

  const getAllComments = async (allOptions: AllCommentOptions): Promise<CommentCollection> => {
    const maxPages = Math.min(Math.max(Math.trunc(allOptions.maxPages ?? 100), 1), 500);
    const comments = new Map<string, Comment>();
    const replyQueue: string[] = [];
    const seenThreadTokens = new Set<string>();
    const seenReplyTokens = new Set<string>();
    let continuation: string | undefined;
    let totalCount: number | undefined;
    let pagesFetched = 0;
    let preferNewest = true;

    do {
      const page = await getCommentsPage({ videoId: allOptions.videoId, continuation });
      totalCount ??= page.totalCount;
      if (preferNewest && page.newestContinuation) {
        continuation = page.newestContinuation;
        preferNewest = false;
        continue;
      }
      preferNewest = false;
      pagesFetched += 1;
      for (const comment of page.comments) comments.set(comment.id, comment);
      replyQueue.push(...page.replyContinuations);
      continuation = page.continuation;
      if (continuation) {
        if (seenThreadTokens.has(continuation)) break;
        seenThreadTokens.add(continuation);
      }
    } while (continuation && pagesFetched < maxPages);

    while (replyQueue.length && pagesFetched < maxPages) {
      const replyContinuation = replyQueue.shift()!;
      if (seenReplyTokens.has(replyContinuation)) continue;
      seenReplyTokens.add(replyContinuation);
      const page = await getCommentsPage({
        videoId: allOptions.videoId,
        continuation: replyContinuation,
      });
      totalCount ??= page.totalCount;
      pagesFetched += 1;
      for (const comment of page.comments) comments.set(comment.id, comment);
      replyQueue.push(...page.replyContinuations);
      if (page.continuation) replyQueue.push(page.continuation);
    }

    const normalizedComments = attachCommentReplies([...comments.values()]);
    const complete = !continuation && replyQueue.length === 0;
    const topLevelCount = [...comments.keys()].filter((id) => !id.includes('.')).length;
    return {
      videoId: allOptions.videoId,
      totalCount,
      comments: normalizedComments,
      continuation: complete ? undefined : continuation,
      replyContinuations: [],
      newestContinuation: undefined,
      complete,
      pagesFetched,
      topLevelCount,
      replyCount: comments.size - topLevelCount,
      remainingContinuations: replyQueue.length + (continuation ? 1 : 0),
      meta: meta(complete ? [] : ['Comment crawl reached its page limit.'], !complete),
    };
  };

  return {
    async search(query, filters = {}) {
      if (!query.trim() && !filters.continuation) {
        throw new YouTubeClientError('INVALID_INPUT', 'A search query is required.');
      }
      const raw = await call(
        'search',
        filters.continuation
          ? { continuation: filters.continuation }
          : {
              query: query.trim(),
              ...(filters.captionsOnly ? { params: SEARCH_CAPTIONS_PARAM } : {}),
            }
      );
      const allResults = parseSearchResults(raw).map((result) =>
        filters.captionsOnly && result.type === 'video'
          ? { ...result, hasCaptions: true }
          : result
      );
      let results = filters.type && filters.type !== 'all'
        ? allResults.filter((result) => result.type === filters.type)
        : allResults;
      results = results.filter((result) => {
        if (result.type !== 'video') return true;
        if (filters.channelId && result.channel.id !== filters.channelId) return false;
        if (filters.minViews !== undefined && (result.viewCount ?? 0) < filters.minViews) return false;
        if (filters.live === 'live' && !result.isLive) return false;
        if (filters.live === 'completed' && result.isLive) return false;
        const seconds = result.durationSeconds;
        if (filters.duration === 'short' && seconds !== undefined && seconds >= 240) return false;
        if (filters.duration === 'medium' && seconds !== undefined && (seconds < 240 || seconds > 1200)) return false;
        if (filters.duration === 'long' && seconds !== undefined && seconds <= 1200) return false;
        return true;
      });
      if (filters.sort === 'views') {
        results = [...results].sort((a, b) =>
          (b.type === 'video' ? b.viewCount ?? 0 : 0) - (a.type === 'video' ? a.viewCount ?? 0 : 0)
        );
      }
      const videos = results.filter((result): result is VideoSummary => result.type === 'video');
      const channels = results.filter((result): result is ChannelSummary => result.type === 'channel');
      const playlists = results.filter((result): result is PlaylistSummary => result.type === 'playlist');
      return {
        query,
        results,
        videos,
        channels,
        playlists,
        continuation: continuationToken(raw),
        meta: meta([], allResults.length === 0),
      };
    },

    async browse(browseOptions = {}) {
      const destination = browseDestination(browseOptions.categoryId);
      const raw = await rawBrowse(browseOptions);
      const results = parseSearchResults(raw);
      const videos = results.filter((result): result is VideoSummary => result.type === 'video');
      const channels = results.filter((result): result is ChannelSummary => result.type === 'channel');
      const playlists = results.filter((result): result is PlaylistSummary => result.type === 'playlist');
      const titleRenderer = findRenderers(raw, 'channelMetadataRenderer')[0];
      return {
        category: destination?.category,
        browseId: browseOptions.browseId ?? destination?.browseId,
        title:
          string(titleRenderer?.title) ??
          rendererText(findRenderers(raw, 'pageHeaderRenderer')[0]?.pageTitle) ??
          (destination
            ? `${destination.category[0]?.toUpperCase()}${destination.category.slice(1)}`
            : undefined),
        results,
        videos,
        channels,
        playlists,
        continuation: continuationToken(raw),
        meta: meta([], results.length === 0),
      };
    },

    async getVideo(videoId) {
      const raw = await player(videoId, false);
      const details = object(raw.videoDetails);
      const status = object(raw.playabilityStatus);
      const author = string(details.author) ?? 'Unknown channel';
      const channelId = string(details.channelId) ?? '';
      const playability = string(status.status) ?? 'UNKNOWN';
      const durationSeconds = number(details.lengthSeconds);
      const viewCount = number(details.viewCount);
      const warnings: string[] = [];
      if (playability !== 'OK') warnings.push(string(status.reason) ?? playability);
      return {
        type: 'video',
        id: string(details.videoId) ?? videoId,
        title: string(details.title) ?? 'Unavailable video',
        description: string(details.shortDescription),
        channel: {
          id: channelId,
          name: author,
          url: channelId ? `https://www.youtube.com/channel/${channelId}` : '',
        },
        thumbnails: rendererThumbnails(details.thumbnail),
        durationSeconds,
        durationText: formatDuration(durationSeconds),
        viewCount,
        viewCountText: formatViewCount(viewCount, language, region),
        publishedTimeText: undefined,
        isLive: details.isLiveContent === true,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        keywords: array(details.keywords).filter(
          (keyword): keyword is string => typeof keyword === 'string'
        ),
        availability: {
          status: playability,
          reason: string(status.reason),
          playable: playability === 'OK',
          embeddable: status.playableInEmbed === true,
          isPrivate: details.isPrivate === true,
          isLive: details.isLiveContent === true,
          ratingsAllowed: details.allowRatings === true,
        } satisfies Availability,
        meta: meta(warnings, playability !== 'OK'),
      };
    },

    async getVideoSignals(videoId) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
      }
      return parseVideoSignals(videoId, await call('next', { videoId }));
    },

    async getChannel(channelId) {
      if (!channelId) {
        throw new YouTubeClientError('INVALID_INPUT', 'A channelId is required.');
      }
      const aboutRaw = await desktopChannelAbout(channelId);
      const raw = aboutRaw ?? await rawBrowse({ browseId: channelId });
      const metadata = findRenderers(raw, 'channelMetadataRenderer')[0] ?? {};
      const about = findRenderers(raw, 'aboutChannelViewModel')[0] ?? {};
      if (
        !string(metadata.externalId) &&
        !string(metadata.title) &&
        !rendererText(metadata.title) &&
        !string(about.channelId)
      ) {
        throw new YouTubeClientError('NOT_FOUND', `YouTube channel ${channelId} was not found.`, {
          status: 404,
        });
      }
      const name = string(metadata.title) ?? rendererText(metadata.title) ?? 'Unknown channel';
      const resolvedId = string(about.channelId) ?? string(metadata.externalId) ?? channelId;
      const headerCounts = channelHeaderCounts(raw);
      const subscriberCountText = string(about.subscriberCountText) ??
        headerCounts.subscriberCountText ?? rendererText(metadata.subscriberCountText);
      const videoCountText = string(about.videoCountText) ??
        headerCounts.videoCountText ?? rendererText(metadata.videoCountText);
      const viewCountText = string(about.viewCountText);
      const joinedDateText = rendererText(about.joinedDateText);
      const canonicalChannelUrl = normalizedChannelUrl(
        string(about.canonicalChannelUrl) ?? string(metadata.channelUrl),
        resolvedId,
      );
      const handleCandidate = canonicalChannelUrl.split('/').pop();
      const metadataHandle = string(metadata.vanityChannelUrl)?.split('/').pop();
      const hasAbout = Object.keys(about).length > 0;
      return {
        type: 'channel',
        id: resolvedId,
        name,
        handle: handleCandidate?.startsWith('@')
          ? handleCandidate
          : metadataHandle?.startsWith('@') ? metadataHandle : undefined,
        thumbnails: rendererThumbnails(metadata.avatar),
        url: canonicalChannelUrl,
        about: {
          description: string(about.description) ?? string(metadata.description),
          links: channelExternalLinks(raw),
          moreInfo: {
            canonicalChannelUrl,
            displayCanonicalChannelUrl: string(about.displayCanonicalChannelUrl),
            joinedDate: joinedDate(joinedDateText),
            joinedDateText,
            subscriberCount: parseCompactNumber(subscriberCountText),
            subscriberCountText,
            videoCount: parseCompactNumber(videoCountText),
            videoCountText,
            viewCount: parseCompactNumber(viewCountText),
            viewCountText,
            businessEmailAvailable: Object.keys(object(about.signInForBusinessEmail)).length > 0,
          },
        },
        meta: meta(hasAbout ? [] : ['Channel About details are unavailable.'], !hasAbout),
      };
    },

    async getChannelVideos(channelId, continuation, sort = 'latest') {
      if (!channelId) {
        throw new YouTubeClientError('INVALID_INPUT', 'A channelId is required.');
      }
      assertChannelVideoSort(sort);
      const channelRawPromise = rawBrowse({ browseId: channelId });
      const pagePromise = continuation
        ? rawBrowse({ continuation }).then((raw) => ({ raw, appliedSort: sort }))
        : channelRawPromise.then(async (raw) => {
            const tab = channelTabBrowseOptions(raw, '/videos');
            if (!tab) return undefined;
            const initial = await rawBrowse(tab);
            if (sort === 'latest') return { raw: initial, appliedSort: sort };
            const sortContinuation = channelVideoSortContinuation(initial, sort);
            if (!sortContinuation) {
              return {
                raw: initial,
                appliedSort: 'latest' as const,
                warning: `Requested video sort ${sort} is unavailable; latest results were returned.`,
              };
            }
            return { raw: await rawBrowse({ continuation: sortContinuation }), appliedSort: sort };
          });
      const [channelRaw, page] = await Promise.all([channelRawPromise, pagePromise]);
      const pageRaw = page?.raw;
      const metadata = findRenderers(channelRaw, 'channelMetadataRenderer')[0] ?? {};
      const resolvedId = string(metadata.externalId) ?? channelId;
      const channelSummary = {
        id: resolvedId,
        name: string(metadata.title) ?? rendererText(metadata.title) ?? 'Unknown channel',
        url: string(metadata.channelUrl) ?? `https://www.youtube.com/channel/${resolvedId}`,
      };
      const videos = pageRaw
        ? parseSearchResults(pageRaw, channelSummary).filter(
            (item): item is VideoSummary => item.type === 'video'
          )
        : [];
      const pageWarning = page && 'warning' in page ? page.warning : undefined;
      return {
        channelId: resolvedId,
        sort: page?.appliedSort ?? sort,
        videos,
        continuation: pageRaw ? catalogContinuationToken(pageRaw) : undefined,
        meta: meta(
          pageRaw ? pageWarning ? [pageWarning] : [] : ['Channel videos tab is unavailable.'],
          !pageRaw || Boolean(pageWarning)
        ),
      };
    },

    async getChannelPlaylists(channelId, continuation, sort = 'newest') {
      if (!channelId) {
        throw new YouTubeClientError('INVALID_INPUT', 'A channelId is required.');
      }
      assertChannelPlaylistSort(sort);
      const channelRawPromise = rawBrowse({ browseId: channelId });
      const pagePromise = continuation
        ? rawBrowse({ continuation }).then((raw) => ({ raw, appliedSort: sort }))
        : channelRawPromise.then(async (raw) => {
            const tab = channelTabBrowseOptions(raw, '/playlists');
            if (!tab) return undefined;
            const initial = await rawBrowse(tab);
            if (sort === 'newest') return { raw: initial, appliedSort: sort };
            const sortBrowse = channelPlaylistSortBrowseOptions(initial, sort);
            if (!sortBrowse) {
              return {
                raw: initial,
                appliedSort: 'newest' as const,
                warning: `Requested playlist sort ${sort} is unavailable; newest results were returned.`,
              };
            }
            return { raw: await rawBrowse(sortBrowse), appliedSort: sort };
          });
      const [channelRaw, page] = await Promise.all([channelRawPromise, pagePromise]);
      const pageRaw = page?.raw;
      const metadata = findRenderers(channelRaw, 'channelMetadataRenderer')[0] ?? {};
      const resolvedId = string(metadata.externalId) ?? channelId;
      const channelSummary = {
        id: resolvedId,
        name: string(metadata.title) ?? rendererText(metadata.title) ?? 'Unknown channel',
        url: string(metadata.channelUrl) ?? `https://www.youtube.com/channel/${resolvedId}`,
      };
      const playlists = pageRaw
        ? parseSearchResults(pageRaw, channelSummary).filter(
            (item): item is PlaylistSummary => item.type === 'playlist'
          )
        : [];
      const pageWarning = page && 'warning' in page ? page.warning : undefined;
      return {
        channelId: resolvedId,
        sort: page?.appliedSort ?? sort,
        playlists,
        continuation: pageRaw ? catalogContinuationToken(pageRaw) : undefined,
        meta: meta(
          pageRaw ? pageWarning ? [pageWarning] : [] : ['Channel playlists tab is unavailable.'],
          !pageRaw || Boolean(pageWarning)
        ),
      };
    },

    async getPlaylist(playlistId, continuation) {
      if (!playlistId && !continuation) {
        throw new YouTubeClientError('INVALID_INPUT', 'A playlistId is required.');
      }
      assertPlaylistId(playlistId);
      const raw = await rawBrowse({
        browseId: continuation ? undefined : `VL${playlistId}`,
        continuation,
      });
      const header = playlistHeaderData(raw);
      const results = parseSearchResults(raw, header.channel);
      const videos = results.filter((item): item is VideoSummary => item.type === 'video');
      const rawContinuation = continuationToken(raw);
      return {
        type: 'playlist',
        id: playlistId,
        title: header.title ?? 'YouTube playlist',
        description: header.description,
        channel: header.channel,
        thumbnails: header.thumbnails,
        videoCount: header.videoCount ?? videos.length,
        videoCountText: header.videoCountText,
        isPodcast: header.isPodcast,
        url: `https://www.youtube.com/playlist?list=${playlistId}`,
        videos,
        continuation:
          header.videoCount !== undefined && videos.length >= header.videoCount
            ? undefined
            : rawContinuation,
        meta: meta([], videos.length === 0),
      };
    },

    async getCaptionTracks(videoId) {
      const { captions } = await playerWithCaptionCatalog(videoId);
      return {
        tracks: captions.public,
        sourceTracks: captions.public,
        translationLanguages: captions.translations,
        autoTranslationTargets: captions.translations,
        defaultTrackId: captions.defaultTrackId,
        meta: meta([], captions.public.length === 0),
      };
    },

    async getTranscript(transcriptOptions) {
      const requestedTranslation = transcriptOptions.translateTo?.trim();
      const prepareRequest = async () => {
        const { captions, captionCookies } = await playerWithCaptionCatalog(transcriptOptions.videoId);
        const selected = chooseCaptionTrack(
          captions.internal,
          transcriptOptions.language,
          transcriptOptions.trackId,
          captions.defaultTrackId,
        );
        if (!selected) {
          throw new YouTubeClientError('NOT_FOUND', 'No caption track is available.');
        }
        const translatedTo = requestedTranslation && requestedTranslation !== selected.track.languageCode
          ? captions.translations.find((candidate) => candidate.languageCode === requestedTranslation)
          : undefined;
        if (requestedTranslation && requestedTranslation !== selected.track.languageCode && !translatedTo) {
          throw new YouTubeClientError(
            'INVALID_INPUT',
            `Translation language ${requestedTranslation} is not available.`,
          );
        }
        const url = new URL(selected.track.baseUrl);
        url.searchParams.set('fmt', 'json3');
        if (translatedTo) url.searchParams.set('tlang', translatedTo.languageCode);
        const selectedTrackInfo = captions.public[selected.index] ??
          captionTrackInfo(selected.track, selected.index);
        return { selected, selectedTrackInfo, translatedTo, url, captionCookies };
      };

      let prepared: Awaited<ReturnType<typeof prepareRequest>> | undefined;
      const response = await transport.fetch('captions', async () => {
        prepared = await prepareRequest();
        return {
          input: prepared.url,
          init: {
            headers: {
              'User-Agent': PLAYER_PROFILES[0]!.userAgent,
              ...(prepared.captionCookies ? { Cookie: prepared.captionCookies } : {}),
            },
          },
        };
      });
      if (!prepared) throw new YouTubeClientError('UPSTREAM_ERROR', 'Caption request was not prepared.');
      if (!response.ok) {
        throw classifyHttpError(
          response.status,
          `Caption fetch failed: ${response.status} ${response.statusText}`
        );
      }
      let json: JsonObject;
      try {
        json = object(await response.json());
      } catch (cause) {
        throw new YouTubeClientError(
          'INVALID_RESPONSE',
          'Caption response was not valid JSON.',
          { cause, retryable: true }
        );
      }
      const segments: TranscriptSegment[] = [];
      for (const value of array(json.events)) {
        const event = object(value);
        if (event.aAppend === 1 || !Array.isArray(event.segs)) continue;
        const startMs = number(event.tStartMs) ?? 0;
        const durationMs = number(event.dDurationMs) ?? 0;
        const words = array(event.segs)
          .map((segmentValue) => {
            const segment = object(segmentValue);
            const rawText = string(segment.utf8) ?? '';
            const text = he.decode(striptags(rawText));
            const offsetMs = number(segment.tOffsetMs) ?? 0;
            return { text, startMs: startMs + offsetMs, offsetMs };
          })
          .filter((word) => word.text.length > 0);
        const text = words.map((word) => word.text).join('').trim();
        if (!text) continue;
        segments.push({
          startMs,
          durationMs,
          endMs: startMs + durationMs,
          text,
          words:
            transcriptOptions.granularity === 'word' ? words : undefined,
        });
      }
      return {
        videoId: transcriptOptions.videoId,
        track: prepared.selectedTrackInfo,
        translatedTo: prepared.translatedTo,
        segments,
        granularity: transcriptOptions.granularity ?? 'segment',
        text: segments.map((segment) => segment.text).join('\n'),
        meta: meta([], segments.length === 0),
      };
    },

    getComments: getCommentsPage,

    getAllComments,

    async getEndscreen(videoId) {
      return parseEndscreen(await player(videoId, false));
    },
  };
}

function decodeContinuation(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

export async function search(
  query: string,
  options: YouTubeClientOptions & SearchFilters = {}
): Promise<SearchResponse> {
  const { fetch, language, region, ...filters } = options;
  return createYouTubeClient({ fetch, language, region }).search(query, filters);
}

export async function browse(
  options: YouTubeClientOptions & BrowseOptions = {}
): Promise<BrowseResponse> {
  const { fetch, ...browseOptions } = options;
  return createYouTubeClient({ fetch, language: options.language, region: options.region }).browse(browseOptions);
}

export async function getVideo(
  videoId: string,
  options: YouTubeClientOptions = {}
): Promise<Video> {
  return createYouTubeClient(options).getVideo(videoId);
}

export async function getVideoSignals(
  videoId: string,
  options: YouTubeClientOptions = {}
): Promise<VideoSignals> {
  return createYouTubeClient(options).getVideoSignals(videoId);
}

export async function getChannel(
  channelId: string,
  options: YouTubeClientOptions = {}
): Promise<Channel> {
  return createYouTubeClient(options).getChannel(channelId);
}

export async function getChannelVideos(
  channelId: string,
  options: YouTubeClientOptions & { continuation?: string; sort?: ChannelVideoSort } = {}
): Promise<ChannelVideos> {
  const { continuation, sort, ...clientOptions } = options;
  return createYouTubeClient(clientOptions).getChannelVideos(channelId, continuation, sort);
}

export async function getChannelPlaylists(
  channelId: string,
  options: YouTubeClientOptions & { continuation?: string; sort?: ChannelPlaylistSort } = {}
): Promise<ChannelPlaylists> {
  const { continuation, sort, ...clientOptions } = options;
  return createYouTubeClient(clientOptions).getChannelPlaylists(channelId, continuation, sort);
}

export async function getPlaylist(
  playlistId: string,
  options: YouTubeClientOptions & { continuation?: string } = {}
): Promise<Playlist> {
  const { continuation, ...clientOptions } = options;
  return createYouTubeClient(clientOptions).getPlaylist(playlistId, continuation);
}

export async function getCaptionTracks(
  videoId: string,
  options: YouTubeClientOptions = {}
): Promise<CaptionTrackList> {
  return createYouTubeClient(options).getCaptionTracks(videoId);
}

export async function getTranscript(
  transcriptOptions: TranscriptOptions,
  options: YouTubeClientOptions = {}
): Promise<Transcript> {
  return createYouTubeClient(options).getTranscript(transcriptOptions);
}

export async function getComments(
  commentOptions: CommentOptions,
  options: YouTubeClientOptions = {}
): Promise<CommentPage> {
  return createYouTubeClient(options).getComments(commentOptions);
}

export async function getAllComments(
  allOptions: AllCommentOptions,
  options: YouTubeClientOptions = {}
): Promise<CommentCollection> {
  return createYouTubeClient(options).getAllComments(allOptions);
}

export async function getEndscreen(
  videoId: string,
  options: YouTubeClientOptions = {}
): Promise<EndscreenElement[]> {
  return createYouTubeClient(options).getEndscreen(videoId);
}
