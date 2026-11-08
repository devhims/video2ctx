#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);

// src/publish/cli.ts
import { mkdir as mkdir3, readFile as readFile2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join3, resolve as resolve2 } from "node:path";

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

// src/publish/cli.ts
var HELP = `youtube-shorts-publish

Check publishing copy for rendered Shorts against YouTube's limits and write a
copy-paste sheet and cover frame per short. Prints one JSON value.

Usage:
  publish.mjs kit --project <dir> [--ffmpeg-path <path>] [--pretty]

Reads <project>/video.json, <project>/edl.json, <project>/publish.json, and
<project>/render/<id>-overlay.mp4 (or <id>.mp4). Writes <project>/publish/:
<id>.md (title, description, tags, related video, pinned comment, schedule),
<id>-cover.jpg (the frame at coverSec), and README.md (the schedule).
`;
var InputError = class extends Error {
  code = "INVALID_INPUT";
};
var DependencyError = class extends Error {
  code = "DEPENDENCY_MISSING";
};
function parse(argv) {
  if (argv[0] !== "kit") throw new InputError(argv[0] ? `Unknown command: ${argv[0]}. Run with --help.` : "Missing command. Run with --help.");
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index].replace(/^--/, "");
    if (!argv[index].startsWith("--") || !["project", "ffmpeg-path", "pretty"].includes(name)) {
      throw new InputError(`Unexpected argument: ${argv[index]}. Run with --help.`);
    }
    if (name === "pretty") {
      flags.pretty = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) throw new InputError(`--${name} requires a value.`);
    flags[name] = value;
    index += 1;
  }
  if (typeof flags.project !== "string") throw new InputError("--project is required.");
  return flags;
}
async function readJson(path, what) {
  const text = await readFile2(path, "utf8").catch(() => {
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
  const video = await readJson(join3(project, "video.json"), "video.json");
  const edl = await readJson(join3(project, "edl.json"), "edl.json");
  let plan;
  try {
    plan = parsePublishPlan(await readJson(join3(project, "publish.json"), "publish.json"));
  } catch (error) {
    throw error instanceof InputError ? error : new InputError(error.message);
  }
  const command = (typeof flags["ffmpeg-path"] === "string" ? flags["ffmpeg-path"] : void 0) ?? environment.FFMPEG_PATH ?? "ffmpeg";
  const ffmpeg = await resolveFfmpegExecutable(command, environment).catch(() => {
    throw new DependencyError("FFmpeg is required for cover frames. Install FFmpeg, set FFMPEG_PATH, or pass --ffmpeg-path.");
  });
  const episodeUrl = plan.episodeUrl ?? `https://youtu.be/${video.videoId}`;
  const directory = join3(project, "publish");
  await mkdir3(directory, { recursive: true });
  const issues = [];
  const output = [];
  for (const short of plan.shorts) {
    const overlay = join3(project, "render", `${short.id}-overlay.mp4`);
    const plain = join3(project, "render", `${short.id}.mp4`);
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
    const cover = join3(directory, `${short.id}-cover.jpg`);
    await extractThumbnail(ffmpeg, file, Math.round(coverSec * 1e3), cover, facts.width);
    const related = short.relatedVideo ?? episodeUrl;
    const sheet = join3(directory, `${short.id}.md`);
    await writeFile2(sheet, publishSheet(short, description, related, cover, file));
    output.push({ id: short.id, title: short.title, video: file, cover, sheet, publishAt: short.publishAt, durationSec: Number(facts.durationSec.toFixed(1)) });
  }
  const schedule = [...output].sort((a, b) => (a.publishAt ?? "~").localeCompare(b.publishAt ?? "~"));
  await writeFile2(join3(directory, "README.md"), [
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
function errorPayload(error) {
  if (error instanceof InputError || error instanceof DependencyError || error instanceof MediaError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected failure.", retryable: false } };
}
async function runPublishCli(argv, io, environment = process.env) {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    io.stdout(HELP);
    return 0;
  }
  try {
    const flags = parse(argv);
    const result = await kit(flags, environment);
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
