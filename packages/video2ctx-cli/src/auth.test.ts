import { describe, expect, test } from 'vitest';
import {
  authenticateDevice,
  resolveCredential,
  type CredentialStore,
  type DeviceAuthDependencies,
  type StoredProfile,
} from './auth';

class MemoryCredentialStore implements CredentialStore {
  profile: StoredProfile | null = null;

  async read(): Promise<StoredProfile | null> {
    return this.profile;
  }

  async write(profile: StoredProfile): Promise<void> {
    this.profile = profile;
  }

  async delete(): Promise<void> {
    this.profile = null;
  }
}

describe('credential resolution', () => {
  test('prefers an explicit credential, then the environment key, then the CLI profile', async () => {
    const profile: StoredProfile = {
      version: 1,
      baseUrl: 'https://profile.example',
      token: 'profile-session',
      createdAt: '2026-08-15T00:00:00.000Z',
    };

    expect(resolveCredential({
      explicitCredential: 'aty_explicit',
      environmentApiKey: 'aty_environment',
      profile,
    })).toMatchObject({ value: 'aty_explicit', source: 'explicit', kind: 'api-key' });

    expect(resolveCredential({
      environmentApiKey: 'aty_environment',
      profile,
    })).toMatchObject({ value: 'aty_environment', source: 'environment', kind: 'api-key' });

    expect(resolveCredential({ profile })).toMatchObject({
      value: 'profile-session',
      source: 'profile',
      kind: 'cli-session',
    });
  });
});

describe('device authentication polling', () => {
  test('handles pending and slow_down before storing an approved session', async () => {
    const store = new MemoryCredentialStore();
    const responses = [
      jsonResponse({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://video2ctx.dev/device',
        verification_uri_complete: 'https://video2ctx.dev/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      }),
      jsonResponse({ error: 'authorization_pending', error_description: 'Pending' }, 400),
      jsonResponse({ error: 'slow_down', error_description: 'Slow down' }, 400),
      jsonResponse({
        access_token: 'approved-session-token',
        token_type: 'Bearer',
        expires_in: 604800,
        scope: 'data:read account:access',
      }),
    ];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sleeps: number[] = [];
    const opened: string[] = [];
    let currentTime = 0;
    const dependencies: DeviceAuthDependencies = {
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected request');
        return response;
      },
      store,
      openBrowser: async (url) => { opened.push(url); },
      now: () => currentTime,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
    };

    const result = await authenticateDevice({
      baseUrl: 'https://api.video2ctx.dev',
      noBrowser: false,
    }, dependencies);

    expect(result).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://video2ctx.dev/device',
      verificationUriComplete: 'https://video2ctx.dev/device?user_code=ABCD-EFGH',
    });
    expect(opened).toEqual(['https://video2ctx.dev/device?user_code=ABCD-EFGH']);
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(store.profile).toMatchObject({
      version: 1,
      baseUrl: 'https://api.video2ctx.dev',
      token: 'approved-session-token',
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.init?.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('approved-session-token');
  });

  test.each([
    ['access_denied', 'Device authorization was denied.'],
    ['expired_token', 'The device authorization code expired.'],
  ])('classifies %s without storing a credential', async (error, message) => {
    const store = new MemoryCredentialStore();
    const responses = [
      jsonResponse({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://video2ctx.dev/device',
        verification_uri_complete: 'https://video2ctx.dev/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 1,
      }),
      jsonResponse({ error, error_description: message }, 400),
    ];

    await expect(authenticateDevice({
      baseUrl: 'https://api.video2ctx.dev',
      noBrowser: true,
    }, {
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
      store,
      openBrowser: async () => undefined,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(message);
    expect(store.profile).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
