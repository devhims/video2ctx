// Bundle shared source so a platform deployment does not require an npm release.
// The same client is exposed to external consumers as all-things-youtube/client.
import { createYouTubeClient } from '../../../packages/all-things-youtube/src/client';
import * as youtube from '../../../packages/all-things-youtube/src/index';
import type { YouTubeOperation, YouTubeOperationResult } from './youtube-processor-client';

export type WorkerYouTubeOperation = Exclude<YouTubeOperation, { kind: 'storyboard' }>;
export type WorkerYouTubeResult = YouTubeOperationResult<WorkerYouTubeOperation>;

/** Transport selection and retry belong to the runner; an attempt has one route. */
export async function executeWorkerYouTubeOperation(operation: WorkerYouTubeOperation, fetchImpl: typeof fetch): Promise<WorkerYouTubeResult> {
  // Avoid multiplying library retries by operation retries. Fresh metadata is
  // retrieved on every operation retry, including malformed-caption recovery.
  const options = { fetch: fetchImpl, retry: { policy: { maxAttempts: 1 } } };
  const client = createYouTubeClient(options);
  switch (operation.kind) {
    case 'search': return client.search(operation.query, operation.filters ?? {});
    case 'browse': return client.browse(operation.options ?? {});
    case 'video': return youtube.getDetails({ ...options, videoId: operation.id });
    case 'video-signals': return client.getVideoSignals(operation.id);
    case 'channel': return youtube.getChannelInfo({ ...options, channelId: operation.id });
    case 'channel-videos': return youtube.getChannelVideos({ ...options, channelId: operation.id, continuation: operation.continuation, sort: operation.sort });
    case 'channel-playlists': return youtube.getChannelPlaylists({ ...options, channelId: operation.id, continuation: operation.continuation, sort: operation.sort });
    case 'playlist': return youtube.getPlaylist({ ...options, playlistId: operation.id });
    case 'comments': return youtube.getComments({ ...options, videoId: operation.id, continuation: operation.continuation });
    case 'all-comments': return youtube.getComments({ ...options, videoId: operation.id, all: true, maxPages: operation.maxPages });
    case 'caption-tracks': return youtube.getTracks({ ...options, videoId: operation.id });
    case 'transcript': return youtube.getTranscript({ ...options, videoId: operation.id, lang: operation.lang, granularity: operation.granularity });
    case 'endscreen': return youtube.getEndscreen({ ...options, videoId: operation.id });
  }
}
