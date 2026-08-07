# UI API Reference

This document inventories the APIs currently called by the web UI. It is derived from the client calls in `web/app/page.tsx`, the same-origin proxy in `web/app/api/platform/[...path]/route.ts`, and the Hono routes in `platform/src/index.ts`.

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
- Errors: `{ "error": { "code": string, "message": string, "details"?: unknown, "requestId"?: string } }`
- Traceability: every platform response receives an `X-Request-Id` header

## Current UI request sequence

### Application startup

The UI loads these requests concurrently:

1. `GET /v1/projects`
2. `GET /v1/monitors`
3. `GET /v1/browse`
4. `GET /v1/trends?q=AI%20agents&limit=20` from the default Trend Lab view

### Search and inspection

1. The search box sends its value to `POST /v1/resolve`.
2. A recognized YouTube URL or video ID opens the matching entity endpoint directly.
3. Plain text is sent to `GET /v1/search` with the selected search mode.
4. Opening a video loads its entity record, transcript, and comments. Transcript or comment failure does not prevent the main video record from opening.

### Saving a source

1. The UI uses the most recent project or creates a “Research inbox” with `POST /v1/projects`.
2. It saves the source with `POST /v1/projects/:id/items`.
3. It starts durable ingestion with `POST /v1/imports`. Import failure is currently non-blocking for the initial save.

### Trend planning

1. `GET /v1/trends` calculates topic signals from public YouTube data, stores metric snapshots, and adds evidence-grounded GLM insights by default.
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
| `GET` | `/v1/browse` | Seed the source inbox | Public, rate-limited |
| `POST` | `/v1/resolve` | Internal universal-input routing helper | First-party UI, protected |
| `GET` | `/v1/search` | Search YouTube, private evidence, or ask a question | Mixed |
| `GET` | `/v1/videos/:id` | Inspect a video | Public |
| `GET` | `/v1/channels/:id` | Inspect a channel | Public |
| `GET` | `/v1/channels/:id/videos` | Load a channel's videos | Public |
| `GET` | `/v1/channels/:id/playlists` | Load a channel's playlists | Public |
| `GET` | `/v1/playlists/:id` | Inspect a playlist | Public |
| `GET` | `/v1/videos/:id/transcript` | Load timed transcript evidence | Public |
| `GET` | `/v1/videos/:id/comments` | Load audience comments | Public |
| `POST` | `/v1/imports` | Start durable ingestion and indexing | Private |
| `POST` | `/v1/answers` | Generate a cited answer for an inspected source | Private, metered |
| `GET` | `/v1/trends` | Calculate topic momentum and patterns | Public, rate-limited |
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

### `GET /v1/browse`

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
- Caches each option set in D1 for five minutes.
- Returns a stale cached snapshot if the upstream call fails and a previous snapshot exists.

### `GET /v1/search`

Powers all three modes in the main search interface.

Common parameters:

- `q`: required query
- `mode`: `youtube`, `inside`, or `ask`; defaults to `youtube`
- `projectId`: optional private-project restriction for `inside` and `ask`

#### `mode=youtube`

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
- Caches the query/filter combination in D1 for five minutes with stale fallback.
- The UI currently exposes type, duration, and captions filters.

#### `mode=inside`

Searches transcript and research content previously saved by the user.

How it works:

- Requires a session.
- Queries the user’s isolated Cloudflare AI Search instance.
- Uses hybrid keyword/vector retrieval, reciprocal-rank fusion, and BGE reranking.
- Can filter to one project and returns up to 12 evidence chunks with scores, source IDs, and timestamps.

#### `mode=ask`

Answers the query using the user’s indexed evidence.

How it works:

- Runs the same private retrieval used by `inside` mode.
- Sends the retrieved excerpts to Workers AI using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Requires bracketed evidence citations and rejects an answer with no valid citations.
- Reserves AI credits before inference and settles or releases them afterward.

## Entity APIs

### `GET /v1/videos/:id`

Returns core normalized video metadata: title, channel, description, thumbnails, duration, views, keywords, availability, and URL.

How it works:

- Calls YouTube player data through fallback client profiles when necessary.
- Caches the normalized record in D1 for 30 minutes.
- Track metadata and endscreen elements are available from their dedicated video subresources.
- Does not fetch the desktop caption catalog or expose media-format data, raw renderer data, tracking data, signed URLs, or ads.

### `GET /v1/channels/:id`

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
- Results are cached in D1 for one hour.

### `GET /v1/channels/:id/videos`

Returns one page of normalized video summaries from the channel's Videos tab.

- Accepts `sort=latest|popular|oldest`, matching the three controls in YouTube's UI. The default is `latest`.
- Accepts the optional `continuation` token returned by the previous response.
- Returns `channelId`, the effective `sort`, `videos`, `continuation`, and `meta`.
- Each video carries the UI card data: title, thumbnail, duration, views, published age, caption state, and canonical watch URL.
- Pages are cached in D1 for 15 minutes.

### `GET /v1/channels/:id/playlists`

Returns one page of normalized playlist summaries from the channel's Playlists tab.

- Accepts `sort=newest|last-video-added`, matching YouTube's Sort by menu. The default is `newest`.
- Accepts the optional `continuation` token returned by the previous response.
- Returns `channelId`, the effective `sort`, `playlists`, `continuation`, and `meta`.
- Each card includes its title, thumbnail, displayed video/episode count, optional `updatedTimeText`,
  `isPodcast`, canonical playlist URL, and the optional `playUrl` used by the card itself.
- Pages are cached in D1 for 15 minutes.

### `GET /v1/playlists/:id`

Returns playlist metadata, videos, and a continuation when more items are available.

How it works:

- Uses the platform's normalized YouTube playlist adapter.
- Normalizes the catalog and caches it in D1 for one hour.

### `GET /v1/videos/:id/tracks`

Returns the video's actual source caption tracks and available auto-translation targets.

How it works:

- Returns source-track metadata as both `tracks` and the clearer `sourceTracks` alias.
- Merges the desktop player catalog used by Chrome so `translationLanguages` and `autoTranslationTargets` contain the complete auto-translation target list exposed for the video.
- Does not expose signed caption URLs or caption text.

### `GET /v1/videos/:id/transcript`

Returns the synchronized transcript displayed beside the video.

Optional query parameter:

- `lang`: desired output language from the tracks API's auto-translation targets

How it works:

- The backend selects YouTube's default source caption track automatically.
- If `lang` differs from that source, the platform requests YouTube's translated caption data and normalizes the result.
- Without `lang`, it returns the original default-track transcript.
- Normalizes every segment to `text`, `startMs`, `durationMs`, and `endMs`.
- Returns the source `track` plus `translatedTo` when auto-translation was requested.
- Caches transcripts in D1 for seven days.

### `GET /v1/videos/:id/comments`

Returns comments for the audience-evidence panel.

The response includes `totalCount` when YouTube reports it in the initial comments payload. This is the
video's displayed total; `comments.length`, `topLevelCount`, and `replyCount` describe the comments actually
returned or crawled by this request.

Parameters:

- `all=true`: crawl all available top-level comment and reply continuations up to the 100-page safety limit
- `continuation`: fetch one additional page when `all` is not enabled

How it works:

- Uses YouTube continuation tokens and normalizes comment/thread data.
- The UI currently requests `all=true` but only displays the first three comments.
- Full comment collections are cached for 15 minutes.
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

### `POST /v1/imports`

Starts durable ingestion after the user saves a source.

```json
{
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

### `POST /v1/answers`

Generates the cited brief and source answers shown by the UI.

```json
{
  "question": "What are the main claims?",
  "entityId": "VIDEO_ID"
}
```

How it works for the current UI:

- Fetches the video transcript.
- Selects transcript segments that match important question terms, with an early-segment fallback.
- Sends only those segments to the Workers AI answer model.
- Treats transcript text as untrusted evidence and requires citations such as `[1]` on substantive claims.
- Returns the answer plus only the evidence records actually cited.
- Uses AI Gateway retries/caching when configured and a direct Workers AI fallback when the gateway is unavailable.

The endpoint can also search private project evidence when `entityId` is omitted, or the public corpus when `scope` is `public`.

### `GET /v1/trends`

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
- `GET /v1/videos/:id/tracks`
- `GET /v1/videos/:id/endscreen`
- `GET /v1/channels/:id/videos`
- `GET /v1/channels/:id/playlists`
- `GET /v1/projects/:id`
- `DELETE /v1/projects/:id`
- `GET /v1/jobs/:id`
- `POST /v1/comparisons`
- `POST /v1/reports`
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
3. The UI starts import jobs but does not use `GET /v1/jobs/:id` to report durable progress or failure.
4. Pagination tokens exist for search, browse, channel, playlist, and comments, but the UI does not expose “load more” flows.
5. The UI hard-codes demo headers and credit copy instead of loading session/usage state through a formal client.

A strong next step is to generate the web client and shared types from the OpenAPI contract, add runtime schema validation, and add contract tests at the Next.js proxy boundary.
