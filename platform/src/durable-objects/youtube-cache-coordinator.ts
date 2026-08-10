import { DurableObject } from 'cloudflare:workers';
import {
  YouTubeCacheCoordinatorCore,
  type YouTubeCacheRequest,
} from '../lib/youtube-cache-coordinator';

export class YouTubeRequestCoordinator extends DurableObject<Env> {
  private readonly coordinator: YouTubeCacheCoordinatorCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new YouTubeCacheCoordinatorCore(this.env);
  }

  async getOrLoad(requestJson: string): Promise<string> {
    const request = parseRequest(requestJson);
    return JSON.stringify(await this.coordinator.getOrLoad(request));
  }
}

function parseRequest(value: string): YouTubeCacheRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('The YouTube cache request must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('The YouTube cache request must be an object.');
  }
  const request = parsed as Partial<YouTubeCacheRequest>;
  if (
    typeof request.cacheKey !== 'string'
    || typeof request.resourceType !== 'string'
    || typeof request.maxAgeMs !== 'number'
    || !request.operation
    || typeof request.operation !== 'object'
  ) {
    throw new TypeError('The YouTube cache request is invalid.');
  }
  return request as YouTubeCacheRequest;
}
