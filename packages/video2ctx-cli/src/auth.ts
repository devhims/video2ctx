export const DEVICE_AUTH_CLIENT_ID = 'video2ctx-cli';
export const DEVICE_AUTH_SCOPE = 'data:read account:access';
const AUTH_REQUEST_TIMEOUT_MS = 30_000;

export type StoredProfile = {
  version: 1;
  baseUrl: string;
  token: string;
  createdAt: string;
};

export interface CredentialStore {
  read(): Promise<StoredProfile | null>;
  write(profile: StoredProfile): Promise<void>;
  delete(): Promise<void>;
}

export type ResolvedCredential = {
  value: string;
  kind: 'api-key' | 'cli-session';
  source: 'explicit' | 'environment' | 'profile';
  baseUrl?: string;
};

export type DeviceAuthDependencies = {
  fetch: typeof fetch;
  store: CredentialStore;
  openBrowser(url: string): Promise<void>;
  onVerification?(details: DeviceAuthResult): void | Promise<void>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export type DeviceAuthResult = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type DeviceTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

export function resolveCredential(options: {
  explicitCredential?: string;
  environmentApiKey?: string;
  profile?: StoredProfile | null;
}): ResolvedCredential | null {
  const explicit = cleanCredential(options.explicitCredential);
  if (explicit) return resolved(explicit, 'explicit');

  const environment = cleanCredential(options.environmentApiKey);
  if (environment) return resolved(environment, 'environment');

  const profile = options.profile;
  const profileCredential = cleanCredential(profile?.token);
  return profileCredential
    ? { ...resolved(profileCredential, 'profile'), baseUrl: profile?.baseUrl }
    : null;
}

export async function authenticateDevice(
  options: { baseUrl: string; noBrowser: boolean },
  dependencies: DeviceAuthDependencies,
): Promise<DeviceAuthResult> {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const codeResponse = await dependencies.fetch(new URL('/api/auth/device/code', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: DEVICE_AUTH_CLIENT_ID, scope: DEVICE_AUTH_SCOPE }),
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  });
  const codePayload = await readJson(codeResponse);
  if (!codeResponse.ok || !isDeviceCodeResponse(codePayload)) {
    throw new Error(apiMessage(codePayload, 'Could not start device authorization.'));
  }

  const verification: DeviceAuthResult = {
    userCode: codePayload.user_code,
    verificationUri: codePayload.verification_uri,
    verificationUriComplete: codePayload.verification_uri_complete,
  };
  await dependencies.onVerification?.(verification);
  if (!options.noBrowser) await dependencies.openBrowser(verification.verificationUriComplete);

  let pollingInterval = Math.max(1, codePayload.interval) * 1_000;
  const deadline = dependencies.now() + Math.max(1, codePayload.expires_in) * 1_000;
  while (dependencies.now() < deadline) {
    await dependencies.sleep(pollingInterval);
    const tokenResponse = await dependencies.fetch(new URL('/api/auth/device/token', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: codePayload.device_code,
        client_id: DEVICE_AUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
    const tokenPayload = await readJson(tokenResponse);

    if (tokenResponse.ok && isDeviceTokenResponse(tokenPayload)) {
      await dependencies.store.write({
        version: 1,
        baseUrl,
        token: tokenPayload.access_token,
        createdAt: new Date(dependencies.now()).toISOString(),
      });
      return verification;
    }

    const error = errorCode(tokenPayload);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      pollingInterval += 5_000;
      continue;
    }
    if (error === 'access_denied') throw new Error('Device authorization was denied.');
    if (error === 'expired_token') throw new Error('The device authorization code expired.');
    throw new Error(apiMessage(tokenPayload, 'Device authorization failed.'));
  }

  throw new Error('The device authorization code expired.');
}

function resolved(
  value: string,
  source: ResolvedCredential['source'],
): ResolvedCredential {
  return { value, source, kind: value.startsWith('aty_') ? 'api-key' : 'cli-session' };
}

function cleanCredential(value: string | undefined): string | undefined {
  const credential = value?.trim();
  return credential || undefined;
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  return url.origin;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeviceCodeResponse(value: unknown): value is DeviceCodeResponse {
  return isRecord(value)
    && typeof value.device_code === 'string'
    && typeof value.user_code === 'string'
    && typeof value.verification_uri === 'string'
    && typeof value.verification_uri_complete === 'string'
    && typeof value.expires_in === 'number'
    && typeof value.interval === 'number';
}

function isDeviceTokenResponse(value: unknown): value is DeviceTokenResponse {
  return isRecord(value)
    && typeof value.access_token === 'string'
    && value.token_type === 'Bearer'
    && typeof value.expires_in === 'number'
    && typeof value.scope === 'string';
}

function errorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === 'string' ? value.error : undefined;
}

function apiMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error_description === 'string'
    ? value.error_description
    : fallback;
}
