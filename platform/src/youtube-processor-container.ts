import { Container } from '@cloudflare/containers';

export class YouTubeProcessorContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true;
  envVars = {
    NODE_ENV: 'production',
    OUTBOUND_PROXY_URLS: this.env.OUTBOUND_PROXY_URLS?.trim() ?? '',
    OUTBOUND_PROXY_URL: this.env.OUTBOUND_PROXY_URL?.trim() ?? '',
    MAX_CONCURRENT_OPERATIONS: this.env.YOUTUBE_PROCESSOR_MAX_CONCURRENCY?.trim() ?? '4',
  };

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('x-processor-egress') === 'direct') {
      // Read local runtime state, without an extra RPC or waking another slot.
      console.info(JSON.stringify({ event: 'youtube_direct_container_state',
        containerId: this.ctx.id.toString(), extractionId: request.headers.get('x-extraction-id'),
        coldStart: !this.ctx.container?.running, sleepAfter: this.sleepAfter }));
    }
    return super.fetch(request);
  }

  override onStart(): void {
    console.info(JSON.stringify({ event: 'youtube_processor_started', containerId: this.ctx.id.toString(),
      version: this.env.YOUTUBE_PROCESSOR_VERSION, sleepAfter: this.sleepAfter }));
  }
}
