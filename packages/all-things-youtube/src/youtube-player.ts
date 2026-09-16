type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

export interface ClientProfile {
  name: string;
  clientName: string;
  clientVersion: string;
  clientNameHeader: string;
  userAgent: string;
  context: JsonObject;
}

export const WEB_PROFILE: ClientProfile = {
  name: 'web',
  clientName: 'WEB',
  clientVersion: '2.20260730.00.00',
  clientNameHeader: '1',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  context: { platform: 'DESKTOP', osName: 'Macintosh', osVersion: '10_15_7' },
};

export const PLAYER_PROFILES: ClientProfile[] = [
  {
    name: 'ios',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    clientNameHeader: '5',
    userAgent:
      'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      platform: 'MOBILE',
      osName: 'iOS',
      osVersion: '18.3.2.22D82',
    },
  },
  {
    name: 'android_vr',
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.20',
    clientNameHeader: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.62.20 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      platform: 'MOBILE',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
    },
  },
  {
    name: 'mweb',
    clientName: 'MWEB',
    clientVersion: '2.20251209.01.00',
    clientNameHeader: '2',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    context: { platform: 'MOBILE', osName: 'iOS', osVersion: '17.5.1' },
  },
];

function extractAssignedJson(html: string, markers: string[]): JsonObject | undefined {
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = html.indexOf('{', markerIndex + marker.length);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const character = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        try {
          return object(JSON.parse(html.slice(start, index + 1)));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

export function extractInitialPlayerResponse(html: string): JsonObject | undefined {
  return extractAssignedJson(html, ['var ytInitialPlayerResponse =', 'ytInitialPlayerResponse =']);
}

export function extractInitialData(html: string): JsonObject | undefined {
  return extractAssignedJson(html, ['var ytInitialData =', 'ytInitialData =']);
}
