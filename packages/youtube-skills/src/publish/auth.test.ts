import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { AuthError, UPLOAD_SCOPE, getAccessToken, parseClientSecret, tokenPath } from './auth';

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });
const client = { clientId: 'client.apps.googleusercontent.com', clientSecret: 'shh' };

function tokenServer(responses: Array<Record<string, unknown>>) {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    const body = responses.shift() ?? { error: 'unexpected' };
    return new Response(JSON.stringify(body), { status: body.error ? 400 : 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('parseClientSecret', () => {
  test('accepts a Desktop app client and rejects others', () => {
    expect(parseClientSecret({ installed: { client_id: 'a', client_secret: 'b' } })).toEqual({ clientId: 'a', clientSecret: 'b' });
    expect(() => parseClientSecret({ web: { client_id: 'a' } })).toThrow(AuthError);
  });

  test('keeps one token file per client under the user config directory', () => {
    expect(tokenPath(client, { HOME: '/home/u' })).toMatch(/^\/home\/u\/\.config\/youtube-shorts-publish\/token-[0-9a-f]{12}\.json$/);
  });
});

describe('getAccessToken', () => {
  test('runs loopback consent with PKCE for upload access only, then saves the refresh token privately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publish-auth-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'token.json');
    const { calls, fetchImpl } = tokenServer([{ access_token: 'access-1', refresh_token: 'refresh-1', scope: UPLOAD_SCOPE }]);
    let consentUrl: URL | undefined;
    const token = await getAccessToken(client, path, {
      fetch: fetchImpl,
      openUrl: (url) => {
        consentUrl = new URL(url);
        const redirect = new URL(consentUrl.searchParams.get('redirect_uri')!);
        redirect.search = new URLSearchParams({ code: 'the-code', state: consentUrl.searchParams.get('state')! }).toString();
        void fetch(redirect);
      },
    });
    expect(token).toBe('access-1');
    expect(consentUrl!.searchParams.get('scope')).toBe(UPLOAD_SCOPE);
    expect(consentUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consentUrl!.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(calls[0]!.get('grant_type')).toBe('authorization_code');
    expect(calls[0]!.get('code_verifier')).toBeTruthy();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ refresh_token: 'refresh-1', scope: UPLOAD_SCOPE });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('refreshes silently with a saved token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publish-auth-'));
    directories.push(directory);
    const path = join(directory, 'token.json');
    await writeFile(path, JSON.stringify({ refresh_token: 'refresh-1' }));
    const { calls, fetchImpl } = tokenServer([{ access_token: 'access-2' }]);
    const token = await getAccessToken(client, path, { fetch: fetchImpl, openUrl: () => { throw new Error('should not open'); } });
    expect(token).toBe('access-2');
    expect(calls[0]!.get('grant_type')).toBe('refresh_token');
  });
});
