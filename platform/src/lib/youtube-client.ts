import he from 'he';
import striptags from 'striptags';
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
  ChannelSummary,
  Comment,
  CommentCollection,
  CommentOptions,
  CommentPage,
  EndscreenElement,
  MediaFormat,
  Playlist,
  PlaylistSummary,
  SearchFilters,
  SearchResponse,
  SearchResult,
  SourceMetadata,
  Storyboard,
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
      region: normalizeBrowseRegion(options.region),
      language: normalizeBrowseLanguage(options.language),
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
  const match = value.replace(/,/g, '').match(/([0-9.]+)\s*([KMB])?/i);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
    (match[2] ?? '').toUpperCase()
  ];
  return Math.round(base * (multiplier ?? 1));
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
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
  const metadataParts = array(contentMetadata.metadataRows).flatMap((row) =>
    array(object(row).metadataParts).map((part) => rendererText(object(part).text)).filter(
      (value): value is string => Boolean(value)
    )
  );
  const thumbnailRenderer = findRenderers(renderer.contentImage, 'thumbnailViewModel')[0] ?? {};
  const thumbnails = rendererThumbnails(thumbnailRenderer.image);
  const badgeTexts = findRenderers(renderer.contentImage, 'thumbnailBadgeViewModel')
    .map((badge) => rendererText(badge.text))
    .filter((value): value is string => Boolean(value));

  if (contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    const viewCountText = metadataParts.find((value) => /\bviews?$/i.test(value));
    const publishedTimeText = metadataParts.find((value) =>
      /\b(?:ago|streamed|premiered)\b/i.test(value)
    );
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
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  if (contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' || contentType === 'LOCKUP_CONTENT_TYPE_PODCAST') {
    const videoCountText = badgeTexts.find((value) => /\bvideos?$/i.test(value));
    return {
      type: 'playlist',
      id,
      title,
      channel: fallbackChannel,
      thumbnails,
      videoCount: parseCompactNumber(videoCountText),
      videoCountText,
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

function playlistHeaderData(root: unknown): {
  title?: string;
  description?: string;
  channel: Pick<ChannelSummary, 'id' | 'name' | 'url'>;
  thumbnails: Thumbnail[];
  videoCount?: number;
  videoCountText?: string;
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
  };
}

function meta(warnings: string[] = [], partial = false): SourceMetadata {
  return {
    source: 'innertube',
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

function parseCaptionTracks(player: JsonObject): {
  internal: InternalCaptionTrack[];
  public: CaptionTrackInfo[];
  translations: TranslationLanguage[];
  defaultTrackId?: string;
} {
  const renderer = object(object(player.captions).playerCaptionsTracklistRenderer);
  const defaultIndex = number(renderer.defaultAudioTrackIndex) ?? 0;
  const internal = array(renderer.captionTracks)
    .flatMap((item): InternalCaptionTrack[] => {
      const track = object(item);
      const baseUrl = string(track.baseUrl);
      if (!baseUrl) return [];
      return [{
        baseUrl,
        vssId: string(track.vssId),
        languageCode: string(track.languageCode),
        kind: string(track.kind),
        name: track.name,
        isTranslatable: track.isTranslatable === true,
      }];
    });
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

function chooseCaptionTrack(
  internal: InternalCaptionTrack[],
  language: string,
  trackId?: string
): { track: InternalCaptionTrack; index: number } | undefined {
  const index = trackId
    ? internal.findIndex((track) => (track.vssId ?? track.languageCode) === trackId)
    : internal.findIndex((track) => track.vssId === `.${language}`) >= 0
      ? internal.findIndex((track) => track.vssId === `.${language}`)
      : internal.findIndex((track) => track.vssId === `a.${language}`) >= 0
        ? internal.findIndex((track) => track.vssId === `a.${language}`)
        : internal.findIndex((track) => track.languageCode === language);
  const selectedIndex = index >= 0 ? index : 0;
  const track = internal[selectedIndex];
  return track ? { track, index: selectedIndex } : undefined;
}

function parseMediaFormat(value: unknown): MediaFormat | null {
  const source = object(value);
  const itag = number(source.itag);
  const mimeType = string(source.mimeType);
  if (itag === undefined || !mimeType) return null;
  const codec = mimeType.match(/codecs="([^"]+)"/)?.[1];
  const colorInfo = object(source.colorInfo);
  const transfer = string(colorInfo.transferCharacteristics) ?? '';
  return {
    itag,
    mimeType,
    codec,
    quality: string(source.quality),
    qualityLabel: string(source.qualityLabel),
    width: number(source.width),
    height: number(source.height),
    fps: number(source.fps),
    bitrate: number(source.bitrate),
    averageBitrate: number(source.averageBitrate),
    contentLength: number(source.contentLength),
    durationMs: number(source.approxDurationMs),
    audioQuality: string(source.audioQuality),
    audioSampleRate: number(source.audioSampleRate),
    audioChannels: number(source.audioChannels),
    projectionType: string(source.projectionType),
    isHdr: transfer.includes('HLG') || transfer.includes('PQ'),
  };
}

function parseStoryboards(player: JsonObject): Storyboard[] {
  const renderer = object(object(player.storyboards).playerStoryboardSpecRenderer);
  const spec = string(renderer.spec);
  if (!spec) return [];
  const [baseUrl = '', ...rawLevels] = spec.split('|');
  const levels = rawLevels
    .map((raw, levelIndex) => {
      const [width, height, count, columns, rows, intervalMs] = raw.split('#');
      const parsed = [width, height, count, columns, rows, intervalMs].map(Number);
      if (parsed.some((item) => !Number.isFinite(item))) return null;
      return {
        width: parsed[0]!,
        height: parsed[1]!,
        count: parsed[2]!,
        columns: parsed[3]!,
        rows: parsed[4]!,
        intervalMs: parsed[5]!,
        urlTemplate: baseUrl.replace('$L', String(levelIndex)),
      };
    })
    .filter((level): level is NonNullable<typeof level> => level !== null);
  return levels.length
    ? [{ recommendedLevel: number(renderer.recommendedLevel), levels }]
    : [];
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
  getChannel(channelId: string, continuation?: string): Promise<Channel>;
  getPlaylist(playlistId: string, continuation?: string): Promise<Playlist>;
  getCaptionTracks(videoId: string): Promise<CaptionTrackList>;
  getTranscript(options: TranscriptOptions): Promise<Transcript>;
  getComments(options: CommentOptions): Promise<CommentPage>;
  getAllComments(options: AllCommentOptions): Promise<CommentCollection>;
  getStoryboards(videoId: string): Promise<Storyboard[]>;
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
    const response = await fetchImpl(`${API_ROOT}/${endpoint}?prettyPrint=false`, {
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
    });
    if (!response.ok) {
      throw classifyHttpError(
        response.status,
        `InnerTube ${endpoint} failed: ${response.status} ${response.statusText}`
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

  const player = async (videoId: string): Promise<JsonObject> => {
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
        if (status === 'OK' && tracks.length) return response;
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
        collectComments(raw);
        tokens = commentContinuationTokens(raw);
      }
    }
    return {
      videoId: commentOptions.videoId,
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
    let pagesFetched = 0;
    let preferNewest = true;

    do {
      const page = await getCommentsPage({ videoId: allOptions.videoId, continuation });
      pagesFetched += 1;
      if (preferNewest && page.newestContinuation) {
        continuation = page.newestContinuation;
        preferNewest = false;
        continue;
      }
      preferNewest = false;
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
      pagesFetched += 1;
      for (const comment of page.comments) comments.set(comment.id, comment);
      replyQueue.push(...page.replyContinuations);
      if (page.continuation) replyQueue.push(page.continuation);
    }

    const complete = !continuation && replyQueue.length === 0;
    const topLevelCount = [...comments.keys()].filter((id) => !id.includes('.')).length;
    return {
      videoId: allOptions.videoId,
      comments: [...comments.values()],
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
          : { query: query.trim() }
      );
      const allResults = parseSearchResults(raw);
      let results = filters.type && filters.type !== 'all'
        ? allResults.filter((result) => result.type === filters.type)
        : allResults;
      results = results.filter((result) => {
        if (result.type !== 'video') return true;
        if (filters.channelId && result.channel.id !== filters.channelId) return false;
        if (filters.captionsOnly && !result.hasCaptions) return false;
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
      const raw = await player(videoId);
      const details = object(raw.videoDetails);
      const status = object(raw.playabilityStatus);
      const streaming = object(raw.streamingData);
      const captions = parseCaptionTracks(raw);
      const allFormats = [
        ...array(streaming.formats),
        ...array(streaming.adaptiveFormats),
      ]
        .map(parseMediaFormat)
        .filter((format): format is MediaFormat => format !== null);
      const author = string(details.author) ?? 'Unknown channel';
      const channelId = string(details.channelId) ?? '';
      const playability = string(status.status) ?? 'UNKNOWN';
      const expiresInSeconds = number(streaming.expiresInSeconds);
      const warnings: string[] = [];
      if (!captions.public.length) warnings.push('No caption tracks were returned.');
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
        durationSeconds: number(details.lengthSeconds),
        durationText: undefined,
        viewCount: number(details.viewCount),
        viewCountText: string(details.viewCount),
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
        captionTracks: captions.public,
        translationLanguages: captions.translations,
        media: {
          expiresAt:
            expiresInSeconds === undefined
              ? undefined
              : new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
          aspectRatio: number(streaming.aspectRatio),
          videoFormats: allFormats.filter((format) => format.mimeType.startsWith('video/')),
          audioFormats: allFormats.filter((format) => format.mimeType.startsWith('audio/')),
        },
        storyboards: parseStoryboards(raw),
        endscreen: parseEndscreen(raw),
        meta: meta(warnings, playability !== 'OK'),
      };
    },

    async getVideoSignals(videoId) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
      }
      return parseVideoSignals(videoId, await call('next', { videoId }));
    },

    async getChannel(channelId, continuation) {
      if (!channelId && !continuation) {
        throw new YouTubeClientError('INVALID_INPUT', 'A channelId is required.');
      }
      const raw = await rawBrowse({ browseId: channelId, continuation });
      const metadata = findRenderers(raw, 'channelMetadataRenderer')[0] ?? {};
      const name = string(metadata.title) ?? rendererText(metadata.title) ?? 'Unknown channel';
      const resolvedId = string(metadata.externalId) ?? channelId;
      const channelSummary = {
        id: resolvedId,
        name,
        url: string(metadata.channelUrl) ?? `https://www.youtube.com/channel/${resolvedId}`,
      };
      const videoTab = continuation ? undefined : channelTabBrowseOptions(raw, '/videos');
      const playlistTab = continuation ? undefined : channelTabBrowseOptions(raw, '/playlists');
      const [videoRaw, playlistRaw] = await Promise.all([
        videoTab ? rawBrowse(videoTab) : Promise.resolve(raw),
        playlistTab ? rawBrowse(playlistTab) : Promise.resolve(raw),
      ]);
      const videos = parseSearchResults(videoRaw, channelSummary).filter(
        (item): item is VideoSummary => item.type === 'video'
      );
      const playlists = parseSearchResults(playlistRaw, channelSummary).filter(
        (item): item is PlaylistSummary => item.type === 'playlist'
      );
      const headerCounts = channelHeaderCounts(raw);
      return {
        type: 'channel',
        id: resolvedId,
        name,
        description: string(metadata.description),
        handle: string(metadata.vanityChannelUrl)?.split('/').pop(),
        subscriberCountText: headerCounts.subscriberCountText ?? rendererText(metadata.subscriberCountText),
        videoCountText: headerCounts.videoCountText ?? rendererText(metadata.videoCountText),
        thumbnails: rendererThumbnails(metadata.avatar),
        url: channelSummary.url,
        videos,
        playlists,
        continuation: continuationToken(videoRaw),
        meta: meta([], videos.length === 0 && playlists.length === 0),
      };
    },

    async getPlaylist(playlistId, continuation) {
      if (!playlistId && !continuation) {
        throw new YouTubeClientError('INVALID_INPUT', 'A playlistId is required.');
      }
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
      const raw = await player(videoId);
      const captions = parseCaptionTracks(raw);
      return {
        tracks: captions.public,
        translationLanguages: captions.translations,
        defaultTrackId: captions.defaultTrackId,
        meta: meta([], captions.public.length === 0),
      };
    },

    async getTranscript(transcriptOptions) {
      const raw = await player(transcriptOptions.videoId);
      const captions = parseCaptionTracks(raw);
      const selected = chooseCaptionTrack(
        captions.internal,
        transcriptOptions.language ?? language,
        transcriptOptions.trackId
      );
      if (!selected) {
        throw new YouTubeClientError('NOT_FOUND', 'No caption track is available.');
      }
      const url = new URL(selected.track.baseUrl);
      url.searchParams.set('fmt', 'json3');
      if (transcriptOptions.translateTo) {
        url.searchParams.set('tlang', transcriptOptions.translateTo);
      }
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': PLAYER_PROFILES[0]!.userAgent },
      });
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
        track: captionTrackInfo(selected.track, selected.index),
        segments,
        granularity: transcriptOptions.granularity ?? 'segment',
        text: segments.map((segment) => segment.text).join('\n'),
        meta: meta([], segments.length === 0),
      };
    },

    getComments: getCommentsPage,

    getAllComments,

    async getStoryboards(videoId) {
      return parseStoryboards(await player(videoId));
    },

    async getEndscreen(videoId) {
      return parseEndscreen(await player(videoId));
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
  options: YouTubeClientOptions & { continuation?: string } = {}
): Promise<Channel> {
  const { continuation, ...clientOptions } = options;
  return createYouTubeClient(clientOptions).getChannel(channelId, continuation);
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

export async function getStoryboards(
  videoId: string,
  options: YouTubeClientOptions = {}
): Promise<Storyboard[]> {
  return createYouTubeClient(options).getStoryboards(videoId);
}

export async function getEndscreen(
  videoId: string,
  options: YouTubeClientOptions = {}
): Promise<EndscreenElement[]> {
  return createYouTubeClient(options).getEndscreen(videoId);
}
