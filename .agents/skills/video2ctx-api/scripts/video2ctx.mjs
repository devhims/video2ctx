#!/usr/bin/env node

// src/entry.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/browser.ts
import { spawn } from "node:child_process";
async function openBrowser(url) {
  const target = new URL(url).toString();
  const command = browserCommand(target);
  await new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      shell: false
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
function browserCommand(url) {
  if (process.platform === "darwin") return { file: "open", args: [url] };
  if (process.platform === "win32") {
    return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { file: "xdg-open", args: [url] };
}

// src/auth.ts
var DEVICE_AUTH_CLIENT_ID = "video2ctx-cli";
var DEVICE_AUTH_SCOPE = "data:read account:access";
var AUTH_REQUEST_TIMEOUT_MS = 3e4;
function resolveCredential(options) {
  const explicit = cleanCredential(options.explicitCredential);
  if (explicit) return resolved(explicit, "explicit");
  const environment2 = cleanCredential(options.environmentApiKey);
  if (environment2) return resolved(environment2, "environment");
  const profile = options.profile;
  const profileCredential = cleanCredential(profile?.token);
  return profileCredential ? { ...resolved(profileCredential, "profile"), baseUrl: profile?.baseUrl } : null;
}
async function authenticateDevice(options, dependencies) {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const codeResponse = await dependencies.fetch(new URL("/api/auth/device/code", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: DEVICE_AUTH_CLIENT_ID, scope: DEVICE_AUTH_SCOPE }),
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  });
  const codePayload = await readJson(codeResponse);
  if (!codeResponse.ok || !isDeviceCodeResponse(codePayload)) {
    throw new Error(apiMessage(codePayload, "Could not start device authorization."));
  }
  const verification = {
    userCode: codePayload.user_code,
    verificationUri: codePayload.verification_uri,
    verificationUriComplete: codePayload.verification_uri_complete
  };
  await dependencies.onVerification?.(verification);
  if (!options.noBrowser) await dependencies.openBrowser(verification.verificationUriComplete);
  let pollingInterval = Math.max(1, codePayload.interval) * 1e3;
  const deadline = dependencies.now() + Math.max(1, codePayload.expires_in) * 1e3;
  while (dependencies.now() < deadline) {
    await dependencies.sleep(pollingInterval);
    const tokenResponse = await dependencies.fetch(new URL("/api/auth/device/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codePayload.device_code,
        client_id: DEVICE_AUTH_CLIENT_ID
      }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
    });
    const tokenPayload = await readJson(tokenResponse);
    if (tokenResponse.ok && isDeviceTokenResponse(tokenPayload)) {
      await dependencies.store.write({
        version: 1,
        baseUrl,
        token: tokenPayload.access_token,
        createdAt: new Date(dependencies.now()).toISOString()
      });
      return verification;
    }
    const error = errorCode(tokenPayload);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      pollingInterval += 5e3;
      continue;
    }
    if (error === "access_denied") throw new Error("Device authorization was denied.");
    if (error === "expired_token") throw new Error("The device authorization code expired.");
    throw new Error(apiMessage(tokenPayload, "Device authorization failed."));
  }
  throw new Error("The device authorization code expired.");
}
function resolved(value, source) {
  return { value, source, kind: value.startsWith("aty_") ? "api-key" : "cli-session" };
}
function cleanCredential(value) {
  const credential = value?.trim();
  return credential || void 0;
}
function normalizedBaseUrl(value) {
  const url = new URL(value);
  return url.origin;
}
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isDeviceCodeResponse(value) {
  return isRecord(value) && typeof value.device_code === "string" && typeof value.user_code === "string" && typeof value.verification_uri === "string" && typeof value.verification_uri_complete === "string" && typeof value.expires_in === "number" && typeof value.interval === "number";
}
function isDeviceTokenResponse(value) {
  return isRecord(value) && typeof value.access_token === "string" && value.token_type === "Bearer" && typeof value.expires_in === "number" && typeof value.scope === "string";
}
function errorCode(value) {
  return isRecord(value) && typeof value.error === "string" ? value.error : void 0;
}
function apiMessage(value, fallback) {
  return isRecord(value) && typeof value.error_description === "string" ? value.error_description : fallback;
}

// src/cli.ts
var DEFAULT_BASE_URL = "https://api.video2ctx.dev";
var REQUEST_TIMEOUT_MS = 3e4;
async function runCli(args, dependencies) {
  const existingProfile = await dependencies.store.read();
  const secrets = [
    dependencies.environment.VIDEO2CTX_API_KEY,
    existingProfile?.token
  ].filter((value) => Boolean(value));
  try {
    if (!args.length || args.includes("--help") || args[0] === "help") {
      dependencies.stdout(helpText());
      return 0;
    }
    if (args[0] === "auth" && args[1] === "login") {
      return await login(args.slice(2), dependencies);
    }
    if (args[0] === "auth" && args[1] === "status") {
      return await identity("status", args.slice(2), dependencies, existingProfile);
    }
    if (args[0] === "whoami") {
      return await identity("whoami", args.slice(1), dependencies, existingProfile);
    }
    if (args[0] === "auth" && args[1] === "logout") {
      return await logout(args.slice(2), dependencies, existingProfile);
    }
    if (args[0] === "api") {
      return await api(args.slice(1), dependencies, existingProfile);
    }
    throw new Error("Unknown command. Run video2ctx --help.");
  } catch (error) {
    dependencies.stderr(redact(error instanceof Error ? error.message : String(error), secrets));
    return 1;
  }
}
async function login(args, dependencies) {
  const baseUrl = option(args, "--base-url") ?? dependencies.environment.VIDEO2CTX_BASE_URL ?? DEFAULT_BASE_URL;
  const noBrowser = args.includes("--no-browser");
  await authenticateDevice({ baseUrl, noBrowser }, {
    fetch: dependencies.fetch,
    store: dependencies.store,
    openBrowser: dependencies.openBrowser,
    now: dependencies.now,
    sleep: dependencies.sleep,
    onVerification: (details) => {
      dependencies.stdout(`Open ${details.verificationUri}`);
      dependencies.stdout(`Enter code: ${details.userCode}`);
    }
  });
  dependencies.stdout("Authenticated as a CLI session.");
  return 0;
}
async function identity(command, args, dependencies, profile) {
  const credential = resolveCredential({
    environmentApiKey: dependencies.environment.VIDEO2CTX_API_KEY,
    profile
  });
  const json = args.includes("--json");
  if (!credential) {
    if (command === "status") {
      output(dependencies, { authenticated: false }, json);
      return 0;
    }
    throw new Error("Not authenticated. Run video2ctx auth login or set VIDEO2CTX_API_KEY.");
  }
  const { data: account } = await authenticatedJson(
    "/v1/account",
    { method: "GET" },
    credential,
    requestBaseUrl(dependencies, credential),
    dependencies.fetch
  );
  const result = isRecord2(account) ? { authenticated: true, ...account } : { authenticated: true };
  output(dependencies, result, json);
  return 0;
}
async function logout(args, dependencies, profile) {
  const json = args.includes("--json");
  if (!profile?.token) {
    output(dependencies, { loggedOut: false, revoked: false }, json);
    return 0;
  }
  const response = await dependencies.fetch(new URL("/api/auth/sign-out", profile.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${profile.token}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await readJson2(response);
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
  await dependencies.store.delete();
  output(dependencies, { loggedOut: true, revoked: true }, json);
  return 0;
}
async function api(args, dependencies, profile) {
  const method = (args[0] ?? "").toUpperCase();
  const path = args[1] ?? "";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new Error("API method must be GET, POST, PUT, PATCH, or DELETE.");
  }
  if (!path.startsWith("/v1/")) throw new Error("API path must start with /v1/.");
  const credential = resolveCredential({
    environmentApiKey: dependencies.environment.VIDEO2CTX_API_KEY,
    profile
  });
  if (!credential) throw new Error("Not authenticated. Run video2ctx auth login or set VIDEO2CTX_API_KEY.");
  const data = option(args, "--data");
  if (data) JSON.parse(data);
  const result = await authenticatedJson(path, {
    method,
    ...data ? { headers: { "content-type": "application/json" }, body: data } : {}
  }, credential, requestBaseUrl(dependencies, credential), dependencies.fetch);
  dependencies.stdout(JSON.stringify(args.includes("--include-meta") ? result : result.data));
  return 0;
}
async function authenticatedJson(path, init, credential, baseUrl, fetchImpl) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${credential.value}`);
  const response = await fetchImpl(new URL(path, baseUrl), {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await readJson2(response);
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
  return {
    data: payload,
    meta: compact({
      status: response.status,
      requestId: response.headers.get("X-Request-Id") ?? void 0,
      creditsCharged: integerHeader(response.headers.get("X-Credits-Charged")),
      creditsRemaining: integerHeader(response.headers.get("X-Credits-Remaining"))
    })
  };
}
function requestBaseUrl(dependencies, credential) {
  return dependencies.environment.VIDEO2CTX_BASE_URL ?? credential.baseUrl ?? DEFAULT_BASE_URL;
}
function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return void 0;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
function output(dependencies, value, json) {
  if (json) {
    dependencies.stdout(JSON.stringify(value));
    return;
  }
  if (value.authenticated === false) {
    dependencies.stdout("Not authenticated.");
    return;
  }
  const user = isRecord2(value.user) ? value.user : null;
  const name = user && typeof user.name === "string" ? user.name : void 0;
  const email = user && typeof user.email === "string" ? user.email : void 0;
  dependencies.stdout(name && email ? `${name} <${email}>` : email ?? "Authenticated.");
}
function redact(message, secrets) {
  return secrets.reduce((result, secret) => secret ? result.split(secret).join("***") : result, message);
}
async function readJson2(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}
function apiErrorMessage(payload, status) {
  if (isRecord2(payload)) {
    const nested = isRecord2(payload.error) ? payload.error : payload;
    if (typeof nested.message === "string") return nested.message;
    if (typeof nested.error_description === "string") return nested.error_description;
  }
  return `video2ctx request failed (${status}).`;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integerHeader(value) {
  if (value === null || !/^-?\d+$/.test(value)) return void 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== void 0));
}
function helpText() {
  return [
    "video2ctx",
    "",
    "Commands:",
    "  video2ctx auth login [--no-browser] [--base-url URL]",
    "  video2ctx auth status [--json]",
    "  video2ctx whoami [--json]",
    "  video2ctx auth logout [--json]",
    "  video2ctx api METHOD /v1/path [--data JSON] [--include-meta]"
  ].join("\n");
}

// src/profile-store.ts
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
var FileCredentialStore = class {
  constructor(directory) {
    this.directory = directory;
    this.profilePath = join(directory, "profile.json");
  }
  profilePath;
  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.profilePath, "utf8"));
      if (!isStoredProfile(parsed)) throw new Error("The video2ctx CLI profile is invalid. Sign in again.");
      return parsed;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
  }
  async write(profile) {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    if (process.platform !== "win32") await chmod(this.directory, 448);
    const temporaryPath = join(this.directory, `.profile-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}
`, {
      encoding: "utf8",
      mode: 384,
      flag: "wx"
    });
    await rename(temporaryPath, this.profilePath);
    if (process.platform !== "win32") await chmod(this.profilePath, 384);
  }
  async delete() {
    try {
      await unlink(this.profilePath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
};
function isStoredProfile(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "version" in value && value.version === 1 && "baseUrl" in value && typeof value.baseUrl === "string" && "token" in value && typeof value.token === "string" && value.token.length > 0 && "createdAt" in value && typeof value.createdAt === "string";
}
function isFileSystemError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

// src/entry.ts
var environment = process.env;
var configDirectory = environment.VIDEO2CTX_CONFIG_DIR ?? (environment.XDG_CONFIG_HOME ? join2(environment.XDG_CONFIG_HOME, "video2ctx") : join2(homedir(), ".config", "video2ctx"));
process.exitCode = await runCli(process.argv.slice(2), {
  fetch,
  store: new FileCredentialStore(configDirectory),
  environment,
  openBrowser,
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stdout: (line) => process.stdout.write(`${line}
`),
  stderr: (line) => process.stderr.write(`${line}
`)
});
