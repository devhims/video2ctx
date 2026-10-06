# UI API Reference

This document inventories the APIs currently called by the web UI. It is derived from the client calls in `web/app/dashboard/page.tsx`, the same-origin proxy in `web/app/api/platform/[...path]/route.ts`, and the Hono route groups in `platform/src/routes`.

## Request path

The browser does not call the platform Worker directly:

```text
Browser
  → /api/platform/* on the Next.js app
  → Cloudflare PLATFORM service binding in production
    or http://localhost:8787 in local development
  → versioned /v1/* route on the platform Worker
```

- Browser base path: `/api/platform`
- Direct local platform base URL: `http://localhost:8787`
- API format: JSON unless noted otherwise
- Private routes: Better Auth session cookie required
- Local development: `x-demo-user` creates a stable demo user when `ENVIRONMENT` is not `production`
- Public protection: selected discovery routes use a Cloudflare rate limiter; `/v1/resolve` also requires Turnstile in production
- Landing proof: `POST /v1/demo/youtube/inspect` is anonymous and allows five distinct videos per visitor in a rolling 24-hour window
- Errors: `{ "error": { "code": string, "message": string, "details"?: unknown, "requestId"?: string } }`
- Traceability: every platform response receives an `X-Request-Id` header

## Current UI request sequence

### Application startup

The UI loads these requests concurrently:

1. `GET /v1/projects`
2. `GET /v1/monitors`
3. `GET /v1/browse?provider=youtube`
4. `GET /v1/trends?provider=youtube&q=AI%20agents&limit=20` from the default Trend Lab view

### Search and inspection

1. The search box sends its value to `POST /v1/resolve`.
2. A recognized YouTube URL or video ID opens the matching entity endpoint directly.
3. Provider discovery uses `GET /v1/search?provider=youtube`; private evidence uses `GET /v1/projects/{projectId}/search`; cited questions use `POST /v1/projects/{projectId}/answers`.
4. Opening a video loads its entity record, transcript, and comments. Transcript or comment failure does not prevent the main video record from opening.

### Saving a source

1. The UI uses the project the item was opened from, otherwise the most recent project, or creates a “Research inbox” with `POST /v1/projects`.
2. It saves the source with `POST /v1/projects/:id/items`. A repeated whole-source or moment save returns the existing item (`200`, `existing: true`), including a whole source the project already holds as a project source row.
3. It retains the displayed data with `PUT /v1/projects/:id/sources/items/:itemId/snapshot`, copying the exact Recent revision. A failure keeps a retry for that project and item.
4. Saving starts no import or provider fetch. Adding sources from within a project (`POST /v1/sources/recent` with `projectId`) retains references with the existing whole-source item when present. Extra comments pages are retained through `POST /v1/sources/recent/:id/comments`; storage retries never repeat the provider request.
5. Opening any project item later uses `GET /v1/projects/:id/sources/items/:itemId`, which reads storage only and is free. Missing data offers only a storage retry, with no paid recovery.

### Trend planning

1. `GET /v1/trends?provider=youtube` calculates topic signals from public YouTube data, stores metric snapshots, and adds evidence-grounded GLM insights by default.
2. The user can explicitly call `POST /v1/trends/plan` to turn those signals into a Kimi-generated plan. A normal topic scan does not consume user AI credits.

## API summary

| Method | Platform route | UI purpose | Access |
| --- | --- | --- | --- |
| `GET/POST` | `/api/auth/*` | Email and Google sign-in | Public |
| `GET` | `/v1/projects` | Load project sidebar and project view | Private |
| `POST` | `/v1/projects` | Create a project | Private |
| `POST` | `/v1/projects/:id/items` | Save a source or transcript into a project | Private |
| `GET` | `/v1/monitors` | Load monitor view and counts | Private |
| `POST` | `/v1/monitors` | Monitor the inspected channel or topic | Private |
| `GET` | `/v1/providers` | List supported providers and capabilities | Authenticated |
| `GET` | `/v1/browse?provider=youtube` | Seed the source inbox | Authenticated, rate-limited |
| `POST` | `/v1/resolve` | Internal universal-input routing helper | First-party UI, protected |
| `POST` | `/v1/demo/youtube/inspect` | Bounded video, transcript, and comments preview | Public landing page, IP quota |
| `GET` | `/v1/search?provider=youtube` | Search YouTube | Authenticated, rate-limited |
| `GET` | `/v1/projects/{projectId}/search` | Search private indexed evidence | Authenticated |
| `GET` | `/v1/videos/:id?provider=youtube` | Inspect a video | Authenticated |
| `GET` | `/v1/channels/:id?provider=youtube` | Inspect a channel | Authenticated |
| `GET` | `/v1/channels/:id/videos?provider=youtube` | Load a channel's videos | Authenticated |
| `GET` | `/v1/channels/:id/playlists?provider=youtube` | Load a channel's playlists | Authenticated |
| `GET` | `/v1/playlists/:id?provider=youtube` | Inspect a playlist | Authenticated |
| `GET` | `/v1/videos/:id/transcript?provider=youtube` | Load timed transcript evidence | Authenticated |
| `GET` | `/v1/videos/:id/comments?provider=youtube` | Load audience comments | Authenticated |
| `POST` | `/v1/imports` | Start durable ingestion and indexing | Private |
| `POST` | `/v1/projects/{projectId}/answers` | Generate a cited answer from project evidence | Browser-session only, metered |
| `GET` | `/v1/trends?provider=youtube` | Calculate topic momentum and patterns | Authenticated, rate-limited |
| `POST` | `/v1/trends/plan` | Generate an evidence-grounded video plan | Private, metered |

## Authentication APIs

### `POST /api/auth/sign-in/magic-link`

Sends the email sign-in link used by the sign-in dialog.

```json
{
  "email": "creator@example.com",
  "callbackURL": "/"
}
```

How it works:

- Better Auth creates a hashed, single-use token with a 15-minute expiry.
- The platform queues the email through `EMAIL_TASKS`; provider work does not block the request.
- Following the link establishes the session cookie used by private `/v1` routes.

### `POST /api/auth/sign-in/social`

Starts the Google sign-in flow.

```json
{
  "provider": "google",
  "callbackURL": "/"
}
```

The response includes a redirect `url`. Better Auth handles the OAuth callback and session creation.

## UI helper APIs

These routes support first-party interface behavior and are not primary public consumer APIs.

### `POST /v1/demo/youtube/inspect`

The public landing page sends `{ "url": "https://www.youtube.com/watch?v=..." }` through its same-origin platform proxy. The response includes normalized video metadata, channel details, up to 16 timestamped transcript segments, up to 12 comments, partial-data status, and the visitor's current quota.

The quota is five distinct YouTube video IDs per HMAC-hashed IP in the trailing 24 hours. Repeating a video in that window does not consume another slot. Upstash Redis evaluates the cleanup, duplicate check, count, and insert atomically. Production requests fail closed if Redis or the hashing salt is unavailable.

#### Saved homepage samples

The three sample IDs (`bAX27XRHMH8`, `eC7xzavzEKY`, `Vyb-sTrY_Y8`) use complete snapshots in the existing `VIDEO_ASSETS` R2 bucket under `landing-samples/v1/<id>.json`. URL normalization happens first, so pasted watch, short-link, and Shorts URLs use the same snapshot. Other videos retain ordinary inspection behavior.

Each snapshot contains video details, channel details, the transcript excerpt, comments, and the displayed thumbnail and avatars as inline image data. Only the largest displayed image variant is retained. Image capture allows HTTPS YouTube image hosts, rejects redirects and non-image content types, caps each image at 256 KiB, and shares an eight-second download deadline. The whole snapshot is capped at 4 MiB. Video playback still creates a YouTube embed only after Play is clicked.

Snapshots have no age-based refresh and are independent of the shared video catalog. The Worker Cache API keeps a public copy for one day; the mounted homepage also reuses successful sample results for repeated submissions. The POST response remains `no-store`, and visitor quota is attached after reading storage, never saved in R2 or the edge cache. A saved result includes `samplePreview: true`, which displays the Sample Preview badge beside the title. Fallback responses omit the flag and are not retained by the page.

A missing snapshot uses the ordinary provider path and saves the first complete inspection with a conditional create. Concurrent first visits return the saved winner. Partial data or failed image capture is returned without being saved, allowing a later visit to retry. R2 read errors or invalid snapshots use provider extraction directly, bypassing the shared catalog so the fallback does not require the failed R2 service. An edge-cache failure alone still allows an R2 read. These fallbacks require the Worker, quota service, and extraction backend to remain available.

No migration, new binding, or remote seed command is required. After deployment, inspect each of the three samples once and confirm `samplePreview: true`, then repeat to verify storage reuse. Production seeding and validation remain rollout steps. To deliberately replace saved examples, bump the version prefix in `landing-samples.ts`; this also changes the edge-cache namespace. Normal API refreshes elsewhere do not modify the snapshots. A malformed existing snapshot requires repair or a version bump rather than automatic overwrite.

### `POST /v1/resolve`

Classifies the universal search-box input before the UI decides what to open.

```json
{ "input": "https://www.youtube.com/watch?v=VIDEO_ID" }
```

Possible responses:

```json
{ "kind": "video", "id": "VIDEO_ID" }
```

```json
{ "kind": "channel", "id": "@handle" }
```

```json
{ "kind": "playlist", "id": "PLAYLIST_ID" }
```

```json
{ "kind": "search", "query": "plain text query" }
```

How it works:

- Uses deterministic parsing rather than AI.
- Recognizes 11-character video IDs, `youtu.be`, watch, Shorts, live, playlist, channel, and handle URLs.
- Rejects non-YouTube URLs and malformed identifiers.

## Discovery APIs

### `GET /v1/browse?provider=youtube`

Seeds the source inbox with a normalized public YouTube discovery feed.

Query parameters:

- `category`: required; `music`, `news`, `sports`, or `live`
- `region`: `US` or `IN`; defaults to `US`
- `language`: `en` or `hi`; defaults to `en`
- `continuation`: opaque pagination token

How it works:

- Calls the platform's normalized YouTube browse adapter; it does not use the official YouTube Data API.
- Uses current public YouTube destination IDs rather than the retired anonymous Trending feed.
- Normalizes videos, channels, and playlists into application entities.
- Returns both a mixed `results` list and explicit `videos`, `channels`, and `playlists` arrays.
- Caches each option set in Workers KV for five minutes.
- Returns a stale cached snapshot if the upstream call fails and a previous snapshot exists.

### `GET /v1/search?provider=youtube`

Searches one external video provider. The current supported value for `provider` is `youtube`.

Parameters:

- `q`: required query

Additional filters:

- `type`: `all`, `video`, `channel`, or `playlist`
- `channel`: channel ID
- `language`: language code
- `duration`: `short`, `medium`, or `long`
- `sort`: `relevance`, `date`, `views`, or `rating`
- `captions=true`: videos with captions only
- `live`: `live`, `upcoming`, or `completed`
- `continuation`: opaque token returned by the previous YouTube search page

How it works:

- Calls the platform's YouTube search adapter and returns one mixed `results` array of videos, channels, and playlists. Each item has a `type` discriminator.
- Preserves YouTube's interleaved result order and returns a continuation token when another page is available.
- Caches the query/filter combination in Workers KV for five minutes with stale fallback.
- The UI currently exposes type, duration, and captions filters.

### `GET /v1/projects/{projectId}/search`

Searches transcript and research content previously saved by the user.

Parameters:

- `q`: required query
- `projectId`: required owned project ID in the path

How it works:

- Verifies that the authenticated user owns the project.
- Queries the user’s isolated Cloudflare AI Search instance.
- Uses hybrid keyword/vector retrieval, reciprocal-rank fusion, and BGE reranking.
- Always filters to the path project and returns up to 12 evidence chunks with scores, source IDs, and timestamps.

### `POST /v1/projects/{projectId}/answers`

Internal, browser-session-only operation that answers using the selected project’s indexed evidence.

How it works:

- Checks project ownership before metering and retrieves only that project’s indexed evidence.
- Sends the retrieved excerpts to Workers AI using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Requires bracketed evidence citations and rejects an answer with no valid citations.
- Reserves AI credits before inference and settles or releases them afterward.

## Entity APIs

### `GET /v1/videos/:id?provider=youtube`

Returns core normalized video metadata: title, channel, description, thumbnails, duration, views, keywords, availability, and URL.

How it works:

- Calls YouTube player data through fallback client profiles when necessary.
- Caches the normalized record in Workers KV for 30 minutes.
- Track metadata and endscreen elements are available from their dedicated video subresources.
- Does not fetch the desktop caption catalog or expose media-format data, raw renderer data, tracking data, signed URLs, or ads.

### `GET /v1/channels/:id?provider=youtube`

Returns channel identity plus an `about` object aligned to YouTube's About UI:

- `description`: the complete public channel description
- `links`: every public link with its title, display URL, and direct destination URL
- `moreInfo`: canonical channel URL, joined date, subscriber/video/view totals, their display text,
  and whether YouTube offers its protected business-email action

How it works:

- A channel ID loads directly through the platform's YouTube browse adapter.
- An `@handle` is first resolved through channel search and then loaded by channel ID.
- YouTube redirect links are unwrapped; temporary redirect tokens are never returned.
- The protected business email is not accessed. Public email addresses written into the description remain part of the description.
- Results are cached in Workers KV for one hour.

### `GET /v1/channels/:id/videos?provider=youtube`

Returns one page of normalized video summaries from the channel's Videos tab.

- Accepts `sort=latest|popular|oldest`, matching the three controls in YouTube's UI. The default is `latest`.
- Accepts the optional `continuation` token returned by the previous response.
- Returns `channelId`, the effective `sort`, `videos`, `continuation`, and `meta`.
- Each video carries the UI card data: title, thumbnail, duration, views, published age, caption state, and canonical watch URL.
- Pages are cached in Workers KV for 15 minutes.

### `GET /v1/channels/:id/playlists?provider=youtube`

Returns one page of normalized playlist summaries from the channel's Playlists tab.

- Accepts `sort=newest|last-video-added`, matching YouTube's Sort by menu. The default is `newest`.
- Accepts the optional `continuation` token returned by the previous response.
- Returns `channelId`, the effective `sort`, `playlists`, `continuation`, and `meta`.
- Each card includes its title, thumbnail, displayed video/episode count, optional `updatedTimeText`,
  `isPodcast`, canonical playlist URL, and the optional `playUrl` used by the card itself.
- Pages are cached in Workers KV for 15 minutes.

### `GET /v1/playlists/:id?provider=youtube`

Returns playlist metadata, videos, and a continuation when more items are available.

How it works:

- Uses the platform's normalized YouTube playlist adapter.
- Normalizes the catalog and caches it in Workers KV for one hour.

### `GET /v1/videos/:id/tracks?provider=youtube`

Returns the video's actual source caption tracks and available auto-translation targets.

How it works:

- Returns source-track metadata as both `tracks` and the clearer `sourceTracks` alias.
- Merges the desktop player catalog used by Chrome so `translationLanguages` and `autoTranslationTargets` contain the complete auto-translation target list exposed for the video.
- Does not expose signed caption URLs or caption text.

### `GET /v1/videos/:id/transcript?provider=youtube`

Returns the synchronized transcript displayed beside the video.

Optional query parameter:

- `lang`: desired output language from the tracks API's auto-translation targets

How it works:

- The backend selects YouTube's default source caption track automatically.
- If `lang` differs from that source, the platform requests YouTube's translated caption data and normalizes the result.
- Without `lang`, it returns the original default-track transcript.
- Normalizes every segment to `text`, `startMs`, `durationMs`, and `endMs`.
- Returns the source `track` plus `translatedTo` when auto-translation was requested.
- Caches transcripts in Workers KV for seven days.

### `GET /v1/videos/:id/comments?provider=youtube`

Returns comments for the audience-evidence panel.

The response includes `totalCount` when YouTube reports it in the initial comments payload. This is the
video's displayed total; `comments.length`, `topLevelCount`, and `replyCount` describe the comments actually
returned or crawled by this request.

Parameters:

- `all=true`: crawl all available top-level comment and reply continuations up to the 100-page safety limit
- `continuation`: fetch one additional page when `all` is not enabled

How it works:

- Uses YouTube continuation tokens and normalizes comment/thread data.
- Live Sources exposes continuation-based pagination and retains each requested page. Saved project views show all retained pages without fetching more.
- Internal reply/newest continuation bookkeeping is removed from the public response.

## Project and ingestion APIs

### `GET /v1/projects`

Returns the signed-in user’s projects and each project’s saved-item count, newest first.

How it works:

- Reads D1 and joins `projects` with `project_items`.
- User ownership is enforced in the query.
- The UI uses the result in the sidebar, Projects view, and save flow.

### `POST /v1/projects`

Creates a private research project.

```json
{
  "name": "AI agent research",
  "description": "Optional description",
  "tags": ["agents", "video ideas"]
}
```

How it works:

- Requires a non-empty name and enforces the user’s plan limit.
- Stores the project in D1 and returns `201` with its ID and name.

### `POST /v1/projects/:id/items`

Saves a video, channel, playlist, exact moment, note, or transcript content into a project.

Representative request from the UI:

```json
{
  "provider": "youtube",
  "entityType": "video",
  "entityId": "VIDEO_ID",
  "title": "Video title",
  "content": "[0] Transcript text..."
}
```

How it works:

- Verifies project ownership and writes item metadata to D1.
- If `content` is present, queues an `index-document` task.
- The task stores the private document in R2 and uploads it to the user’s isolated AI Search instance.
- Duplicate project/entity records are ignored by the database constraint.

### `DELETE /v1/projects/:id`

Deletes a project after removing its private objects from R2 and its indexed items from the user’s AI Search instance. D1 foreign keys then cascade the project’s document metadata and saved items.

### `POST /v1/imports`

Starts durable ingestion after the user saves a source.

```json
{
  "provider": "youtube",
  "kind": "video",
  "entityId": "VIDEO_ID",
  "projectId": "PROJECT_ID"
}
```

Supported `kind` values are `video`, `channel`, `playlist`, `comments`, and `deep-comments`.

How it works:

- Enforces daily import and plan limits.
- Uses the `Idempotency-Key` header or a deterministic fallback to prevent duplicate jobs.
- Creates a D1 job and starts a Cloudflare Workflow, returning `202` immediately.
- Video imports fetch and store the transcript in R2, index a public copy, and optionally index a private project copy.
- Channel and playlist imports fan out up to ten eager child video imports.
- The current UI starts the job but does not yet poll its status.

## Research and planning APIs

### `POST /v1/projects/{projectId}/answers`

Internal project research implementation; no dashboard caller is wired yet. API keys and CLI sessions are rejected.

```json
{
  "question": "What are the main claims across this project?"
}
```

The path selects the project. The handler checks ownership, retrieves project-filtered evidence, and generates a cited answer. Body fields that try to select another project, a single video, or the public corpus are rejected. Comparisons and reports use the same project boundary at `/v1/projects/{projectId}/comparisons` and `/v1/projects/{projectId}/reports`.

### `GET /v1/trends?provider=youtube`

Builds the Trend Lab dashboard for a topic.

Parameters:

- `q`: required topic
- `limit`: requested enriched sample size, clamped to 8–30; defaults to 20
- `insights`: `ai` (default) or `deterministic`

How it works:

- Searches up to three YouTube result pages and limits over-representation by any one channel.
- Enriches the sample in bounded batches with video, engagement, and publication signals.
- Persists views, likes, and comments in `analytics_snapshots`; later scans calculate observed velocity and acceleration.
- Scores freshness, engagement, topic-relative velocity, acceleration, and channel-relative performance, with per-video and report confidence.
- Aggregates visible hashtags, repeated title terms, and duration buckets.
- Uses `@cf/zai-org/glm-4.7-flash` to extract evidence-linked themes, audience intent, saturation, and content gaps; model failure degrades to the deterministic report.
- Returns a deterministic starter plan and transparent methodology alongside the chart data.
- It does not claim access to CTR, retention, recommendation traffic, or proof of market demand. First scans explicitly report low confidence until snapshot history exists.

### `POST /v1/trends/plan`

Turns an existing Trend Lab report into a richer video strategy.

```json
{
  "report": {
    "provider": "youtube",
    "query": "AI agents",
    "sampleSize": 20,
    "summary": {},
    "videos": [],
    "hashtags": [],
    "titlePatterns": [],
    "durationMix": []
  }
}
```

How it works:

- Requires a session and AI credits.
- Validates and bounds every client-supplied signal before prompt construction.
- Tries `@cf/moonshotai/kimi-k2.6` first with bounded reasoning and a strict JSON schema, then falls back to `@cf/openai/gpt-oss-120b` if Kimi inference is unavailable.
- Produces an angle, audience, hook, duration, story arc, titles, hashtags, differentiation, evidence references, and caveats.
- Treats all titles and signal strings as untrusted data and accepts only evidence IDs present in the submitted sample.
- Supports both Workers AI Chat Completions and Responses API envelopes.
- Uses AI Gateway retries/caching when configured and releases reserved credits on failure.

## Monitor APIs

### `GET /v1/monitors`

Returns the signed-in user’s monitors for the monitor view and workspace counts.

How it works:

- Reads the user-owned monitor rows from D1, newest first.
- Includes enabled state, cadence, last cursor, and last checked time.

### `POST /v1/monitors`

Creates a channel, topic, or search monitor.

```json
{
  "provider": "youtube",
  "kind": "channel",
  "target": "CHANNEL_ID",
  "cadence": "hourly"
}
```

How it works:

- Enforces the user’s plan limit and stores the monitor in D1.
- The hourly scheduled Monitor Workflow searches YouTube sorted by date.
- A newly observed leading video creates a notification and advances the monitor cursor.
- The UI currently creates and lists monitors; notification display is not wired yet.

## UI-facing routes available but not yet called

These platform contracts exist, but no current UI action calls them:

- `GET /health`
- `GET /v1/videos/:id/tracks?provider=youtube`
- `GET /v1/videos/:id/endscreen?provider=youtube`
- `GET /v1/channels/:id/videos?provider=youtube`
- `GET /v1/channels/:id/playlists?provider=youtube`
- `GET /v1/projects/:id`
- `DELETE /v1/projects/:id`
- `GET /v1/jobs/:id`
- `POST /v1/projects/{projectId}/comparisons`
- `POST /v1/projects/{projectId}/reports`
- `POST /v1/projects/:id/exports`
- `GET /v1/exports/:id/download`
- `DELETE /v1/monitors/:id`
- Notification and notification-preference routes
- YouTube OAuth connection routes
- Billing, usage, admin, and account-deletion routes

They should remain outside the UI API contract until a visible user flow depends on them.

## API contract and remaining gaps

The APIs are versioned, typed internally, and published as OpenAPI 3.1 at `/openapi.json`. Scalar serves the interactive contract at `/docs`. The remaining contract gaps are:

1. Request and response types are duplicated between `web/app/page.tsx` and the platform implementation.
2. The OpenAPI document is maintained alongside the route code, but it does not yet generate the web client or enforce runtime schema validation.
3. Explicit API import jobs expose progress through `GET /v1/jobs/:id`. Dashboard project saves do not start imports.
4. The dashboard exposes comments pagination. Other browse and discovery pagination remains available through the API.
5. The UI hard-codes demo headers and credit copy instead of loading session/usage state through a formal client.

A strong next step is to generate the web client and shared types from the OpenAPI contract, add runtime schema validation, and add contract tests at the Next.js proxy boundary.
