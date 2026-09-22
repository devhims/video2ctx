import { loadStoryboard } from './storyboard.mjs';
import { getStoryboardWithFallback } from './storyboard-extractor.mjs';
import { storyboardImageFetch } from './storyboard-images.mjs';
import { randomUUID } from 'node:crypto';
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
    async run(operation, diagnostics = {}) {
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
          case 'transcript': {
            const startedAt = Date.now();
            const record = event => {
              try { diagnostics.onDiagnostic?.({ ...event, elapsedMs: Date.now() - startedAt }); } catch { /* Best effort. */ }
            };
            const safeCode = error => ['INVALID_INPUT', 'INVALID_RESPONSE', 'NOT_FOUND', 'UNAVAILABLE', 'UPSTREAM_ERROR', 'RATE_LIMITED', 'AUTH_REQUIRED'].includes(error?.code) ? error.code : 'UNKNOWN';
            try {
              const value = await youtube.getTranscript({
                ...options, videoId: operation.id, lang: operation.lang, granularity: operation.granularity,
                retry: { onRetry: event => {
                  retry.onRetry(event);
                  record({ stage: event.reason === 'preparation' ? 'caption_metadata' : 'caption_retry',
                    outcome: 'error', attempt: event.attempt, status: event.status,
                    delayMs: event.delayMs, ...(event.code ? { code: safeCode(event) } : {}) });
                } },
              });
              record({ stage: 'complete', outcome: 'success' });
              return value;
            } catch (error) {
              record({ stage: 'request', outcome: 'error', code: safeCode(error) });
              throw error;
            }
          }
          case 'storyboard': {
            const storyboardId = diagnostics.extractionId ?? randomUUID();
            const onDiagnostic = event => {
              try { diagnostics.onDiagnostic?.(event); } catch { /* Capture cannot affect extraction. */ }
              try { console.info(JSON.stringify({ event: 'youtube_storyboard_diagnostic', storyboardId, videoId: typeof operation.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(operation.id) ? operation.id : undefined, ...event })); }
              catch { /* Observability must not change the operation result. */ }
            };
            const startedAt = Date.now();
            try {
              return await loadStoryboard(operation.id, getStoryboardWithFallback, { ...options,
                fetch: storyboardImageFetch(fetchImpl, onDiagnostic), onDiagnostic,
                timestampsMs: operation.timestampsMs, maxSheets: operation.maxSheets,
                sheetIndexes: operation.sheetIndexes, metadataOnly: operation.metadataOnly });
            } catch (error) {
              const code = ['INVALID_INPUT', 'INVALID_RESPONSE', 'NOT_FOUND', 'UNAVAILABLE', 'UPSTREAM_ERROR'].includes(error?.code)
                ? error.code : 'UNKNOWN';
              onDiagnostic({ stage: 'request', outcome: 'error', code, elapsedMs: Date.now() - startedAt });
              throw error;
            }
          }
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
