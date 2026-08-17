<div align="center">

# all-things-youtube

**TypeScript toolkit for YouTube data.**

Search YouTube and get transcripts/captions, comments, video details, channels, playlists, and more.

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![API key](https://img.shields.io/badge/API%20key-not%20required-2ea44f)](#scope-and-stability)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/devhims/video2ctx/blob/main/packages/all-things-youtube/LICENSE)

[Website](https://video2ctx.dev/) · [Quick start](#quick-start) · [API](#api-at-a-glance) · [Pagination](#pagination) · [Reliability](#retries-and-rate-limits) · [Hosting](#using-the-library-vs-hosting-an-api)

</div>

## Why this package?

YouTube exposes useful public data across several different page experiences. `all-things-youtube` gives that data one small, task-oriented interface:

- **One import, ten focused functions:** Search or get exactly the resource you need instead of constructing a large client or learning a raw response format.
- **Translation made simple:** Call `getTranscript()` with your desired output language. Supports 150+ languages when available.
- **Complete channel and playlist data:** Channel About links and statistics, channel sorting, playlist cards, and continuation-based pagination are represented directly.
- **Bounded networking by default:** Each attempt has a ten-second deadline; transient failures and `429` responses use bounded exponential backoff with jitter and `Retry-After` support.
- **Types included:** Request, response, pagination, retry, and error types ship with the package.

Built for backend services, content tools, research workflows, accessibility products, AI pipelines, and server-side automation.

## Installation

```sh
npm install all-things-youtube
```

Requires Node.js 18 or newer. The package uses the runtime's standard `fetch`; you can supply your own implementation when needed.

The optional `all-things-youtube/watch` entry point uses a system FFmpeg executable for exact frames. Storyboard and transcript indexing does not require FFmpeg.

> Keep calls server-side. Direct browser calls are commonly blocked by CORS and make every user's browser responsible for upstream rate limits.

## Quick start

```ts
import { getTranscript } from 'all-things-youtube';

const transcript = await getTranscript({
  videoId: 'S4tdkSVuxZA',
  lang: 'hi',
});

console.log(transcript.translatedTo); // { languageCode: 'hi', name: 'Hindi' }
console.log(transcript.text);
```

`lang` is the desired output language. The package chooses a source caption track and requests translation only when it is needed and available.

An abridged response looks like this:

```json
{
  "videoId": "S4tdkSVuxZA",
  "track": {
    "id": ".en",
    "name": "English",
    "languageCode": "en",
    "kind": "manual",
    "isTranslatable": true,
    "isDefault": true
  },
  "translatedTo": {
    "languageCode": "hi",
    "name": "Hindi"
  },
  "segments": [
    {
      "startMs": 1200,
      "durationMs": 2800,
      "endMs": 4000,
      "text": "…"
    }
  ],
  "granularity": "segment",
  "text": "…",
  "meta": {
    "source": "allthingsyoutube",
    "fetchedAt": "2026-08-07T05:30:00.000Z",
    "partial": false,
    "warnings": []
  }
}
```

## API at a glance

All functions are named exports and accept a single options object.

| Resource          | Function                | Returns                                            |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Search            | `search()`              | Paginated videos, channels, and playlists          |
| Caption catalog   | `getTracks()`           | Source tracks and available translation languages  |
| Transcript        | `getTranscript()`       | Full text plus timed segments or words             |
| Comments          | `getComments()`         | One page or a bounded complete collection          |
| Video             | `getDetails()`          | Core metadata, channel, keywords, and availability |
| End screen        | `getEndscreen()`        | Timed video, playlist, and channel elements        |
| Channel           | `getChannelInfo()`      | Identity and the public About view                 |
| Channel videos    | `getChannelVideos()`    | One sorted, paginated Videos-tab page              |
| Channel playlists | `getChannelPlaylists()` | One sorted, paginated Playlists-tab page           |
| Playlist          | `getPlaylist()`         | Playlist metadata and one page of videos           |
| Watch index       | `getWatchIndex()`       | Timed transcript and storyboard contact sheets     |
| Exact frames      | `extractFrames()`       | Best-effort timestamped JPEG files                  |

The original task functions remain on the main entry point. The two visual functions are exported from `all-things-youtube/watch`.

## Visual context

Use the storyboard/transcript index to choose focused timestamps before decoding exact frames:

```ts
import { getWatchIndex, extractFrames } from 'all-things-youtube/watch';

const outputDir = '/tmp/youtube-watch';
const index = await getWatchIndex({
  videoId: '4vItmdk8F_M',
  outputDir,
  granularity: 'segment',
});

for (const sheet of index.storyboard?.sheets ?? []) {
  console.log(sheet.path, sheet.firstFrameIndex, sheet.intervalMs);
}

const result = await extractFrames({
  videoId: index.videoId,
  timestampsMs: [30_000, 686_000],
  outputDir,
  maxWidth: 1280,
});

console.log(result.frames);
console.log(result.failures);
```

`getWatchIndex()` returns complete contact-sheet paths and tile mappings without exposing YouTube's storyboard URLs. Transcript timing defaults to segments; pass `granularity: 'word'` only when word timing is necessary.

`extractFrames()` accepts one to 30 timestamps, uses the best seekable public media format, and may fall back below 720p. It keeps signed media URLs in memory, gives FFmpeg a localhost proxy URL, and returns successful frames alongside per-timestamp failures. Install FFmpeg on `PATH`, set `FFMPEG_PATH`, or pass `ffmpegPath`.

## Working with responses

### IDs, handles, and URLs

- Search accepts a text `query`; extraction functions use the returned IDs.
- Video functions accept an 11-character `videoId`.
- Playlist functions accept a `playlistId`.
- Channel functions accept either a channel ID or an `@handle`.
- Pass IDs, not full YouTube URLs.

### Optional fields

YouTube does not display every field for every resource. Fields such as view counts, publish text, thumbnails, links, and durations are optional where the upstream page can omit them.

### Display text and numeric values

Where useful, responses preserve both forms:

- `viewCount` is convenient for computation.
- `viewCountText` preserves the value displayed by YouTube.

The same convention is used for subscriber, video, reply, and playlist counts.

### Response metadata

Resource objects include:

```ts
interface SourceMetadata {
  source: 'allthingsyoutube';
  fetchedAt: string;
  partial: boolean;
  warnings: string[];
}
```

Check `meta.partial` and `meta.warnings` when completeness matters. A partial response is still usable, but a tab, sort order, or optional section may not have been available.

## API reference

### `search(options)`

Searches YouTube and returns normalized videos, channels, and playlists.

```ts
import { search } from 'all-things-youtube';

const page = await search({
  query: 'agent skills',
  type: 'video',
  captionsOnly: true,
});

console.log(page.videos);
console.log(page.continuation);
```

| Option         | Type                                      | Required | Description                                  |
| -------------- | ----------------------------------------- | -------- | -------------------------------------------- |
| `query`        | `string`                                  | Yes      | YouTube search text                          |
| `type`         | `'video' \| 'channel' \| 'playlist' \| 'all'` | No       | Keep one result type                         |
| `channelId`    | `string`                                  | No       | Keep videos from one channel                 |
| `duration`     | `'short' \| 'medium' \| 'long'`          | No       | Keep videos in one duration range            |
| `captionsOnly` | `boolean`                                 | No       | Keep videos that advertise captions          |
| `live`         | `'live' \| 'completed'`                   | No       | Keep live or non-live results                 |
| `minViews`     | `number`                                  | No       | Keep videos at or above this view count      |
| `sort`         | `'relevance' \| 'views'`                  | No       | Preserve relevance or sort parsed results by views |
| `continuation` | `string`                                  | No       | Opaque token returned by the previous page   |

Return a continuation only to the same query and filter set. Set an explicit page or item budget when following multiple pages.

### `getTracks(options)`

Returns the caption tracks attached to a video and the languages available for automatic translation.

```ts
import { getTracks } from 'all-things-youtube';

const catalog = await getTracks({ videoId: 'S4tdkSVuxZA' });

console.log(catalog.sourceTracks);
console.log(catalog.autoTranslationTargets);
console.log(catalog.defaultTrackId);
```

| Option    | Type     | Required | Description      |
| --------- | -------- | -------- | ---------------- |
| `videoId` | `string` | Yes      | YouTube video ID |

The result is a `CaptionTrackList`. `sourceTracks` describes uploaded and automatically generated tracks; `autoTranslationTargets` is the complete translation catalog advertised for that video's caption system.

### `getTranscript(options)`

Returns a transcript as combined text and timed segments.

```ts
import { getTranscript } from 'all-things-youtube';

const transcript = await getTranscript({
  videoId: 'S4tdkSVuxZA',
  lang: 'hi',
  granularity: 'word',
});

for (const segment of transcript.segments) {
  console.log(segment.startMs, segment.endMs, segment.text);

  for (const word of segment.words ?? []) {
    console.log(word.startMs, word.text);
  }
}
```

| Option        | Type                  | Required | Default         | Description                                               |
| ------------- | --------------------- | -------- | --------------- | --------------------------------------------------------- |
| `videoId`     | `string`              | Yes      | —               | YouTube video ID                                          |
| `lang`        | `string`              | No       | Source language | Desired output language code, such as `en`, `es`, or `hi` |
| `granularity` | `'segment' \| 'word'` | No       | `'segment'`     | Include word-level timing when requested                  |

Omit `lang` to return the default source track. Supplying `lang` asks for that output language regardless of whether the source captions are English, Spanish, or another supported language. If translation is unavailable, the call rejects with `INVALID_INPUT`.

### `getComments(options)`

Fetch one page for interactive pagination, or crawl the available thread and reply pages in one call.

```ts
import { getComments } from 'all-things-youtube';

const page = await getComments({ videoId: 'S4tdkSVuxZA' });

const collection = await getComments({
  videoId: 'S4tdkSVuxZA',
  all: true,
  maxPages: 100,
});

console.log(collection.totalCount); // displayed count, when available
console.log(collection.comments.length); // comments actually returned
console.log(collection.complete); // whether every discovered page was visited
```

| Option         | Type      | Required | Default | Description                                        |
| -------------- | --------- | -------- | ------- | -------------------------------------------------- |
| `videoId`      | `string`  | Yes      | —       | YouTube video ID                                   |
| `continuation` | `string`  | No       | —       | Opaque token returned by a previous page           |
| `all`          | `boolean` | No       | `false` | Crawl discovered comment and reply pages           |
| `maxPages`     | `number`  | No       | `100`   | Page budget for `all: true`; clamped from 1 to 500 |

Page mode returns `CommentsPage`; collection mode returns `CommentsCollection` with `complete`, `pagesFetched`, `topLevelCount`, `replyCount`, and `remainingContinuations`.

With `all: true`, top-level comment pages are visited before reply pages. On large videos, `maxPages` may be reached before replies are fetched; check `complete`, `replyCount`, and `remainingContinuations`.

`totalCount` is YouTube's displayed total when available. It can be greater than the number returned because the displayed count may include deleted, moderated, or unavailable threads. No extra request is made solely to calculate that value.

### `getDetails(options)`

Returns compact video metadata without attaching the larger subresources.

```ts
import { getDetails } from 'all-things-youtube';

const video = await getDetails({ videoId: 'S4tdkSVuxZA' });

console.log(video.title);
console.log(video.channel);
console.log(video.durationSeconds);
console.log(video.viewCount);
console.log(video.availability);
```

The `Video` result includes description, channel, thumbnails, duration, publish and view information, live/caption flags, keywords, canonical URL, and playability. Tracks, transcripts, comments, and end-screen elements remain separate calls so you only pay for what you request.

`availability.isPrivate` is `true` only when YouTube explicitly identifies the video as private. A `false` value does not prove the video is public; also check `availability.status`, `availability.reason`, and `meta.partial`.

### `getEndscreen(options)`

Returns the interactive cards configured for the end of a video.

```ts
import { getEndscreen } from 'all-things-youtube';

const elements = await getEndscreen({ videoId: 'S4tdkSVuxZA' });

for (const element of elements) {
  console.log(element.type, element.startMs, element.endMs);
  console.log(element.videoId ?? element.playlistId ?? element.channelId);
}
```

Elements include timing, type, destination IDs, thumbnails, and optional layout coordinates. Videos without an end screen return an empty array.

### `getChannelInfo(options)`

Returns channel identity and the public information shown in its About view.

```ts
import { getChannelInfo } from 'all-things-youtube';

const channel = await getChannelInfo({ channelId: '@AltShiftX' });

console.log(channel.name, channel.handle);
console.log(channel.about.description);
console.table(channel.about.links);
console.log(channel.about.moreInfo);
```

| Option      | Type     | Required | Description             |
| ----------- | -------- | -------- | ----------------------- |
| `channelId` | `string` | Yes      | Channel ID or `@handle` |

`about.links` contains each link's title, display URL, and direct external URL. `about.moreInfo` includes the canonical channel URL, join date, subscriber/video/view counts, and whether a public business-email action is present. It does not attempt to reveal an email address behind an account gate.

### `getChannelVideos(options)`

Returns one page from a channel's Videos tab.

```ts
import { getChannelVideos } from 'all-things-youtube';

const page = await getChannelVideos({
  channelId: '@AltShiftX',
  sort: 'popular',
});

console.log(page.videos);
console.log(page.continuation);
```

| Option         | Type                                | Required | Default    | Description             |
| -------------- | ----------------------------------- | -------- | ---------- | ----------------------- |
| `channelId`    | `string`                            | Yes      | —          | Channel ID or `@handle` |
| `sort`         | `'latest' \| 'popular' \| 'oldest'` | No       | `'latest'` | Videos-tab sort order   |
| `continuation` | `string`                            | No       | —          | Token for the next page |

Keep the same `sort` when using a continuation. The returned `sort` records the order actually applied; check `meta.warnings` if a channel did not offer the requested order.

### `getChannelPlaylists(options)`

Returns one page from a channel's Playlists tab.

```ts
import { getChannelPlaylists } from 'all-things-youtube';

const page = await getChannelPlaylists({
  channelId: '@AltShiftX',
  sort: 'last-video-added',
});
```

| Option         | Type                             | Required | Default    | Description              |
| -------------- | -------------------------------- | -------- | ---------- | ------------------------ |
| `channelId`    | `string`                         | Yes      | —          | Channel ID or `@handle`  |
| `sort`         | `'newest' \| 'last-video-added'` | No       | `'newest'` | Playlists-tab sort order |
| `continuation` | `string`                         | No       | —          | Token for the next page  |

Playlist cards include the displayed video or episode count, update text when shown, podcast state, canonical URL, and playback URL when available.

### `getPlaylist(options)`

Returns playlist metadata and one page of its videos.

```ts
import { getPlaylist } from 'all-things-youtube';

const playlist = await getPlaylist({
  playlistId: 'PLn6yDpEottdgtKuLDWNMMLAhmxE2DgygM',
});

console.log(playlist.title, playlist.videoCount);
console.log(playlist.videos);
```

| Option         | Type     | Required | Description             |
| -------------- | -------- | -------- | ----------------------- |
| `playlistId`   | `string` | Yes      | YouTube playlist ID     |
| `continuation` | `string` | No       | Token for the next page |

## Pagination

A `continuation` is an opaque cursor for the next page. It is not a page number, should not be decoded or modified, and may expire. Store it only as long as your pagination flow needs it.

```ts
import { getChannelVideos, type VideoSummary } from 'all-things-youtube';

const videos: VideoSummary[] = [];
let continuation: string | undefined;

do {
  const page = await getChannelVideos({
    channelId: '@AltShiftX',
    sort: 'latest',
    continuation,
  });

  videos.push(...page.videos);
  continuation = page.continuation;
} while (continuation && videos.length < 200);
```

Always set your own page or item budget. It controls latency, memory use, and the number of upstream requests.

## Shared options

Every function also accepts these optional settings:

```ts
interface LibraryOptions {
  fetch?: typeof fetch;
  language?: string;
  region?: string;
  retry?: YouTubeRetryOptions;
}
```

| Option     | Default            | Purpose                                                   |
| ---------- | ------------------ | --------------------------------------------------------- |
| `fetch`    | `globalThis.fetch` | Custom networking, proxying, testing, or observability    |
| `language` | `'en'`             | Locale for YouTube interface text and display values      |
| `region`   | `'US'`             | Region used for localized availability and display values |
| `retry`    | See below          | Retry policy, hooks, and test controls                    |

`language` controls the interface locale; transcript `lang` controls the desired transcript language. They serve different purposes.

### Custom `fetch`

```ts
const video = await getDetails({
  videoId: 'S4tdkSVuxZA',
  fetch: async (input, init) => {
    const startedAt = Date.now();
    const response = await fetch(input, init);
    console.log(response.status, Date.now() - startedAt, 'ms');
    return response;
  },
});
```

The supplied function must follow the standard `fetch` signature, forward `init.signal`, and return a `Response`. Forwarding the signal preserves the transport's request deadline.

## Retries and rate limits

Retries are enabled for network failures and these statuses by default:

```txt
408  425  429  500  502  503  504
```

The default policy gives each attempt a ten-second deadline, makes up to five attempts, applies exponential backoff with full jitter, caps delays at two seconds, and honors `Retry-After` within that cap. A timed-out attempt is retried as a network failure; exhausted timeouts reject with a retryable `UPSTREAM_ERROR`.

```ts
import { getDetails } from 'all-things-youtube';

const video = await getDetails({
  videoId: 'S4tdkSVuxZA',
  retry: {
    policy: {
      maxAttempts: 6,
      attemptTimeoutMs: 15_000,
      baseDelayMs: 300,
      maxDelayMs: 5_000,
    },
    onRetry(event) {
      console.warn(
        `Retrying ${event.operation}: attempt ${event.attempt}/${event.maxAttempts}`,
        { status: event.status, delayMs: event.delayMs, reason: event.reason },
      );
    },
  },
});
```

Retries reduce short-lived failures; they cannot guarantee that a request will never end in `429`. Shared datacenter and serverless IP ranges can remain throttled. In production, combine bounded retries with caching, request deduplication, concurrency limits, and controlled egress where appropriate.

## Error handling

Calls reject with `YouTubeClientError` for classified library and upstream failures.

```ts
import { getDetails, YouTubeClientError } from 'all-things-youtube';

try {
  await getDetails({ videoId: 'invalid' });
} catch (error) {
  if (error instanceof YouTubeClientError) {
    console.error(error.code); // INVALID_INPUT
    console.error(error.status); // HTTP status, when applicable
    console.error(error.retryable); // whether retrying may succeed
  }

  throw error;
}
```

| Code               | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `INVALID_INPUT`    | A required ID or option is invalid, or a requested translation is unavailable |
| `NOT_FOUND`        | The resource or caption track was not found                                   |
| `UNAVAILABLE`      | The resource exists but cannot be accessed or played                          |
| `AUTH_REQUIRED`    | The resource requires a signed-in account                                     |
| `RATE_LIMITED`     | Upstream rate limiting remained after retries                                 |
| `UPSTREAM_ERROR`   | A remote or network operation failed                                          |
| `INVALID_RESPONSE` | The upstream response could not be parsed safely                              |

When every network attempt fails, the library rejects with a retryable `UPSTREAM_ERROR` and preserves the original network error as `cause`.

## Using the library vs hosting an API

Installing the package means your server code calls its functions directly:

```txt
your server code  →  all-things-youtube  →  YouTube
```

The package does not open a port, run a daemon, or create HTTP routes. To “host it,” wrap the functions in routes owned by your application:

```ts
import { getTranscript, YouTubeClientError } from 'all-things-youtube';

export async function handleTranscriptRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('videoId');
  const lang = url.searchParams.get('lang') ?? undefined;

  if (!videoId) {
    return Response.json({ error: 'videoId is required' }, { status: 400 });
  }

  try {
    const transcript = await getTranscript({ videoId, lang });
    return Response.json(transcript);
  } catch (error) {
    if (error instanceof YouTubeClientError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status ?? 502 },
      );
    }
    throw error;
  }
}
```

That handler can be mounted in Express, Fastify, Hono, Next.js, a serverless function, or a Worker. Your application remains responsible for authentication, quotas, caching, validation, and public API versioning.

## TypeScript and module usage

All public request and response types are exported from the package root:

```ts
import {
  getComments,
  type CommentsCollection,
  type Transcript,
  type Video,
} from 'all-things-youtube';
```

There is no default export. CommonJS is also supported:

```js
const { getDetails, getTranscript } = require('all-things-youtube');
```

## Local development

From this package directory:

```sh
npm test
npm run build
```

The regular suite uses deterministic fixtures and does not depend on live YouTube responses. Run the opt-in live contract test with:

```sh
YOUTUBE_LIVE=1 npm test
```

Live tests are best treated as integration checks: upstream availability, localization, and rate limiting can vary by network and time.

## Scope and stability

- Public data only; private videos, account gates, and regional restrictions are not bypassed.
- No YouTube Data API key or OAuth setup is required.

## Support the project

`all-things-youtube` is open source and independently maintained as part of [video2ctx](https://video2ctx.dev/). If it brings value to your work, [starring the repository](https://github.com/devhims/video2ctx) is a simple way to support its continued development.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by YouTube or Google. YouTube is a trademark of Google LLC. Use the package in accordance with the policies and laws that apply to your project.

## License

[MIT](https://github.com/devhims/video2ctx/blob/main/packages/all-things-youtube/LICENSE)
