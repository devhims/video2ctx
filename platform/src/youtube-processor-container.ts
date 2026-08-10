import { Container } from '@cloudflare/containers';

export class YouTubeProcessorContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true;
  envVars = {
    NODE_ENV: 'production',
    OUTBOUND_PROXY_URL: this.env.OUTBOUND_PROXY_URL?.trim() ?? '',
    MAX_CONCURRENT_OPERATIONS: this.env.YOUTUBE_PROCESSOR_MAX_CONCURRENCY?.trim() ?? '4',
  };
}
