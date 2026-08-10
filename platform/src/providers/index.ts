import * as youtube from '../lib/youtube';
import { researchTrendTopic } from '../lib/trends';
import { ApiError } from '../lib/http';
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_IDS,
  type ProviderDescriptor,
  type ProviderId,
} from './contract';

export * from './contract';

const youtubeDescriptor = {
  id: 'youtube',
  name: 'YouTube',
  capabilities: PROVIDER_CAPABILITIES,
} as const satisfies ProviderDescriptor;

export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  search: typeof youtube.searchYouTubeWithCache;
  browse: typeof youtube.browseYouTubeWithCache;
  normalizeBrowseOptions: typeof youtube.normalizeBrowseOptions;
  trends: typeof researchTrendTopic;
  getVideo: typeof youtube.getVideoWithCache;
  getTracks: typeof youtube.getCaptionTracks;
  getTranscript: typeof youtube.getTranscriptWithCache;
  getComments: typeof youtube.getCommentsWithCache;
  getAllComments: typeof youtube.getAllCommentsWithCache;
  getEndscreen: typeof youtube.getEndscreen;
  getChannel: typeof youtube.getChannelWithCache;
  getChannelVideos: typeof youtube.getChannelVideosWithCache;
  getChannelPlaylists: typeof youtube.getChannelPlaylistsWithCache;
  getPlaylist: typeof youtube.getPlaylistWithCache;
}

const youtubeProvider = {
  descriptor: youtubeDescriptor,
  search: youtube.searchYouTubeWithCache,
  browse: youtube.browseYouTubeWithCache,
  normalizeBrowseOptions: youtube.normalizeBrowseOptions,
  trends: researchTrendTopic,
  getVideo: youtube.getVideoWithCache,
  getTracks: youtube.getCaptionTracks,
  getTranscript: youtube.getTranscriptWithCache,
  getComments: youtube.getCommentsWithCache,
  getAllComments: youtube.getAllCommentsWithCache,
  getEndscreen: youtube.getEndscreen,
  getChannel: youtube.getChannelWithCache,
  getChannelVideos: youtube.getChannelVideosWithCache,
  getChannelPlaylists: youtube.getChannelPlaylistsWithCache,
  getPlaylist: youtube.getPlaylistWithCache,
} as const satisfies ProviderAdapter;

const providers: Record<ProviderId, ProviderAdapter> = {
  youtube: youtubeProvider,
};

export const providerDescriptors: readonly ProviderDescriptor[] = Object.values(providers)
  .map((provider) => provider.descriptor);

export function getProvider(value: string): ProviderAdapter {
  if (!isProviderId(value)) {
    throw new ApiError(
      422,
      'PROVIDER_NOT_SUPPORTED',
      `The provider "${value}" is not supported. Supported providers: ${PROVIDER_IDS.join(', ')}.`,
    );
  }
  return providers[value];
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
