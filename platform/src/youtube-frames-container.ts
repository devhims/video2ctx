import { Container } from '@cloudflare/containers';

export class YouTubeFramesContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';
  enableInternet = true;
  envVars = {
    NODE_ENV: 'production',
    OUTBOUND_PROXY_URL: this.env.OUTBOUND_PROXY_URL?.trim() ?? '',
  };
}
