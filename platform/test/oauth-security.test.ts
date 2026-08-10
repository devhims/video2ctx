import { encryptSecret } from '../src/lib/crypto';
import { disconnectYoutube } from '../src/lib/oauth';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function oauthEnv(encryptedToken: string): Env {
  return {
    YOUTUBE_OAUTH_ENCRYPTION_KEY: encryptionKey,
    DB: {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => query.includes('SELECT encrypted_refresh_token')
            ? { encrypted_refresh_token: encryptedToken }
            : null),
          run: vi.fn(async () => ({ success: true })),
        })),
      })),
    },
  } as unknown as Env;
}

describe('YouTube OAuth secret handling', () => {
  afterEach(() => vi.restoreAllMocks());

  test('sends the decrypted token in the revocation body instead of the URL', async () => {
    const token = 'refresh-token-that-must-stay-secret';
    const encrypted = await encryptSecret(token, encryptionKey);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await disconnectYoutube(oauthEnv(encrypted), 'user-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const url = firstCall?.[0];
    const init = firstCall?.[1];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(url)).not.toContain(token);
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect((init?.body as URLSearchParams).get('token')).toBe(token);
  });

  test('does not log a token when revocation fails', async () => {
    const token = 'refresh-token-that-must-stay-secret';
    const encrypted = await encryptSecret(token, encryptionKey);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`request failed for https://oauth2.googleapis.com/revoke?token=${token}`);
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await disconnectYoutube(oauthEnv(encrypted), 'user-1');

    const serializedLog = JSON.stringify(warning.mock.calls);
    expect(serializedLog).not.toContain(token);
    expect(serializedLog).not.toContain('oauth2.googleapis.com');
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: 'youtube_oauth_revoke_failed',
      errorName: 'Error',
    }));
  });
});
