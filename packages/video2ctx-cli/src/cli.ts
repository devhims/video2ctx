import {
  authenticateDevice,
  resolveCredential,
  type CredentialStore,
  type ResolvedCredential,
  type StoredProfile,
} from './auth';

const DEFAULT_BASE_URL = 'https://api.video2ctx.dev';
const REQUEST_TIMEOUT_MS = 30_000;
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
    if (args[0] === 'api') {
      return await api(args.slice(1), dependencies, existingProfile);
    }

    throw new Error('Unknown command. Run video2ctx --help.');
  } catch (error) {
    dependencies.stderr(redact(error instanceof Error ? error.message : String(error), secrets));
    return 1;
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
  const credential = resolveCredential({
    environmentApiKey: dependencies.environment.VIDEO2CTX_API_KEY,
    profile,
  });
  const json = args.includes('--json');
  if (!credential) {
    if (command === 'status') {
      output(dependencies, { authenticated: false }, json);
      return 0;
    }
    throw new Error('Not authenticated. Run video2ctx auth login or set VIDEO2CTX_API_KEY.');
  }

  const { data: account } = await authenticatedJson(
    '/v1/account',
    { method: 'GET' },
    credential,
    requestBaseUrl(dependencies, credential),
    dependencies.fetch,
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

  const response = await dependencies.fetch(new URL('/api/auth/sign-out', profile.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${profile.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
  await dependencies.store.delete();
  output(dependencies, { loggedOut: true, revoked: true }, json);
  return 0;
}

async function api(
  args: string[],
  dependencies: CliDependencies,
  profile: StoredProfile | null,
): Promise<number> {
  const method = (args[0] ?? '').toUpperCase();
  const path = args[1] ?? '';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('API method must be GET, POST, PUT, PATCH, or DELETE.');
  }
  if (!path.startsWith('/v1/')) throw new Error('API path must start with /v1/.');

  const credential = resolveCredential({
    environmentApiKey: dependencies.environment.VIDEO2CTX_API_KEY,
    profile,
  });
  if (!credential) throw new Error('Not authenticated. Run video2ctx auth login or set VIDEO2CTX_API_KEY.');
  const data = option(args, '--data');
  if (data) JSON.parse(data);
  const result = await authenticatedJson(path, {
    method,
    ...(data ? { headers: { 'content-type': 'application/json' }, body: data } : {}),
  }, credential, requestBaseUrl(dependencies, credential), dependencies.fetch);
  dependencies.stdout(JSON.stringify(args.includes('--include-meta') ? result : result.data));
  return 0;
}

async function authenticatedJson(
  path: string,
  init: RequestInit,
  credential: ResolvedCredential,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${credential.value}`);
  const response = await fetchImpl(new URL(path, baseUrl), {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
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

function requestBaseUrl(dependencies: CliDependencies, credential: ResolvedCredential): string {
  return dependencies.environment.VIDEO2CTX_BASE_URL
    ?? credential.baseUrl
    ?? DEFAULT_BASE_URL;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
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

function apiErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const nested = isRecord(payload.error) ? payload.error : payload;
    if (typeof nested.message === 'string') return nested.message;
    if (typeof nested.error_description === 'string') return nested.error_description;
  }
  return `video2ctx request failed (${status}).`;
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
    '  video2ctx api METHOD /v1/path [--data JSON] [--include-meta]',
  ].join('\n');
}
