import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Only upload access: no reading, editing, or deleting the channel's other videos. */
export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CONSENT_TIMEOUT_MS = 5 * 60_000;

export class AuthError extends Error {
  readonly code = 'AUTH_REQUIRED';
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Read the "Desktop app" OAuth client JSON downloaded from Google Cloud Console. */
export function parseClientSecret(value: unknown): OAuthClient {
  const installed = (value as { installed?: { client_id?: unknown; client_secret?: unknown } })?.installed;
  if (!installed || typeof installed.client_id !== 'string' || typeof installed.client_secret !== 'string') {
    throw new AuthError('The OAuth client file must be a "Desktop app" client JSON from Google Cloud Console (it has an "installed" section).');
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

/** Where the refresh token lives: one file per OAuth client, readable only by the user. */
export function tokenPath(client: OAuthClient, environment: NodeJS.ProcessEnv = process.env): string {
  const base = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), '.config');
  const id = createHash('sha256').update(client.clientId).digest('hex').slice(0, 12);
  return join(base, 'youtube-shorts-publish', `token-${id}.json`);
}

interface StoredToken {
  refresh_token: string;
  scope?: string;
}

export interface AuthDependencies {
  fetch?: typeof fetch;
  /** Opens the consent URL; defaults to the system browser. */
  openUrl?: (url: string) => void;
  /** Told the consent URL in case the browser does not open. */
  notify?: (message: string) => void;
}

function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

async function exchange(fetchImpl: typeof fetch, body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; scope?: string }> {
  const response = await fetchImpl(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!response.ok || !json.access_token) {
    throw new AuthError(`Google refused the token request: ${json.error ?? response.status}${json.error_description ? ` (${json.error_description})` : ''}.`);
  }
  return json as { access_token: string; refresh_token?: string; scope?: string };
}

/** Run the loopback consent flow with PKCE and return a refresh token. */
async function consent(client: OAuthClient, fetchImpl: typeof fetch, dependencies: AuthDependencies): Promise<{ stored: StoredToken; accessToken: string }> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AuthError('Timed out waiting for YouTube consent in the browser.')), CONSENT_TIMEOUT_MS);
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        const error = url.searchParams.get('error');
        const returned = url.searchParams.get('code');
        if (url.searchParams.get('state') !== state || (!returned && !error)) {
          response.writeHead(400).end('Unexpected request.');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          .end(error ? 'Access was not granted. You can close this tab.' : 'Upload access granted. You can close this tab.');
        clearTimeout(timer);
        if (error) reject(new AuthError(`Consent was not granted: ${error}.`));
        else resolve(returned!);
      });
      const url = new URL(AUTH_URI);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: UPLOAD_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      dependencies.notify?.(`Grant upload access in your browser. If it did not open, visit:\n${url.toString()}\n`);
      (dependencies.openUrl ?? openInBrowser)(url.toString());
    });
    const tokens = await exchange(fetchImpl, {
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (!tokens.refresh_token) throw new AuthError('Google did not return a refresh token; remove the app under myaccount.google.com/permissions and try again.');
    return { stored: { refresh_token: tokens.refresh_token, scope: tokens.scope }, accessToken: tokens.access_token };
  } finally {
    server.close();
  }
}

/**
 * An access token for uploads. Reuses the saved refresh token; otherwise asks the user to consent
 * in their browser once and saves the new refresh token (mode 600). Tokens are never printed.
 */
export async function getAccessToken(client: OAuthClient, path: string, dependencies: AuthDependencies = {}): Promise<string> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const saved = await readFile(path, 'utf8').then((text) => JSON.parse(text) as StoredToken).catch(() => undefined);
  if (saved?.refresh_token) {
    try {
      const tokens = await exchange(fetchImpl, {
        refresh_token: saved.refresh_token,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token',
      });
      return tokens.access_token;
    } catch (error) {
      if (!(error instanceof AuthError) || !/invalid_grant/.test(error.message)) throw error;
      // The grant was revoked or expired; fall through to consent again.
    }
  }
  const { stored, accessToken } = await consent(client, fetchImpl, dependencies);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return accessToken;
}
