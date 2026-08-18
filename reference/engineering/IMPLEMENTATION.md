# video2ctx Workspace

This repository implements the beta with a standalone library, private agent-skill source, two Worker applications, and one containerized processing boundary:

1. `packages/all-things-youtube/` contains the publishable normalized YouTube client, public helpers, retry transport, and data model.
2. `packages/youtube-skills/` contains the private source, tests, and bundling for the self-contained `youtube-direct` and `youtube-watch` skills; generated executables remain under `.agents/skills/`.
3. `platform/` is the typed Hono platform Worker and owns auth, private data, ingestion, retrieval, AI metering, monitoring, billing, notifications, and deletion.
4. `web/` is the Next.js 16 application deployed on Vercel. Its same-origin BFF reaches the platform through `PLATFORM_API_BASE_URL`, defaulting to the public API domain in production and the local Worker in development.
5. `platform/youtube-processor/` is a private Node/Hono Cloudflare Container that owns outbound YouTube calls, parsing, retries, and optional proxy egress.

The platform's core YouTube routes call `platform/src/lib/youtube.ts`. That adapter checks Workers KV first and sends misses through a cache-key-specific `YOUTUBE_REQUEST_COORDINATOR` Durable Object. The coordinator rechecks KV, coalesces identical concurrent misses, and invokes a randomly selected `YOUTUBE_PROCESSOR` container. The container executes both public package helpers and the internal search, browse, and trend-signal client. No platform route calls YouTube directly from the Worker runtime.

## YouTube processor boundary

```text
Web Worker
  → Platform Worker (auth, permissions, credits, KV)
    → YOUTUBE_REQUEST_COORDINATOR (one Durable Object per cache key)
      → YOUTUBE_PROCESSOR binding (one randomly selected pool member)
        → Node 22 + Hono container
          → optional OUTBOUND_PROXY_URL
            → YouTube
```

The platform randomly chooses a starting slot from two logical container IDs and makes at most one fallback attempt when a container returns `502`, `503`, or `504`, times out, or cannot be reached. A small randomized delay separates attempts. Each container accepts up to four active YouTube operations by default and returns `503 PROCESSOR_BUSY` with `Retry-After` when saturated. Wrangler allows at most four `lite` instances; the active routing pool remains controlled by `YOUTUBE_PROCESSOR_INSTANCE_COUNT`. Instances start on demand and sleep after 30 minutes without activity. The container endpoint is private behind the binding, so it does not need a second user-facing authentication scheme.

Only identical misses share a coordinator. Unrelated cache keys resolve to different Durable Object identities and therefore do not pass through a global load-balancing bottleneck. A coalesced follower is metered at the cached-read price because it does not create another upstream operation.

Provider-data credit prices live in the single `DATA_OPERATION_PRICING` table in `platform/src/lib/metering.ts`. Cached responses cost 1 credit. Fresh search and comment requests cost 2 credits, including full comment collection; every other fresh provider-data request costs 1 credit. Private indexed search and the existing composite analysis operations keep their separate prices.

`OUTBOUND_PROXY_URL` is an optional Worker secret passed into the container environment. The URL is never returned or logged. The processor uses Undici's `ProxyAgent` when configured and direct Node fetch otherwise. KV remains the shared durable cache; container memory is not treated as authoritative.

## Shared package interface

```ts
import { getDetails, getTracks, getTranscript } from 'all-things-youtube';

const video = await getDetails({ videoId: 'abcdefghijk' });
const tracks = await getTracks({ videoId: 'abcdefghijk' });
const transcript = await getTranscript({
  videoId: 'abcdefghijk',
  lang: 'hi',
  granularity: 'word',
});
```

`getTracks()` intentionally returns normalized track metadata, not caption URLs. `getTranscript()` selects the source track, requests translation when `lang` is supplied, computes word timing where YouTube provides it, and strips signed caption URLs before returning data.

Raw renderer objects, tracking values, attestation, ads, media URLs, and caption URLs are not public API output. Continuation tokens remain opaque pagination values.

## Platform API

All application routes are versioned under `/v1`. Private routes require a Better Auth session. Local development also accepts `x-demo-user` when `ENVIRONMENT` is not `production`.

Important routes:

| Area | Routes |
| --- | --- |
| UI helpers | `POST /v1/resolve` (first-party universal-input routing) |
| Providers | `GET /v1/providers`; provider data is scoped below `/v1/providers/:provider` |
| Discovery | `GET /v1/providers/:provider/search`, `GET /v1/providers/:provider/browse`, `GET /v1/providers/:provider/trends`; `GET /v1/search` searches private indexed evidence |
| Entities | `/v1/providers/:provider/videos/:id`, `/tracks`, `/transcript`, `/comments`, `/endscreen`; `/channels/:id`, `/channels/:id/videos`, `/channels/:id/playlists`; `/playlists/:id` |
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
npm run db:migrate:preview
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
GET http://localhost:8787/v1/providers/youtube/videos/abcdefghijk/tracks

GET http://localhost:8787/v1/providers/youtube/videos/abcdefghijk/transcript

GET http://localhost:8787/v1/providers/youtube/videos/abcdefghijk/transcript?lang=hi
```

The tracks response exposes both the legacy `tracks` / `translationLanguages` fields and the clearer
`sourceTracks` / `autoTranslationTargets` aliases. Pass the desired output language as `lang`; the backend
selects the video's default source track and requests auto-translation only when the languages differ.

All outbound YouTube traffic runs in the processor container and uses a shared transport retry policy. It retries network failures, `429`, `408`,
`425`, and transient `5xx` responses up to five attempts, honors bounded `Retry-After` values, and otherwise
uses exponential backoff with full jitter. Each attempt rebuilds its request; translated-caption retries also
refresh the signed caption URL and anonymous visitor session. Permanent client errors are not retried.

Fetch every available top-level comment and reply (up to the explicit crawl safety limit):

```http
GET http://localhost:8787/v1/providers/youtube/videos/abcdefghijk/comments?all=true
```

The response reports `complete`, `topLevelCount`, `replyCount`, `pagesFetched`, and `remainingContinuations`. Without `all=true`, the endpoint returns one correctly classified top-level page and an opaque continuation.

Search YouTube:

```http
GET http://localhost:8787/v1/providers/youtube/search?q=AI%20research&type=video&duration=medium&captions=true&sort=views
```

Create an import job:

```http
POST http://localhost:8787/v1/imports
Content-Type: application/json
Idempotency-Key: import-demo-1
X-Demo-User: postman

{"provider":"youtube","kind":"video","entityId":"abcdefghijk","projectId":"PROJECT_ID"}
```

## Cloudflare setup

The `platform/wrangler.jsonc` file binds separate preview and production D1 databases and Workers KV namespaces. Wrangler development uses the preview IDs; deployment uses the production IDs. Before production deployment:

1. Enable Email Sending for the domain in `EMAIL_FROM` and update that address.
2. Set `APP_ORIGIN`, `AUTH_BASE_URL`, `ENVIRONMENT=production`, Stripe price ID, admin emails, and plan limits per environment.
3. Add secrets interactively: `BETTER_AUTH_SECRET`, Google client credentials, a base64 32-byte `YOUTUBE_OAUTH_ENCRYPTION_KEY`, `TURNSTILE_SECRET`, and Stripe credentials. If direct YouTube egress is unreliable, also run `wrangler secret put OUTBOUND_PROXY_URL` and enter the proxy URL interactively.
4. Connect the platform to Cloudflare Builds and the web application to Vercel, using the repository settings in `reference/engineering/DEPLOYMENT.md`.
5. Apply D1 migrations remotely and configure Google/Stripe callback URLs.

Never commit `.dev.vars`. The web Worker does not receive provider secrets; it reaches the platform through `PLATFORM`.

## Reliability and privacy

- Public YouTube responses are cached in Workers KV and a retained stale value is returned when an upstream YouTube section fails.
- Private documents use one AI Search instance per user and project metadata filters; D1/R2 remain authoritative.
- Public transcript imports grow the shared hybrid corpus. Channel and playlist workflows eagerly fan out recent videos, with lazy access still supported.
- Queue tasks and Stripe webhooks have deterministic replay records. Credit reservation is a single conditional D1 mutation, followed by settlement or release.
- Prompt evidence is delimited as untrusted content; synthesis without aligned citations returns `INSUFFICIENT_EVIDENCE`.
- Account deletion revokes YouTube OAuth, removes private R2 objects and D1 rows, and queues private AI Search instance removal.

## Verification

```sh
npm run build && npm test
npm --prefix platform run build && npm --prefix platform test
npm --prefix platform run test:container
npm --prefix platform run db:migrate:preview
npm --prefix sample run build
npm --prefix sample run preview
```

The fixture suite covers normalized renderers, continuations, ASR/manual/multilingual captions, word timing, unavailable/private/live state, comments, universal routing, private search isolation, citation alignment, prompt injection, and OAuth expiry. Deployment validation uses Wrangler dry runs for both Workers and an OpenNext bundle build.

As of 2026-07-31, `npm audit` reports unresolved advisories in Next 16.2.12's bundled PostCSS and OpenNext's build-only glob/minimatch chain. These are the latest upstream releases; forcing the patched ESM-only `brace-expansion` breaks the OpenNext bundle. Keep build inputs trusted and update Next/OpenNext as soon as compatible fixes ship. The platform Worker's production dependency audit is clean.
