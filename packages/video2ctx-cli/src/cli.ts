import {
  authenticateDevice,
  resolveCredential,
  type CredentialStore,
  type ResolvedCredential,
  type StoredProfile,
} from './auth';

const DEFAULT_BASE_URL = 'https://api.video2ctx.dev';
const AUTH_REQUEST_TIMEOUT_MS = 30_000;
const DATA_REQUEST_TIMEOUT_MS = 150_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_GET_RETRIES = 1;
const MAX_GET_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
declare const __VIDEO2CTX_VERSION__: string;
const CLI_VERSION = typeof __VIDEO2CTX_VERSION__ === 'string'
  ? __VIDEO2CTX_VERSION__
  : 'development';

export type CliDependencies = {
  fetch: typeof fetch;
  store: CredentialStore;
  environment: Record<string, string | undefined>;
  openBrowser(url: string): Promise<void>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
};

type RequestOptions = {
  timeoutMs: number;
  retries: number;
};

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      status?: number;
      requestId?: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      exitCode?: number;
    },
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const existingProfile = await dependencies.store.read();
  const secrets = [
    dependencies.environment.VIDEO2CTX_API_KEY,
    existingProfile?.token,
  ].filter((value): value is string => Boolean(value));

  try {
    if (args.includes('--version') || args[0] === 'version') {
      dependencies.stdout(CLI_VERSION);
      return 0;
    }
    if (!args.length || args.includes('--help') || args[0] === 'help') {
      dependencies.stdout(helpText());
      return 0;
    }

    if (args[0] === 'auth' && args[1] === 'login') {
      return await login(args.slice(2), dependencies);
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return await identity('status', args.slice(2), dependencies, existingProfile);
    }
    if (args[0] === 'whoami') {
      return await identity('whoami', args.slice(1), dependencies, existingProfile);
    }
    if (args[0] === 'auth' && args[1] === 'logout') {
      return await logout(args.slice(2), dependencies, existingProfile);
    }
    if (args[0] === 'transcript') {
      return await transcript(args.slice(1), dependencies, existingProfile);
    }
    if (args[0] === 'api') {
      return await api(args.slice(1), dependencies, existingProfile);
    }

    throw inputError('Unknown command. Run video2ctx --help.');
  } catch (error) {
    const normalized = normalizeError(error);
    dependencies.stderr(JSON.stringify({
      error: compact({
        status: normalized.details.status,
        code: normalized.code,
        message: redact(normalized.message, secrets),
        requestId: normalized.details.requestId,
        retryable: normalized.details.retryable,
        retryAfterSeconds: normalized.details.retryAfterSeconds,
      }),
    }));
    return normalized.details.exitCode ?? 1;
  }
}

async function login(args: string[], dependencies: CliDependencies): Promise<number> {
  const baseUrl = option(args, '--base-url')
    ?? dependencies.environment.VIDEO2CTX_BASE_URL
    ?? DEFAULT_BASE_URL;
  const noBrowser = args.includes('--no-browser');
  await authenticateDevice({ baseUrl, noBrowser }, {
    fetch: dependencies.fetch,
    store: dependencies.store,
    openBrowser: dependencies.openBrowser,
    now: dependencies.now,
    sleep: dependencies.sleep,
    onVerification: (details) => {
      dependencies.stdout(`Open ${details.verificationUri}`);
      dependencies.stdout(`Enter code: ${details.userCode}`);
    },
  });
  dependencies.stdout('Authenticated as a CLI session.');
  return 0;
}

async function identity(
  command: 'status' | 'whoami',
  args: string[],
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): Promise<number> {
  const credential = credentialFor(dependencies, profile);
  const json = args.includes('--json');
  if (!credential) {
    if (command === 'status') {
      output(dependencies, { authenticated: false }, json);
      return 0;
    }
    throw authenticationRequired();
  }

  const { data: account } = await authenticatedJson(
    '/v1/account',
    { method: 'GET' },
    credential,
    requestBaseUrl(dependencies, credential),
    dependencies,
    { timeoutMs: AUTH_REQUEST_TIMEOUT_MS, retries: 0 },
  );
  const result = isRecord(account)
    ? { authenticated: true, ...account }
    : { authenticated: true };
  output(dependencies, result, json);
  return 0;
}

async function logout(
  args: string[],
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): Promise<number> {
  const json = args.includes('--json');
  if (!profile?.token) {
    output(dependencies, { loggedOut: false, revoked: false }, json);
    return 0;
  }

  let response: Response;
  try {
    response = await dependencies.fetch(new URL('/api/auth/sign-out', profile.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${profile.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw transportError(error);
  }
  const payload = await readJson(response);
  if (!response.ok) throw responseError(response, payload, dependencies.now());
  await dependencies.store.delete();
  output(dependencies, { loggedOut: true, revoked: true }, json);
  return 0;
}

async function transcript(
  args: string[],
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): Promise<number> {
  const input = args[0];
  if (!input || input.startsWith('--')) {
    throw inputError('transcript requires a YouTube URL or video ID.');
  }
  const videoId = youtubeVideoId(input);
  const format = option(args, '--format') ?? 'text';
  if (!['text', 'segments', 'words'].includes(format)) {
    throw inputError('--format must be text, segments, or words.');
  }
  const query = new URLSearchParams({ format });
  const language = option(args, '--lang');
  if (language) query.set('lang', language);
  return authenticatedRead(
    `/v1/providers/youtube/videos/${encodeURIComponent(videoId)}/transcript?${query}`,
    args,
    dependencies,
    profile,
  );
}

async function api(
  args: string[],
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): Promise<number> {
  const method = (args[0] ?? '').toUpperCase();
  const path = args[1] ?? '';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw inputError('API method must be GET, POST, PUT, PATCH, or DELETE.');
  }
  if (!path.startsWith('/v1/')) throw inputError('API path must start with /v1/.');

  const credential = credentialFor(dependencies, profile);
  if (!credential) throw authenticationRequired();
  const data = option(args, '--data');
  if (data) {
    try {
      JSON.parse(data);
    } catch {
      throw inputError('--data must be valid JSON.');
    }
  }
  const result = await authenticatedJson(path, {
    method,
    ...(data ? { headers: { 'content-type': 'application/json' }, body: data } : {}),
  }, credential, requestBaseUrl(dependencies, credential), dependencies, dataRequestOptions(args));
  dependencies.stdout(JSON.stringify(args.includes('--include-meta') ? result : result.data));
  return 0;
}

async function authenticatedRead(
  path: string,
  args: string[],
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): Promise<number> {
  const credential = credentialFor(dependencies, profile);
  if (!credential) throw authenticationRequired();
  const result = await authenticatedJson(
    path,
    { method: 'GET' },
    credential,
    requestBaseUrl(dependencies, credential),
    dependencies,
    dataRequestOptions(args),
  );
  dependencies.stdout(JSON.stringify(args.includes('--include-meta') ? result : result.data));
  return 0;
}

async function authenticatedJson(
  path: string,
  init: RequestInit,
  credential: ResolvedCredential,
  baseUrl: string,
  dependencies: CliDependencies,
  options: RequestOptions,
): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${credential.value}`);
  const method = (init.method ?? 'GET').toUpperCase();

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await dependencies.fetch(new URL(path, baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw transportError(error);
    }
    const payload = await readJson(response);
    if (response.ok) {
      return {
        data: payload,
        meta: compact({
          status: response.status,
          requestId: response.headers.get('X-Request-Id') ?? undefined,
          creditsCharged: integerHeader(response.headers.get('X-Credits-Charged')),
          creditsRemaining: integerHeader(response.headers.get('X-Credits-Remaining')),
        }),
      };
    }

    const failure = responseError(response, payload, dependencies.now());
    const canRetry = method === 'GET'
      && (response.status === 429 || response.status === 503)
      && attempt < options.retries;
    if (!canRetry) throw failure;
    const delayMs = Math.min(
      failure.details.retryAfterSeconds === undefined
        ? 1_000 * (attempt + 1)
        : failure.details.retryAfterSeconds * 1_000,
      MAX_RETRY_DELAY_MS,
    );
    await dependencies.sleep(delayMs);
  }
}

function credentialFor(
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): ResolvedCredential | null {
  return resolveCredential({
    environmentApiKey: dependencies.environment.VIDEO2CTX_API_KEY,
    profile,
  });
}

function dataRequestOptions(args: string[]): RequestOptions {
  return {
    timeoutMs: integerOption(
      args,
      '--timeout-ms',
      DATA_REQUEST_TIMEOUT_MS,
      1_000,
      MAX_REQUEST_TIMEOUT_MS,
    ),
    retries: integerOption(args, '--retries', DEFAULT_GET_RETRIES, 0, MAX_GET_RETRIES),
  };
}

function requestBaseUrl(dependencies: CliDependencies, credential: ResolvedCredential): string {
  return dependencies.environment.VIDEO2CTX_BASE_URL
    ?? credential.baseUrl
    ?? DEFAULT_BASE_URL;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw inputError(`${name} requires a value.`);
  return value;
}

function integerOption(
  args: string[],
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = option(args, name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw inputError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function youtubeVideoId(input: string): string {
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw inputError('Use an 11-character YouTube video ID or YouTube URL.');
  }
  const hostname = url.hostname.toLowerCase();
  let candidate: string | null | undefined;
  if (hostname === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0];
  } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
    candidate = url.searchParams.get('v');
    if (!candidate) {
      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'live', 'embed'].includes(kind ?? '')) candidate = id;
    }
  }
  if (!candidate || !/^[A-Za-z0-9_-]{11}$/.test(candidate)) {
    throw inputError('Use an 11-character YouTube video ID or YouTube URL.');
  }
  return candidate;
}

function output(dependencies: CliDependencies, value: Record<string, unknown>, json: boolean): void {
  if (json) {
    dependencies.stdout(JSON.stringify(value));
    return;
  }
  if (value.authenticated === false) {
    dependencies.stdout('Not authenticated.');
    return;
  }
  const user = isRecord(value.user) ? value.user : null;
  const name = user && typeof user.name === 'string' ? user.name : undefined;
  const email = user && typeof user.email === 'string' ? user.email : undefined;
  dependencies.stdout(name && email ? `${name} <${email}>` : email ?? 'Authenticated.');
}

function redact(message: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => secret ? result.split(secret).join('***') : result, message);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}

function responseError(response: Response, payload: unknown, now: number): CliError {
  const nested = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
  const record = isRecord(nested) ? nested : {};
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.error_description === 'string'
      ? record.error_description
      : `video2ctx request failed (${response.status}).`;
  const code = typeof record.code === 'string' ? record.code : `HTTP_${response.status}`;
  return new CliError(code, message, {
    status: response.status,
    requestId: response.headers.get('X-Request-Id')
      ?? (typeof record.requestId === 'string' ? record.requestId : undefined),
    retryable: response.status === 429 || response.status === 503,
    retryAfterSeconds: retryAfter(response.headers.get('Retry-After'), now),
  });
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1_000));
}

function transportError(error: unknown): CliError {
  const message = error instanceof Error ? error.message : 'The request could not be completed.';
  const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return new CliError(
    timeout ? 'REQUEST_TIMEOUT' : 'TRANSPORT_ERROR',
    timeout ? 'The video2ctx request exceeded its deadline.' : message,
    { retryable: true },
  );
}

function inputError(message: string): CliError {
  return new CliError('INVALID_INPUT', message, { retryable: false, exitCode: 2 });
}

function authenticationRequired(): CliError {
  return new CliError(
    'AUTHENTICATION_REQUIRED',
    'Not authenticated. Run video2ctx auth login or set VIDEO2CTX_API_KEY.',
    { status: 401, retryable: false },
  );
}

function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : 'Unexpected video2ctx CLI failure.',
    { retryable: false },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerHeader(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function helpText(): string {
  return [
    'video2ctx',
    `Version: ${CLI_VERSION}`,
    '',
    'Commands:',
    '  video2ctx auth login [--no-browser] [--base-url URL]',
    '  video2ctx auth status [--json]',
    '  video2ctx whoami [--json]',
    '  video2ctx auth logout [--json]',
    '  video2ctx transcript URL_OR_ID [--format text|segments|words] [--lang CODE]',
    '                       [--include-meta] [--timeout-ms N] [--retries N]',
    '  video2ctx api METHOD /v1/path [--data JSON] [--include-meta]',
    '                       [--timeout-ms N] [--retries N]',
  ].join('\n');
}
