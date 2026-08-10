import { createRequire } from 'node:module';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const require = createRequire(import.meta.url);
const youtube = require('all-things-youtube');
const { createYouTubeClient } = require('./node_modules/all-things-youtube/dist/youtube-client.js');

function outboundFetch(proxyUrl) {
  if (!proxyUrl) return globalThis.fetch.bind(globalThis);
  const dispatcher = new ProxyAgent(proxyUrl);
  return (input, init = {}) => undiciFetch(input, { ...init, dispatcher });
}

export function redactProxyError(error, proxyUrl) {
  if (!proxyUrl || !(error instanceof Error)) return error;
  const message = error.message
    .replaceAll(proxyUrl, '[configured proxy]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@');
  if (message === error.message) return error;
  return Object.assign(new Error(message), {
    code: error.code,
    status: error.status,
    retryable: error.retryable,
  });
}

export function createYouTubeRuntime(environment = process.env) {
  const proxyUrl = environment.OUTBOUND_PROXY_URL?.trim() ?? '';
  const fetchImpl = outboundFetch(proxyUrl);
  const retry = {
    onRetry: (event) => console.warn(JSON.stringify({ event: 'youtube_retry', ...event })),
  };
  const client = createYouTubeClient({ fetch: fetchImpl, retry });
  const options = { fetch: fetchImpl, retry };

  return {
    proxyConfigured: proxyUrl.length > 0,
    async run(operation) {
      try {
        switch (operation.kind) {
          case 'search':
            return client.search(operation.query, operation.filters ?? {});
          case 'browse':
            return client.browse(operation.options ?? {});
          case 'video':
            return youtube.getDetails({ ...options, videoId: operation.id });
          case 'video-signals':
            return client.getVideoSignals(operation.id);
          case 'channel':
            return youtube.getChannelInfo({ ...options, channelId: operation.id });
          case 'channel-videos':
            return youtube.getChannelVideos({
              ...options,
              channelId: operation.id,
              continuation: operation.continuation,
              sort: operation.sort,
            });
          case 'channel-playlists':
            return youtube.getChannelPlaylists({
              ...options,
              channelId: operation.id,
              continuation: operation.continuation,
              sort: operation.sort,
            });
          case 'playlist':
            return youtube.getPlaylist({ ...options, playlistId: operation.id });
          case 'comments':
            return youtube.getComments({
              ...options,
              videoId: operation.id,
              continuation: operation.continuation,
            });
          case 'all-comments':
            return youtube.getComments({
              ...options,
              videoId: operation.id,
              all: true,
              maxPages: operation.maxPages,
            });
          case 'caption-tracks':
            return youtube.getTracks({ ...options, videoId: operation.id });
          case 'transcript':
            return youtube.getTranscript({
              ...options,
              videoId: operation.id,
              lang: operation.lang,
              granularity: operation.granularity,
            });
          case 'endscreen':
            return youtube.getEndscreen({ ...options, videoId: operation.id });
          default:
            throw Object.assign(new Error('The YouTube operation is not supported.'), {
              code: 'INVALID_INPUT',
              retryable: false,
            });
        }
      } catch (error) {
        throw redactProxyError(error, proxyUrl);
      }
    },
  };
}
