# all-things-youtube Workspace

This repository implements the beta with a standalone library and two independently deployable application layers:

1. `packages/all-things-youtube/` contains the publishable normalized YouTube client, public helpers, retry transport, and data model.
2. `platform/` is the typed Hono platform Worker and owns auth, private data, ingestion, retrieval, AI metering, monitoring, billing, notifications, and deletion.
3. `web/` is the Next.js 16/OpenNext web application. Its same-origin BFF reaches the platform over a Cloudflare service binding and falls back to `PLATFORM_API_BASE_URL` locally.

The platform modules under `platform/src/lib/youtube-{client,types,transport}.ts` are thin re-exports of the package source so both surfaces use the same implementation.

## Shared normalized client

```ts
import { createYouTubeClient } from 'all-things-youtube';

const youtube = createYouTubeClient({ language: 'en', region: 'US' });
const results = await youtube.search('evidence-first research', {
  type: 'video',
  duration: 'medium',
  captionsOnly: true,
  sort: 'views',
});
const tracks = await youtube.getCaptionTracks('abcdefghijk');
const transcript = await youtube.getTranscript({
  videoId: 'abcdefghijk',
  language: 'en',
  granularity: 'word',
});
```

`getCaptionTracks()` intentionally returns normalized track metadata, not caption URLs. `getTranscript()` makes the separate internal request to the selected track's `baseUrl`, requests JSON3, computes word time as `tStartMs + tOffsetMs`, and strips the signed URL before returning data.

The advanced client also provides `browse`, `getVideo`, `getChannel`, `getPlaylist`, `getComments`, and `getEndscreen`. Raw renderer objects, tracking values, tokens, attestation, ads, media URLs, and caption URLs are not primary API output. The published caption extractor remains a separate, unchanged service boundary.

## Platform API

All application routes are versioned under `/v1`. Private routes require a Better Auth session. Local development also accepts `x-demo-user` when `ENVIRONMENT` is not `production`.

Important routes:

| Area | Routes |
| --- | --- |
| UI helpers | `POST /v1/resolve` (first-party universal-input routing) |
| Discovery | `GET /v1/search`, `GET /v1/browse` |
| Entities | `/v1/videos/:id`, `/tracks`, `/transcript`, `/comments`, `/endscreen`; `/v1/channels/:id`, `/v1/channels/:id/videos`, `/v1/channels/:id/playlists`; `/v1/playlists/:id` |
| Research | `/v1/projects`, `/v1/projects/:id/items`, `/v1/answers`, `/v1/comparisons`, `/v1/reports` |
| Jobs | `POST /v1/imports`, `GET /v1/jobs/:id` |
| Exports | `POST /v1/projects/:id/exports`, `GET /v1/exports/:id/download` |
| Automation | `/v1/monitors`, `/v1/notifications`, `/v1/notification-preferences` |
| Account | `/v1/oauth/youtube`, `/v1/billing/checkout`, `/v1/usage`, `DELETE /v1/account` |

Long-running imports return `202` with a stable job ID. Reusing an idempotency key returns the existing job. Jobs expose `queued`, `running`, `partial`, `succeeded`, `failed`, or `cancelled`, plus progress, partial result, retry time, and permanent failure information.

## Postman quick start

Run the platform locally:

```sh
cd platform
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

For local private-route testing add `x-demo-user: postman` to requests. This header is ignored in production.

Resolve any input:

```http
POST http://localhost:8787/v1/resolve
Content-Type: application/json

{"input":"https://www.youtube.com/watch?v=abcdefghijk"}
```

Inspect caption tracks and fetch the transcript:

```http
GET http://localhost:8787/v1/videos/abcdefghijk/tracks

GET http://localhost:8787/v1/videos/abcdefghijk/transcript

GET http://localhost:8787/v1/videos/abcdefghijk/transcript?lang=hi
```

The tracks response exposes both the legacy `tracks` / `translationLanguages` fields and the clearer
`sourceTracks` / `autoTranslationTargets` aliases. Pass the desired output language as `lang`; the backend
selects the video's default source track and requests auto-translation only when the languages differ.

All outbound YouTube traffic uses a shared transport retry policy. It retries network failures, `429`, `408`,
`425`, and transient `5xx` responses up to five attempts, honors bounded `Retry-After` values, and otherwise
uses exponential backoff with full jitter. Each attempt rebuilds its request; translated-caption retries also
refresh the signed caption URL and anonymous visitor session. Permanent client errors are not retried.

Fetch every available top-level comment and reply (up to the explicit crawl safety limit):

```http
GET http://localhost:8787/v1/videos/abcdefghijk/comments?all=true
```

The response reports `complete`, `topLevelCount`, `replyCount`, `pagesFetched`, and `remainingContinuations`. Without `all=true`, the endpoint returns one correctly classified top-level page and an opaque continuation.

Search YouTube:

```http
GET http://localhost:8787/v1/search?q=AI%20research&type=video&duration=medium&captions=true&sort=views
```

Create an import job:

```http
POST http://localhost:8787/v1/imports
Content-Type: application/json
Idempotency-Key: import-demo-1
X-Demo-User: postman

{"kind":"video","entityId":"abcdefghijk","projectId":"PROJECT_ID"}
```

## Cloudflare setup

The `platform/wrangler.jsonc` file uses automatic resource provisioning for D1 and AI Search where supported. Before production deployment:

1. Enable Email Sending for the domain in `EMAIL_FROM` and update that address.
2. Set `APP_ORIGIN`, `AUTH_BASE_URL`, `ENVIRONMENT=production`, Stripe price ID, admin emails, and plan limits per environment.
3. Add secrets interactively: `BETTER_AUTH_SECRET`, Google client credentials, a base64 32-byte `YOUTUBE_OAUTH_ENCRYPTION_KEY`, `TURNSTILE_SECRET`, Stripe credentials, and `CAPTION_API_TOKEN`.
4. Deploy the extractor service, platform Worker, and web Worker in that order so service bindings resolve.
5. Apply D1 migrations remotely and configure Google/Stripe callback URLs.

Never commit `.dev.vars`. The web Worker does not receive provider secrets; it reaches the platform through `PLATFORM`.

## Reliability and privacy

- Public entity snapshots are shared and stale cache is returned when an upstream YouTube section fails.
- Private documents use one AI Search instance per user and project metadata filters; D1/R2 remain authoritative.
- Public transcript imports grow the shared hybrid corpus. Channel and playlist workflows eagerly fan out recent videos, with lazy access still supported.
- Queue tasks and Stripe webhooks have deterministic replay records. Credit reservation is a single conditional D1 mutation, followed by settlement or release.
- Prompt evidence is delimited as untrusted content; synthesis without aligned citations returns `INSUFFICIENT_EVIDENCE`.
- Account deletion revokes YouTube OAuth, removes private R2 objects and D1 rows, and queues private AI Search instance removal.

## Verification

```sh
npm run build && npm test
npm --prefix platform run build && npm --prefix platform test
npm --prefix platform run db:migrate:local
npm --prefix sample run build
npm --prefix sample run preview
```

The fixture suite covers normalized renderers, continuations, ASR/manual/multilingual captions, word timing, unavailable/private/live state, comments, universal routing, private search isolation, citation alignment, prompt injection, and OAuth expiry. Deployment validation uses Wrangler dry runs for both Workers and an OpenNext bundle build.

As of 2026-07-31, `npm audit` reports unresolved advisories in Next 16.2.12's bundled PostCSS and OpenNext's build-only glob/minimatch chain. These are the latest upstream releases; forcing the patched ESM-only `brace-expansion` breaks the OpenNext bundle. Keep build inputs trusted and update Next/OpenNext as soon as compatible fixes ship. The platform Worker's production dependency audit is clean.
