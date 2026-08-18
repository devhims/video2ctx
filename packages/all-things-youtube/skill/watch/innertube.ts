import { createYouTubeTransport } from '../../src/youtube-transport';
import { YouTubeClientError, type YouTubeClientOptions } from '../../src/youtube-types';

export type JsonObject = Record<string, unknown>;

interface WatchProfile {
  name: 'ios' | 'android' | 'android_vr' | 'mweb';
  clientName: string;
  clientVersion: string;
  clientNameHeader: string;
  userAgent: string;
  context: JsonObject;
}

const IOS_PROFILE: WatchProfile = {
  name: 'ios',
  clientName: 'IOS',
  clientVersion: '20.10.4',
  clientNameHeader: '5',
  userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  context: {
    deviceMake: 'Apple', deviceModel: 'iPhone16,2', platform: 'MOBILE',
    osName: 'iOS', osVersion: '18.3.2.22D82',
  },
};

export const WATCH_MEDIA_PROFILES: readonly WatchProfile[] = [
  IOS_PROFILE,
  {
    name: 'android',
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    clientNameHeader: '3',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    context: { platform: 'MOBILE', osName: 'Android', osVersion: '14', androidSdkVersion: 34 },
  },
  {
    name: 'android_vr',
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.20',
    clientNameHeader: '28',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.62.20 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      deviceMake: 'Oculus', deviceModel: 'Quest 3', platform: 'MOBILE',
      osName: 'Android', osVersion: '12L', androidSdkVersion: 32,
    },
  },
  {
    name: 'mweb',
    clientName: 'MWEB',
    clientVersion: '2.20251209.01.00',
    clientNameHeader: '2',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    context: { platform: 'MOBILE', osName: 'iOS', osVersion: '17.5.1' },
  },
];

const API_ROOT = 'https://youtubei.googleapis.com/youtubei/v1';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export interface WatchPlayerResponse {
  profile: WatchProfile['name'];
  raw: JsonObject;
}

export async function callWatchPlayer(
  videoId: string,
  profile: WatchProfile,
  options: YouTubeClientOptions,
): Promise<WatchPlayerResponse> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new YouTubeClientError('INVALID_INPUT', 'A fetch implementation is required.');
  const transport = createYouTubeTransport({ fetch: fetchImpl, ...options.retry });
  const response = await transport.fetch(`youtube:watch-player:${profile.name}`, () => ({
    input: `${API_ROOT}/player?prettyPrint=false`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': profile.userAgent,
        'X-YouTube-Client-Name': profile.clientNameHeader,
        'X-YouTube-Client-Version': profile.clientVersion,
        Origin: 'https://www.youtube.com',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: profile.clientName,
            clientVersion: profile.clientVersion,
            hl: options.language ?? 'en',
            gl: options.region ?? 'US',
            ...profile.context,
          },
          user: { lockedSafetyMode: false },
          request: { useSsl: true },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    },
  }));
  if (!response.ok) {
    throw new YouTubeClientError(
      response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      `YouTube player request failed with status ${response.status}.`,
      { status: response.status, retryable: response.status === 429 || response.status >= 500 },
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned invalid player JSON.', {
      cause, retryable: true,
    });
  }
  const normalized = object(raw);
  const playability = String(object(normalized.playabilityStatus).status ?? 'UNKNOWN');
  if (playability !== 'OK') {
    const reason = object(normalized.playabilityStatus).reason;
    throw new YouTubeClientError(
      playability === 'LOGIN_REQUIRED' ? 'AUTH_REQUIRED' : 'UNAVAILABLE',
      typeof reason === 'string' ? reason : `Video is not playable through ${profile.name}.`,
      { retryable: playability === 'LOGIN_REQUIRED' },
    );
  }
  return { profile: profile.name, raw: normalized };
}

export function callIosWatchPlayer(
  videoId: string,
  options: YouTubeClientOptions,
): Promise<WatchPlayerResponse> {
  return callWatchPlayer(videoId, IOS_PROFILE, options);
}
