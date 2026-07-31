import { decryptSecret, encryptSecret } from './crypto';
import { ApiError, base64Url, now, randomToken, sha256 } from './http';

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

export async function youtubeConnectUrl(env: Env, userId: string): Promise<string> {
  const state = randomToken(32);
  const verifier = randomToken(64);
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  await env.DB.prepare('INSERT INTO oauth_states (state_hash,user_id,code_verifier,expires_at) VALUES (?,?,?,?)')
    .bind(await sha256(state), userId, verifier, now() + 10 * 60_000).run();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${env.APP_ORIGIN}/api/platform/v1/oauth/youtube/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', base64Url(new Uint8Array(challengeBytes)));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function youtubeOAuthCallback(env: Env, code: string, state: string): Promise<string> {
  const stored = await env.DB.prepare('SELECT user_id,code_verifier,expires_at FROM oauth_states WHERE state_hash=?')
    .bind(await sha256(state)).first<{ user_id: string; code_verifier: string; expires_at: number }>();
  if (!stored || stored.expires_at < now()) throw new ApiError(401, 'OAUTH_STATE_INVALID', 'OAuth state is invalid or expired.');
  await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=?').bind(await sha256(state)).run();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      code, code_verifier: stored.code_verifier,
      grant_type: 'authorization_code', redirect_uri: `${env.APP_ORIGIN}/api/platform/v1/oauth/youtube/callback`,
    }),
  });
  const tokens = await response.json<{ refresh_token?: string; scope?: string; expires_in?: number; error?: string }>();
  if (!response.ok || !tokens.refresh_token) throw new ApiError(502, 'OAUTH_EXCHANGE_FAILED', tokens.error ?? 'Google did not return a refresh token.');
  const encrypted = await encryptSecret(tokens.refresh_token, env.YOUTUBE_OAUTH_ENCRYPTION_KEY);
  await env.DB.prepare(
    `INSERT INTO oauth_connections
     (user_id,provider,encrypted_refresh_token,scopes,expires_at,connected_at,updated_at)
     VALUES (?,'youtube',?,?,?,?,?)
     ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token,
       scopes=excluded.scopes,expires_at=excluded.expires_at,updated_at=excluded.updated_at`
  ).bind(stored.user_id, encrypted, tokens.scope ?? SCOPE, now() + (tokens.expires_in ?? 3600) * 1000, now(), now()).run();
  return stored.user_id;
}

export async function disconnectYoutube(env: Env, userId: string): Promise<void> {
  const connection = await env.DB.prepare(
    `SELECT encrypted_refresh_token FROM oauth_connections WHERE user_id=? AND provider='youtube'`
  ).bind(userId).first<{ encrypted_refresh_token: string }>();
  if (connection) {
    try {
      const token = await decryptSecret(connection.encrypted_refresh_token, env.YOUTUBE_OAUTH_ENCRYPTION_KEY);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    } catch (error) {
      console.warn('youtube_oauth_revoke_failed', { userId, error });
    }
  }
  await env.DB.prepare(`DELETE FROM oauth_connections WHERE user_id=? AND provider='youtube'`).bind(userId).run();
}
