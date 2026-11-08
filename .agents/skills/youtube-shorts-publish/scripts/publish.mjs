#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);

// src/publish/cli.ts
import { mkdir as mkdir4, readFile as readFile4, stat as stat2, writeFile as writeFile3 } from "node:fs/promises";
import { join as join4, resolve as resolve2 } from "node:path";

// src/watch/ffmpeg.ts
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

// ../all-things-youtube/src/youtube-types.ts
var YouTubeClientError = class extends Error {
  code;
  status;
  retryable;
  /** Set when YouTube challenged the connection itself, so callers can blame the egress route. */
  reason;
  constructor(code, message, options = {}) {
    super(message);
    if (options.cause !== void 0) {
      this.cause = options.cause;
    }
    this.name = "YouTubeClientError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.reason !== void 0) this.reason = options.reason;
  }
};

// src/watch/ffmpeg.ts
function pathValue(environment, platform) {
  if (platform !== "win32") return environment.PATH ?? "";
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path");
  return key ? environment[key] ?? "" : "";
}
function executableNames(command, environment, platform) {
  if (platform !== "win32" || extname(command)) return [command];
  const extensions = (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}
async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
async function resolveFfmpegExecutable(command, environment = process.env, platform = process.platform) {
  const trimmed = command.trim();
  const hasPath = isAbsolute(trimmed) || /[\\/]/.test(trimmed);
  const directories = hasPath ? [""] : pathValue(environment, platform).split(delimiter).filter(Boolean);
  const names = executableNames(trimmed, environment, platform);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = hasPath ? resolve(name) : resolve(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  throw new YouTubeClientError(
    "DEPENDENCY_MISSING",
    "FFmpeg is required for exact frames. Install FFmpeg, set FFMPEG_PATH, or provide ffmpegPath."
  );
}

// src/shorts/media.ts
import { spawn } from "node:child_process";
import { copyFile, mkdir as mkdir2, rm as rm2, writeFile } from "node:fs/promises";
import { basename, dirname, join as join2 } from "node:path";
var STDERR_LIMIT = 4e5;
var PROBE_TIMEOUT_MS = 3e4;
var STEP_TIMEOUT_MS = 15 * 6e4;
var MediaError = class extends Error {
  constructor(message, stderr) {
    super(message);
    this.stderr = stderr;
    this.name = "MediaError";
  }
  stderr;
  code = "MEDIA_FAILED";
};
function runFfmpeg(ffmpeg, args, options = {}) {
  return new Promise((resolve3, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1e3).unref();
    }, options.timeoutMs ?? STEP_TIMEOUT_MS);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve3({ code, stderr, stdout });
    });
  });
}
async function mustRun(ffmpeg, args, what, options = {}) {
  const result = await runFfmpeg(ffmpeg, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-3).join(" ");
    throw new MediaError(`FFmpeg failed to ${what}: ${detail}`, result.stderr);
  }
  return result;
}
async function probeMaster(ffmpeg, path) {
  const { stderr } = await runFfmpeg(ffmpeg, ["-i", path], { timeoutMs: PROBE_TIMEOUT_MS });
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const video = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  if (!duration || !video) throw new MediaError(`Could not read a video stream and duration from ${basename(path)}.`, stderr);
  return {
    width: Number(video[1]),
    height: Number(video[2]),
    durationSec: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
    fps: Number(/Stream #[^\n]*Video:[^\n]*?([\d.]+) fps/.exec(stderr)?.[1]) || 30
  };
}
var seconds = (ms) => (ms / 1e3).toFixed(3);
async function extractThumbnail(ffmpeg, master, atMs, path, width = 480) {
  await mkdir2(dirname(path), { recursive: true });
  await mustRun(ffmpeg, [
    "-ss",
    seconds(atMs),
    "-i",
    master,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    "3",
    "-y",
    path
  ], "extract a thumbnail", { timeoutMs: PROBE_TIMEOUT_MS });
}

// src/publish/kit.ts
var LIMITS = {
  titleChars: 100,
  descriptionBytes: 5e3,
  tagsChars: 500,
  hashtagsIgnoredAbove: 60,
  hashtagsShownAboveTitle: 3,
  shortMaxSec: 180
};
var ANGLE = /[<>]/;
var HASHTAG = /^#[\p{L}\p{N}_]+$/u;
function tagsLength(tags) {
  return tags.reduce((total, tag) => total + tag.length + (/\s/.test(tag) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}
function momentUrl(videoId, startMs) {
  return `https://youtu.be/${videoId}?t=${Math.floor(startMs / 1e3)}`;
}
function composeDescription(short, episodeUrl, moment) {
  const body = short.description.replaceAll("{episode}", episodeUrl).replaceAll("{moment}", moment).trim();
  const hashtags = (short.hashtags ?? []).filter((tag) => !body.includes(tag));
  return hashtags.length ? `${body}

${hashtags.join(" ")}` : body;
}
function parsePublishPlan(value) {
  if (typeof value !== "object" || value === null || !Array.isArray(value.shorts)) {
    throw new Error("publish.json needs a shorts array.");
  }
  const plan = value;
  plan.shorts.forEach((short, index) => {
    if (typeof short?.id !== "string" || typeof short.title !== "string" || typeof short.description !== "string") {
      throw new Error(`publish.json shorts[${index}] needs id, title, and description strings.`);
    }
  });
  return plan;
}
function checkShort(short, description, videoId, facts) {
  const issues = [];
  const add = (level, message) => issues.push({ short: short.id, level, message });
  const title = short.title.trim();
  if (!title) add("error", "Title is empty.");
  if ([...title].length > LIMITS.titleChars) add("error", `Title has ${[...title].length} characters; YouTube allows ${LIMITS.titleChars}.`);
  if (ANGLE.test(title)) add("error", "Title contains < or >, which YouTube rejects.");
  const bytes = Buffer.byteLength(description, "utf8");
  if (bytes > LIMITS.descriptionBytes) add("error", `Description is ${bytes} bytes; YouTube allows ${LIMITS.descriptionBytes}.`);
  if (ANGLE.test(description)) add("error", "Description contains < or >, which YouTube rejects.");
  if (!description.includes(videoId)) add("warning", "Description does not link the full episode; use {episode} or {moment}.");
  const hashtags = short.hashtags ?? [];
  const bad = hashtags.filter((tag) => !HASHTAG.test(tag));
  if (bad.length) add("error", `Hashtags must be # plus letters, digits, or _ with no spaces: ${bad.join(", ")}.`);
  const allHashtags = (`${title} ${description}`.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (allHashtags > LIMITS.hashtagsIgnoredAbove) add("error", `${allHashtags} hashtags: above ${LIMITS.hashtagsIgnoredAbove}, YouTube ignores every one.`);
  else if (allHashtags > 5) add("warning", `${allHashtags} hashtags; YouTube shows at most ${LIMITS.hashtagsShownAboveTitle} above the title, so 3 to 5 is plenty.`);
  const tags = short.tags ?? [];
  if (tags.some((tag) => ANGLE.test(tag))) add("error", "A tag contains < or >.");
  if (tagsLength(tags) > LIMITS.tagsChars) add("error", `Tags total ${tagsLength(tags)} characters; YouTube allows ${LIMITS.tagsChars}.`);
  if (short.publishAt !== void 0 && (!/[zZ]|[+-]\d{2}:\d{2}$/.test(short.publishAt) || Number.isNaN(Date.parse(short.publishAt)))) {
    add("error", "publishAt must be an ISO 8601 time with a time zone, e.g. 2026-11-10T18:00:00+05:30.");
  }
  if (facts.durationSec !== void 0 && facts.durationSec > LIMITS.shortMaxSec) {
    add("error", `Video runs ${facts.durationSec.toFixed(1)}s; Shorts allow up to ${LIMITS.shortMaxSec}s.`);
  }
  if (facts.width !== void 0 && facts.height !== void 0 && facts.width > facts.height) {
    add("error", `Video is ${facts.width}x${facts.height}; Shorts must be vertical or square.`);
  }
  if (!short.pinnedComment) add("warning", "No pinned comment; one that points to the full episode is a cheap extra path to it.");
  return issues;
}
function publishSheet(short, description, related, cover, video) {
  return [
    `# ${short.id}: ${short.title}`,
    "",
    `Video: ${video}`,
    `Cover frame: ${cover}`,
    short.publishAt ? `Schedule: ${short.publishAt}` : "Schedule: not set",
    "",
    "## Title",
    "",
    short.title,
    "",
    "## Description",
    "",
    description,
    "",
    "## Tags",
    "",
    (short.tags ?? []).join(", ") || "(none)",
    "",
    "## Related video",
    "",
    related,
    "",
    "## Pinned comment",
    "",
    short.pinnedComment ?? "(none)",
    ""
  ].join("\n");
}

// src/publish/auth.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir as mkdir3, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
var UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
var AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
var TOKEN_URI = "https://oauth2.googleapis.com/token";
var CONSENT_TIMEOUT_MS = 5 * 6e4;
var AuthError = class extends Error {
  code = "AUTH_REQUIRED";
};
function parseClientSecret(value) {
  const installed = value?.installed;
  if (!installed || typeof installed.client_id !== "string" || typeof installed.client_secret !== "string") {
    throw new AuthError('The OAuth client file must be a "Desktop app" client JSON from Google Cloud Console (it has an "installed" section).');
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}
function tokenPath(client, environment = process.env) {
  const base = environment.XDG_CONFIG_HOME ?? join3(environment.HOME ?? homedir(), ".config");
  const id = createHash("sha256").update(client.clientId).digest("hex").slice(0, 12);
  return join3(base, "youtube-shorts-publish", `token-${id}.json`);
}
function openInBrowser(url) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn2(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => void 0);
  child.unref();
}
async function exchange(fetchImpl, body) {
  const response = await fetchImpl(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new AuthError(`Google refused the token request: ${json.error ?? response.status}${json.error_description ? ` (${json.error_description})` : ""}.`);
  }
  return json;
}
async function consent(client, fetchImpl, dependencies) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise((resolve3) => server.listen(0, "127.0.0.1", resolve3));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  try {
    const code = await new Promise((resolve3, reject) => {
      const timer = setTimeout(() => reject(new AuthError("Timed out waiting for YouTube consent in the browser.")), CONSENT_TIMEOUT_MS);
      server.on("request", (request, response) => {
        const url2 = new URL(request.url ?? "/", redirectUri);
        const error = url2.searchParams.get("error");
        const returned = url2.searchParams.get("code");
        if (url2.searchParams.get("state") !== state || !returned && !error) {
          response.writeHead(400).end("Unexpected request.");
          return;
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(error ? "Access was not granted. You can close this tab." : "Upload access granted. You can close this tab.");
        clearTimeout(timer);
        if (error) reject(new AuthError(`Consent was not granted: ${error}.`));
        else resolve3(returned);
      });
      const url = new URL(AUTH_URI);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: UPLOAD_SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      }).toString();
      dependencies.notify?.(`Grant upload access in your browser. If it did not open, visit:
${url.toString()}
`);
      (dependencies.openUrl ?? openInBrowser)(url.toString());
    });
    const tokens = await exchange(fetchImpl, {
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier
    });
    if (!tokens.refresh_token) throw new AuthError("Google did not return a refresh token; remove the app under myaccount.google.com/permissions and try again.");
    return { stored: { refresh_token: tokens.refresh_token, scope: tokens.scope }, accessToken: tokens.access_token };
  } finally {
    server.close();
  }
}
async function getAccessToken(client, path, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const saved = await readFile2(path, "utf8").then((text) => JSON.parse(text)).catch(() => void 0);
  if (saved?.refresh_token) {
    try {
      const tokens = await exchange(fetchImpl, {
        refresh_token: saved.refresh_token,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token"
      });
      return tokens.access_token;
    } catch (error) {
      if (!(error instanceof AuthError) || !/invalid_grant/.test(error.message)) throw error;
    }
  }
  const { stored, accessToken } = await consent(client, fetchImpl, dependencies);
  await mkdir3(dirname2(path), { recursive: true, mode: 448 });
  await writeFile2(path, `${JSON.stringify(stored)}
`, { mode: 384 });
  await chmod(path, 384);
  return accessToken;
}

// src/publish/upload.ts
import { readFile as readFile3 } from "node:fs/promises";
var UPLOAD_URI = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
var MAX_ATTEMPTS = 4;
var UploadError = class extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
  code;
  retryable;
};
function videoResource(metadata) {
  return {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId
    },
    status: {
      privacyStatus: metadata.privacy,
      selfDeclaredMadeForKids: metadata.madeForKids
    }
  };
}
async function apiError(response) {
  const json = await response.json().catch(() => ({}));
  const reason = json.error?.errors?.[0]?.reason ?? String(response.status);
  const message = json.error?.message ?? response.statusText;
  if (reason === "quotaExceeded" || reason === "uploadLimitExceeded") {
    return new UploadError("RATE_LIMITED", `YouTube upload limit reached (${reason}): ${message}`);
  }
  if (response.status === 401) return new UploadError("AUTH_REQUIRED", `YouTube rejected the access token: ${message}`);
  return new UploadError("UPSTREAM_ERROR", `YouTube refused the upload (${reason}): ${message}`, response.status >= 500);
}
async function uploadVideo(fetchImpl, accessToken, file, metadata, wait = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms))) {
  const bytes = await readFile3(file);
  const auth = { authorization: `Bearer ${accessToken}` };
  const start = await fetchImpl(UPLOAD_URI, {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "video/mp4",
      "x-upload-content-length": String(bytes.length)
    },
    body: JSON.stringify(videoResource(metadata))
  });
  if (!start.ok) throw await apiError(start);
  const session = start.headers.get("location");
  if (!session) throw new UploadError("INVALID_RESPONSE", "YouTube did not return an upload session.");
  let offset = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      const body = bytes.subarray(offset);
      response = await fetchImpl(session, {
        method: "PUT",
        headers: {
          ...auth,
          "content-type": "video/mp4",
          ...offset > 0 ? { "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}
        },
        body
      });
    } catch {
      response = void 0;
    }
    if (response && (response.status === 200 || response.status === 201)) {
      const json = await response.json();
      if (!json.id) throw new UploadError("INVALID_RESPONSE", "YouTube finished the upload without a video id.");
      return { videoId: json.id };
    }
    if (response && response.status < 500 && response.status !== 308) throw await apiError(response);
    if (attempt === MAX_ATTEMPTS) break;
    await wait(1e3 * 2 ** (attempt - 1));
    const probe = await fetchImpl(session, { method: "PUT", headers: { ...auth, "content-range": `bytes */${bytes.length}` } }).catch(() => void 0);
    if (probe && (probe.status === 200 || probe.status === 201)) {
      const json = await probe.json();
      if (json.id) return { videoId: json.id };
    }
    const range = probe?.status === 308 ? /bytes=0-(\d+)/.exec(probe.headers.get("range") ?? "") : null;
    offset = range ? Number(range[1]) + 1 : 0;
  }
  throw new UploadError("UPSTREAM_ERROR", `Upload of ${file} did not finish after ${MAX_ATTEMPTS} attempts.`, true);
}

// src/publish/cli.ts
var HELP = `youtube-shorts-publish

Check publishing copy for rendered Shorts against YouTube's limits and write a
copy-paste sheet and cover frame per short. Prints one JSON value.

Usage:
  publish.mjs kit    --project <dir> [--ffmpeg-path <path>] [--pretty]
  publish.mjs upload --project <dir> --client-secret <file> [--only <id,...>]
                     [--privacy unlisted|private] [--variant <name>] [--dry-run] [--force]

Reads <project>/video.json, <project>/edl.json, <project>/publish.json, and
<project>/render/<id>-overlay.mp4 (or <id>.mp4). Writes <project>/publish/:
<id>.md (title, description, tags, related video, pinned comment, schedule),
<id>-cover.jpg (the frame at coverSec), and README.md (the schedule).

upload sends each short to YouTube with the Data API (videos.insert, resumable),
unlisted by default, using publish.json's title, description, hashtags, and tags.
It needs a "Desktop app" OAuth client JSON (--client-secret, or the
YOUTUBE_OAUTH_CLIENT environment variable) and asks for consent in the browser
once; the refresh token is saved under ~/.config/youtube-shorts-publish (mode
600). publish.json must declare "madeForKids". --variant uploads
render/<id>-<variant>.mp4 instead of <id>-overlay.mp4. Finished uploads are
recorded in publish/uploads.json and skipped on later runs unless --force.
Public posting stays in YouTube Studio.
`;
var InputError = class extends Error {
  code = "INVALID_INPUT";
};
var DependencyError = class extends Error {
  code = "DEPENDENCY_MISSING";
};
var COMMANDS = {
  kit: ["project", "ffmpeg-path"],
  upload: ["project", "client-secret", "only", "privacy", "variant", "ffmpeg-path"]
};
var BOOLEANS = /* @__PURE__ */ new Set(["pretty", "dry-run", "force"]);
function parse(argv) {
  const command = argv[0];
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    throw new InputError(command ? `Unknown command: ${command}. Run with --help.` : "Missing command. Run with --help.");
  }
  const allowed = /* @__PURE__ */ new Set([...COMMANDS[command], "pretty", ...command === "upload" ? ["dry-run", "force"] : []]);
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index].replace(/^--/, "");
    if (!argv[index].startsWith("--") || !allowed.has(name)) {
      throw new InputError(`Unexpected argument: ${argv[index]}. Run with --help.`);
    }
    if (BOOLEANS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) throw new InputError(`--${name} requires a value.`);
    flags[name] = value;
    index += 1;
  }
  if (typeof flags.project !== "string") throw new InputError("--project is required.");
  return { command, flags };
}
async function readJson(path, what) {
  const text = await readFile4(path, "utf8").catch(() => {
    throw new InputError(`${what} not found at ${path}.`);
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`${what} at ${path} is not valid JSON.`);
  }
}
var exists = async (path) => (await stat2(path).catch(() => void 0))?.isFile() ?? false;
async function kit(flags, environment) {
  const project = resolve2(flags.project);
  const video = await readJson(join4(project, "video.json"), "video.json");
  const edl = await readJson(join4(project, "edl.json"), "edl.json");
  let plan;
  try {
    plan = parsePublishPlan(await readJson(join4(project, "publish.json"), "publish.json"));
  } catch (error) {
    throw error instanceof InputError ? error : new InputError(error.message);
  }
  const command = (typeof flags["ffmpeg-path"] === "string" ? flags["ffmpeg-path"] : void 0) ?? environment.FFMPEG_PATH ?? "ffmpeg";
  const ffmpeg = await resolveFfmpegExecutable(command, environment).catch(() => {
    throw new DependencyError("FFmpeg is required for cover frames. Install FFmpeg, set FFMPEG_PATH, or pass --ffmpeg-path.");
  });
  const episodeUrl = plan.episodeUrl ?? `https://youtu.be/${video.videoId}`;
  const directory = join4(project, "publish");
  await mkdir4(directory, { recursive: true });
  const issues = [];
  const output = [];
  for (const short of plan.shorts) {
    const overlay = join4(project, "render", `${short.id}-overlay.mp4`);
    const plain = join4(project, "render", `${short.id}.mp4`);
    const file = await exists(overlay) ? overlay : await exists(plain) ? plain : void 0;
    if (!file) {
      issues.push({ short: short.id, level: "error", message: `No rendered video at ${overlay} or ${plain}.` });
      continue;
    }
    const facts = await probeMaster(ffmpeg, file);
    const firstCut = edl.shorts?.find((item) => item.id === short.id)?.cuts?.[0]?.startMs;
    const moment = firstCut === void 0 ? episodeUrl : momentUrl(video.videoId, firstCut);
    const description = composeDescription(short, episodeUrl, moment);
    issues.push(...checkShort(short, description, video.videoId, facts));
    const coverSec = Math.min(Math.max(short.coverSec ?? 1, 0), Math.max(facts.durationSec - 0.1, 0));
    const cover = join4(directory, `${short.id}-cover.jpg`);
    await extractThumbnail(ffmpeg, file, Math.round(coverSec * 1e3), cover, facts.width);
    const related = short.relatedVideo ?? episodeUrl;
    const sheet = join4(directory, `${short.id}.md`);
    await writeFile3(sheet, publishSheet(short, description, related, cover, file));
    output.push({ id: short.id, title: short.title, video: file, cover, sheet, publishAt: short.publishAt, durationSec: Number(facts.durationSec.toFixed(1)) });
  }
  const schedule = [...output].sort((a, b) => (a.publishAt ?? "~").localeCompare(b.publishAt ?? "~"));
  await writeFile3(join4(directory, "README.md"), [
    "# Publishing schedule",
    "",
    "| When | Short | Title | Length |",
    "|---|---|---|---|",
    ...schedule.map((item) => `| ${item.publishAt ?? "unscheduled"} | ${item.id} | ${item.title.replaceAll("|", "\\|")} | ${item.durationSec}s |`),
    "",
    "Each short has a sheet (`<id>.md`) to paste into YouTube Studio and a cover frame (`<id>-cover.jpg`).",
    ""
  ].join("\n"));
  return { ok: !issues.some((issue) => issue.level === "error"), directory, shorts: output, issues };
}
async function upload(flags, environment, io, dependencies) {
  const project = resolve2(flags.project);
  const video = await readJson(join4(project, "video.json"), "video.json");
  const edl = await readJson(join4(project, "edl.json"), "edl.json");
  let plan;
  try {
    plan = parsePublishPlan(await readJson(join4(project, "publish.json"), "publish.json"));
  } catch (error) {
    throw error instanceof InputError ? error : new InputError(error.message);
  }
  if (typeof plan.madeForKids !== "boolean") {
    throw new InputError('publish.json must set "madeForKids" to true or false before uploading; it is a legal declaration YouTube requires, so ask the user.');
  }
  const privacy = flags.privacy ?? "unlisted";
  if (privacy !== "unlisted" && privacy !== "private") throw new InputError("--privacy must be unlisted or private. Publish publicly from YouTube Studio.");
  const only = typeof flags.only === "string" ? new Set(flags.only.split(",").map((id) => id.trim())) : void 0;
  const variant = typeof flags.variant === "string" ? flags.variant : void 0;
  if (variant !== void 0 && !/^[A-Za-z0-9_-]+$/.test(variant)) throw new InputError("--variant may use only letters, digits, - and _.");
  const shorts = plan.shorts.filter((short) => !only || only.has(short.id));
  if (only) {
    for (const id of only) if (!plan.shorts.some((short) => short.id === id)) throw new InputError(`publish.json has no short ${id}.`);
  }
  const command = (typeof flags["ffmpeg-path"] === "string" ? flags["ffmpeg-path"] : void 0) ?? environment.FFMPEG_PATH ?? "ffmpeg";
  const ffmpeg = await resolveFfmpegExecutable(command, environment).catch(() => {
    throw new DependencyError("FFmpeg is required to check each video before upload. Install FFmpeg, set FFMPEG_PATH, or pass --ffmpeg-path.");
  });
  const episodeUrl = plan.episodeUrl ?? `https://youtu.be/${video.videoId}`;
  const recordsPath = join4(project, "publish", "uploads.json");
  const records = await readFile4(recordsPath, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
  const queue = [];
  const issues = [];
  for (const short of shorts) {
    const candidates = variant ? [join4(project, "render", `${short.id}-${variant}.mp4`)] : [join4(project, "render", `${short.id}-overlay.mp4`), join4(project, "render", `${short.id}.mp4`)];
    let file;
    for (const candidate of candidates) if (await exists(candidate)) {
      file = candidate;
      break;
    }
    if (!file) {
      issues.push({ short: short.id, level: "error", message: `No video at ${candidates.join(" or ")}.` });
      continue;
    }
    const facts = await probeMaster(ffmpeg, file);
    const firstCut = edl.shorts?.find((item) => item.id === short.id)?.cuts?.[0]?.startMs;
    const description = composeDescription(short, episodeUrl, firstCut === void 0 ? episodeUrl : momentUrl(video.videoId, firstCut));
    issues.push(...checkShort(short, description, video.videoId, facts).filter((issue) => issue.level === "error"));
    const skipped = records[short.id] && flags.force !== true;
    queue.push({ short, file, description, skipped });
  }
  if (issues.length) return { ok: false, uploaded: [], issues };
  const planned = queue.map((item) => ({ id: item.short.id, title: item.short.title, file: item.file, privacy, skip: item.skipped ? `already uploaded: ${records[item.short.id].url}` : void 0 }));
  if (flags["dry-run"] === true) return { ok: true, dryRun: true, planned, issues };
  if (queue.every((item) => item.skipped)) {
    return { ok: true, uploaded: [], skipped: planned.filter((item) => item.skip), issues };
  }
  const secretPath = (typeof flags["client-secret"] === "string" ? flags["client-secret"] : void 0) ?? environment.YOUTUBE_OAUTH_CLIENT;
  if (!secretPath) throw new InputError("--client-secret (or YOUTUBE_OAUTH_CLIENT) must point to the Desktop app OAuth client JSON.");
  let client;
  try {
    client = parseClientSecret(await readJson(resolve2(secretPath), "OAuth client file"));
  } catch (error) {
    throw error instanceof AuthError || error instanceof InputError ? error : new InputError(error.message);
  }
  const fetchImpl = dependencies.fetch ?? fetch;
  const accessToken = await getAccessToken(client, tokenPath(client, environment), { fetch: fetchImpl, openUrl: dependencies.openUrl, notify: io.stderr });
  const uploaded = [];
  for (const item of queue) {
    if (item.skipped) continue;
    const { videoId } = await uploadVideo(fetchImpl, accessToken, item.file, {
      title: item.short.title.trim(),
      description: item.description,
      tags: item.short.tags ?? [],
      categoryId: plan.categoryId ?? "22",
      privacy,
      madeForKids: plan.madeForKids
    });
    const record = { videoId, url: `https://youtube.com/shorts/${videoId}`, privacy, file: item.file, uploadedAt: (/* @__PURE__ */ new Date()).toISOString() };
    records[item.short.id] = record;
    await mkdir4(join4(project, "publish"), { recursive: true });
    await writeFile3(recordsPath, `${JSON.stringify(records, null, 2)}
`);
    uploaded.push({ id: item.short.id, ...record });
  }
  return {
    ok: true,
    uploaded,
    skipped: planned.filter((item) => item.skip),
    next: "In YouTube Studio: pick each cover frame, set the related video, and post and pin the pinned comment.",
    issues
  };
}
function errorPayload(error) {
  if (error instanceof UploadError || error instanceof AuthError) {
    return { error: { code: error.code, message: error.message, retryable: error instanceof UploadError ? error.retryable : false } };
  }
  if (error instanceof InputError || error instanceof DependencyError || error instanceof MediaError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected failure.", retryable: false } };
}
async function runPublishCli(argv, io, environment = process.env, dependencies = {}) {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    io.stdout(HELP);
    return 0;
  }
  try {
    const { command, flags } = parse(argv);
    const result = command === "kit" ? await kit(flags, environment) : await upload(flags, environment, io, dependencies);
    io.stdout(`${JSON.stringify(result, null, flags.pretty === true ? 2 : void 0)}
`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify(errorPayload(error))}
`);
    return error instanceof InputError ? 2 : 1;
  }
}

// src/publish/entry.ts
process.exitCode = await runPublishCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
});
/* Bundled license notices

all-things-youtube
MIT License

Copyright (c) 2026 Himanshu Gupta

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---
he
Copyright Mathias Bynens <https://mathiasbynens.be/>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---
striptags
The MIT License (MIT)

Copyright (c) [2017] [Eric Norris]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---
undici
MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
