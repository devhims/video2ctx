import { Redis } from '@upstash/redis/cloudflare';
import { ApiError } from './http';

export const LANDING_DEMO_LIMIT = 5;
export const LANDING_DEMO_WINDOW_MS = 24 * 60 * 60_000;

const DISTINCT_VIDEO_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local video = ARGV[3]
local limit = tonumber(ARGV[4])
local window = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

local existing = redis.call('ZSCORE', key, video)
local count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')

if existing then
  local reset = now + window
  if #oldest > 0 then reset = tonumber(oldest[2]) + window end
  redis.call('PEXPIRE', key, window)
  return {1, limit - count, reset, 1}
end

if count >= limit then
  local reset = now + window
  if #oldest > 0 then reset = tonumber(oldest[2]) + window end
  return {0, 0, reset, 0}
end

redis.call('ZADD', key, now, video)
redis.call('PEXPIRE', key, window)
count = count + 1
oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local reset = now + window
if #oldest > 0 then reset = tonumber(oldest[2]) + window end
return {1, limit - count, reset, 0}
`;

interface RedisEval {
  eval<TArgs extends unknown[], TData = unknown>(
    script: string,
    keys: string[],
    args: TArgs,
  ): Promise<TData>;
}

export interface LandingDemoQuota {
  limit: number;
  remaining: number;
  resetAt: string;
  repeated: boolean;
}

export async function claimLandingDemoQuota(
  env: Env,
  request: Request,
  videoId: string,
  timestamp = Date.now(),
): Promise<LandingDemoQuota> {
  // Wrangler narrows production vars to their configured literal values, while
  // local development may still override this switch at runtime.
  if (String(env.LANDING_DEMO_RATE_LIMIT_MODE) === 'disabled') {
    return unmeteredQuota(timestamp);
  }

  const configured = Boolean(
    env.UPSTASH_REDIS_REST_URL
    && env.UPSTASH_REDIS_REST_TOKEN
    && env.LANDING_RATE_LIMIT_SALT,
  );

  if (!configured) {
    if (env.ENVIRONMENT !== 'production') {
      return unmeteredQuota(timestamp);
    }
    throw unavailable();
  }

  const ip = clientIp(request, env.ENVIRONMENT);
  if (!ip) throw unavailable();

  const redisUrl = env.UPSTASH_REDIS_REST_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN;
  const salt = env.LANDING_RATE_LIMIT_SALT;
  if (!redisUrl || !redisToken || !salt) throw unavailable();

  const identity = await hmacHex(salt, ip);
  const redis = new Redis({
    url: redisUrl,
    token: redisToken,
  });

  let quota: LandingDemoQuota;
  try {
    quota = await evaluateDistinctVideoLimit(redis, identity, videoId, timestamp);
  } catch (error) {
    console.error({
      event: 'landing_demo_rate_limit_error',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw unavailable();
  }

  if (quota.remaining < 0 || quota.remaining > LANDING_DEMO_LIMIT) throw unavailable();
  return quota;
}

function unmeteredQuota(timestamp: number): LandingDemoQuota {
  return {
    limit: LANDING_DEMO_LIMIT,
    remaining: LANDING_DEMO_LIMIT,
    resetAt: new Date(timestamp + LANDING_DEMO_WINDOW_MS).toISOString(),
    repeated: false,
  };
}

export async function evaluateDistinctVideoLimit(
  redis: RedisEval,
  identity: string,
  videoId: string,
  timestamp: number,
): Promise<LandingDemoQuota> {
  const raw = await redis.eval<[number, number, string, number, number], unknown>(
    DISTINCT_VIDEO_LIMIT_SCRIPT,
    [`video2ctx:landing:videos:${identity}`],
    [
      timestamp,
      timestamp - LANDING_DEMO_WINDOW_MS,
      videoId,
      LANDING_DEMO_LIMIT,
      LANDING_DEMO_WINDOW_MS,
    ],
  );

  if (!Array.isArray(raw) || raw.length !== 4) throw new Error('Invalid Redis quota response.');
  const allowedValue = Number(raw[0]);
  const remainingValue = Number(raw[1]);
  const resetValue = Number(raw[2]);
  const repeatedValue = Number(raw[3]);
  if (![allowedValue, remainingValue, resetValue, repeatedValue].every(Number.isFinite)) {
    throw new Error('Invalid Redis quota response.');
  }

  const quota = {
    limit: LANDING_DEMO_LIMIT,
    remaining: remainingValue,
    resetAt: new Date(resetValue).toISOString(),
    repeated: repeatedValue === 1,
  };
  if (allowedValue !== 1) {
    throw new ApiError(
      429,
      'LANDING_DEMO_LIMIT_REACHED',
      'You have inspected five distinct videos in the last 24 hours. Try again after your oldest inspection expires.',
      quota,
    );
  }
  return quota;
}

function clientIp(request: Request, environment: string): string {
  const cloudflareIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cloudflareIp) return cloudflareIp;
  if (environment === 'production') return '';
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    'DEMO_RATE_LIMIT_UNAVAILABLE',
    'The free inspection is temporarily unavailable. Please try again shortly.',
  );
}
