# video2ctx Workspace

This repository implements the beta with a standalone library, private agent-skill source, two Worker applications, and two private container processing boundaries:

1. `packages/all-things-youtube/` contains the publishable normalized YouTube client, public helpers, retry transport, and data model.
2. `packages/youtube-skills/` contains the private source, tests, and bundling for the self-contained `youtube-ctx` skill's direct and visual branches; generated executables remain under `.agents/skills/youtube-ctx/`.
3. `platform/` is the typed Hono platform Worker and owns auth, private data, ingestion, retrieval, AI metering, monitoring, billing, notifications, and deletion.
4. `web/` is the Next.js 16 application deployed on Vercel. Its same-origin BFF reaches the platform through `PLATFORM_API_BASE_URL`, defaulting to the public API domain in production and the local Worker in development.
5. `platform/youtube-processor/` is a private Node/Hono Cloudflare Container that owns outbound YouTube calls, parsing, retries, and optional proxy egress.
6. `platform/youtube-frames/` is a private Node/Hono Cloudflare Container that uses the shared watch extractor and FFmpeg for agent-requested video frames.

The platform's core YouTube routes call `platform/src/lib/youtube.ts`. That adapter checks Workers KV first and sends misses through a cache-key-specific `YOUTUBE_REQUEST_COORDINATOR` Durable Object. The coordinator rechecks KV, coalesces identical concurrent misses, and invokes a randomly selected `YOUTUBE_PROCESSOR` container. The container executes both public package helpers and the internal search, browse, and trend-signal client. No platform route calls YouTube directly from the Worker runtime.

Individual-frame requests are available only through the agent API. The agent tool uses bounded Cloudflare Media decoding for supported short MP4 clips, with the dedicated private `YOUTUBE_FRAMES` container as fallback. See [frame extraction](./FRAME_EXTRACTION.md) for the tool contract, skill implementation, resource limits, and verification.

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

The platform chooses a starting slot from two logical container IDs, preferring slots without recent failures, and allows up to four calls within a shared 120-second deadline. It visits both slots before repeating. Transcript failures, including missing or unavailable captions, can use all four calls; invalid caller input remains terminal. Other operations retry explicitly retryable failures or transport errors. A small randomized delay separates attempts. Each container accepts up to four active YouTube operations by default and returns `503 PROCESSOR_BUSY` with `Retry-After` when saturated. Wrangler allows at most four `basic` instances; the active routing pool remains controlled by `YOUTUBE_PROCESSOR_INSTANCE_COUNT`. Instances start on demand and sleep after 30 minutes without activity. The container endpoint is private behind the binding, so it does not need a second user-facing authentication scheme.

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
| Providers | `GET /v1/providers`; provider reads require `?provider=youtube` |
| Discovery | `GET /v1/search?provider=youtube`, `GET /v1/browse?provider=youtube`, `GET /v1/trends?provider=youtube`; `GET /v1/projects/{projectId}/search` searches private indexed evidence |
| Entities | `/v1/videos/:id?provider=youtube`, `/tracks`, `/transcript`, `/comments`, `/endscreen`; `/channels/:id`, `/channels/:id/videos`, `/channels/:id/playlists`; `/playlists/:id` |
| Research | `/v1/projects`, `/v1/projects/:id/items`, `/v1/projects/{projectId}/answers`, `/v1/projects/{projectId}/comparisons`, `/v1/projects/{projectId}/reports` |
| Agents | `POST /v1/agent`, `GET /v1/agent/:sessionId/runs/:runId` |
| Jobs | `POST /v1/imports`, `GET /v1/jobs/:id` |
| Exports | `POST /v1/projects/:id/exports`, `GET /v1/exports/:id/download` |
| Automation | `/v1/monitors`, `/v1/notifications`, `/v1/notification-preferences` |
| Account | `/v1/oauth/youtube`, `GET /v1/billing`, `/v1/usage`, `DELETE /v1/account` |

See [local Polar sandbox setup](./POLAR_SANDBOX.md) for isolated webhook verification.

Polar checkout, customer portal, and the signed `/api/auth/polar/webhooks` callback are mounted by the Better Auth Polar plugin. Before checkout, the server looks up or creates a Polar customer from the signed-in account, verifies its external ID and email, and creates checkout with that customer ID. Old-email collisions stop checkout for manual reconciliation. The Polar token requires `customers:write` for customer provisioning. The application projects verified Polar events into `billing_accounts`. `credit_ledger` retains the credit history, and D1 triggers atomically maintain `credit_accounts.available_credits` for balance reads and reservation checks. See [credit accounting](./CREDIT_ACCOUNTING.md) for migration, manual adjustments, and reconciliation. Wrangler applies the versioned SQL files in `platform/migrations`. A paid order tops the balance up to the Builder allowance using the Polar order ID as an idempotency key. A refunded order downgrades the account and adjusts its balance to the Starter default. Credit changes and their billing projection are submitted in one D1 batch, and stale payment events cannot change credits after a newer refund. Calendar time and checkout return URLs never grant credits. Billing events with mismatched application and customer identities are skipped, recorded in the existing processed-event log, and reported through safe structured logs. Later correctly owned events remain independent. The pre-launch product does not use a persistent conflict table, quarantine, or conflict-specific migration. Daily and weekly digests include only monitor matches. See the [sandbox verification guide](./POLAR_SANDBOX.md).

Long-running imports return `202` with a stable job ID. Reusing an idempotency key returns the existing job. Jobs expose `queued`, `running`, `partial`, `succeeded`, `failed`, or `cancelled`, plus progress, partial result, retry time, and permanent failure information.

## Account deletion

The application removes private account data. Polar owns subscription renewal and customer anonymization. Deletion first blocks overlapping checkout and checks all Polar subscription pages. Active, trialing and past-due subscriptions must be cancelled before deletion; a cancellation scheduled for period end permits deletion immediately, forfeiting the remaining paid period. Settings shows `SUBSCRIPTION_ACTIVE` as an error toast. The Polar token needs `subscriptions:read` and the existing customer write permissions. Missing credentials or failed Polar calls stop deletion before private cleanup.

For example, a user with two sessions and a renewing Builder plan receives the cancellation toast with both sessions intact. After cancelling in Polar, retrying deletion anonymizes the customer, fences the account against new sessions, and clears both session runtimes. Runtime cleanup initializes the current schema first, including for sessions created before memory tables existed or sessions that never started.

```mermaid
%%{init: {"themeVariables": {"sequenceNumber": "#ffffff", "signalColor": "#4b5563"}}}%%
sequenceDiagram
    autonumber
    actor User
    participant App
    participant Polar
    participant Private as Private storage
    participant D1
    User->>App: Delete account
    App->>App: Block checkout; reject if one is in flight
    App->>Polar: Check subscriptions
    alt Subscription still renews
        Polar-->>App: Renewal active
        App-->>User: Cancellation error toast
    else Cancelled or no subscription
        App->>Polar: Anonymize customer
        App->>Private: Fence account and delete sessions, sources, files
        App->>App: Queue private search deletion
        App->>D1: Delete email metadata, sign-in tokens and user
        App-->>User: Clear browser cookies and return success
    end
```

Shared transcripts, storyboards and other video catalog assets remain available. Private cleanup failures return `503 ACCOUNT_DELETION_INCOMPLETE` while retaining the D1 user so deletion can be retried. Successful deletion clears the current browser's token and cached-session cookies. D1 foreign-key cascades revoke stored login sessions and remove related account records. Private search deletion remains asynchronous; failures retry through the task queue, while an already absent index counts as success. Emails queued for a deleted user cannot recreate delivery records.

### Admin account deletion

The admin Users panel searches exact user IDs or email fragments, with 25 results per page. Selecting Delete account shows the target identity and requires typing its email. The backend checks a live verified admin browser session and dashboard Origin, and compares the selected email with the current user record. Admin accounts cannot be deleted through either the admin panel or self-service settings. Protection checks current D1 roles, including comma-separated admin roles, and bootstrap operator emails before any billing or private cleanup. Search results mark these accounts as protected and hide their deletion controls. Other account deletions share the self-service cleanup service; the admin stays signed in and the target's stored sessions are revoked.

Checkout and deletion share durable claims in the user's account Durable Object. A checkout already in flight prevents deletion from starting. A deletion claim blocks new checkouts before checking subscriptions or closing Polar. If the cancellation check fails, that claim is released. Once Polar customer deletion may have started, the checkout fence persists through cleanup failures and completed deletion. Claims do not expire automatically, because a provider request may still be running. A Worker termination before releasing a claim fails closed; inspect the account's billing claims and Polar state before operator recovery. No network call runs inside `blockConcurrencyWhile`.

### Uncertain Polar writes

Before sending a customer-create or checkout-create POST, the account Durable Object records its claim, operation and start time in `billing_checkout_writes`. A valid successful response or a definitive HTTP 4xx rejection, excluding 408, clears that marker. A connection error, timeout, HTTP 5xx or invalid success response retains the marker and checkout claim. The SDK does not automatically retry either POST. Both another checkout and account deletion remain blocked, including after a Worker restart. A failed read before any write releases its claim normally.

Recovery requires confirming the outcome of the specific accepted write. The `billing_write_uncertain` log includes the user ID, claim and operation. Customer and checkout creation metadata include `billing_checkout_claim` for correlation with Polar records. Inspect the account's durable claim and the matching Polar operation. Confirm that the original request has completed or definitively failed and that no accepted attempt can still commit. A temporary 404, a customer found without matching correlation, or elapsed time alone is not confirmation. If the outcome cannot be established, keep the fence and investigate with Polar.

Once the outcome is confirmed, an operator with trusted Worker/DO access can call `finishBillingCheckoutWrite(claim)` and then `endBillingCheckout(claim)` for that exact claim. No public HTTP endpoint exposes these recovery methods. A committed customer is then handled by the normal subscription guard and deletion flow. This recovery is deliberately manual; the application never guesses that an ambiguous POST failed.

Queued magic-link emails reference the exact Better Auth verification row. The delivery insert checks that row, its recipient and expiry atomically. Deleting or consuming the token suppresses the queued email without recreating delivery metadata. A fresh signup link works without an existing user row. Old queued messages without a verification reference are suppressed; request a new sign-in link after deployment if necessary.

## Postman quick start

Run the platform locally:

```sh
cd platform
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:preview
npm run dev
```

For local private-route testing add `x-demo-user: postman` to requests. This header is rejected in production. To omit authentication headers entirely, start the platform with `npm run dev:local:no-auth`. That explicit bypass is disabled by default and activates only for loopback requests outside production.

Resolve any input:

```http
POST http://localhost:8787/v1/resolve
Content-Type: application/json

{"input":"https://www.youtube.com/watch?v=abcdefghijk"}
```

Inspect caption tracks and fetch the transcript:

```http
GET http://localhost:8787/v1/videos/abcdefghijk/tracks?provider=youtube

GET http://localhost:8787/v1/videos/abcdefghijk/transcript?provider=youtube

GET http://localhost:8787/v1/videos/abcdefghijk/transcript?provider=youtube&lang=hi
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
GET http://localhost:8787/v1/videos/abcdefghijk/comments?provider=youtube&all=true
```

The response reports `complete`, `topLevelCount`, `replyCount`, `pagesFetched`, and `remainingContinuations`. Without `all=true`, the endpoint returns one correctly classified top-level page and an opaque continuation.

Search YouTube:

```http
GET http://localhost:8787/v1/search?provider=youtube&q=AI%20research&type=video&duration=medium&captions=true&sort=views
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

1. Enable Email Sending for the domain in `EMAIL_FROM` and update that address. Product emails (sign-in links, monitor alerts, digests) send as `video2ctx <EMAIL_FROM>`; the welcome email sends as `Himanshu from video2ctx <WELCOME_EMAIL_FROM>`. Both addresses must be listed in the `EMAIL` binding's `allowed_sender_addresses`.
2. Set `APP_ORIGIN`, `AUTH_BASE_URL`, `ENVIRONMENT=production`, `POLAR_ENVIRONMENT`, `POLAR_BUILDER_PRODUCT_ID`, admin emails, and plan limits per environment.
3. Add secrets interactively: `BETTER_AUTH_SECRET`, Google client credentials, a base64 32-byte `YOUTUBE_OAUTH_ENCRYPTION_KEY`, `TURNSTILE_SECRET`, `POLAR_ACCESS_TOKEN`, and `POLAR_WEBHOOK_SECRET`. If direct YouTube egress is unreliable, also run `wrangler secret put OUTBOUND_PROXY_URL` and enter the proxy URL interactively.
4. Connect the platform to Cloudflare Builds and the web application to Vercel, using the repository settings in `reference/engineering/DEPLOYMENT.md`.
5. Apply D1 migrations remotely. In Polar, create the monthly Builder product and a webhook endpoint targeting `/api/auth/polar/webhooks` with `order.paid`, `order.refunded`, `customer.state_changed`, and `subscription.revoked` enabled.

Never commit `.dev.vars`. The web Worker does not receive provider secrets; it reaches the platform through `PLATFORM`.

## Reliability and privacy

- Public YouTube responses are cached in Workers KV and a retained stale value is returned when an upstream YouTube section fails.
- Private documents use one AI Search instance per user and project metadata filters; D1/R2 remain authoritative.
- Public transcript imports grow the shared hybrid corpus. Channel and playlist workflows eagerly fan out recent videos, with lazy access still supported.
- Queue tasks and Polar payment events have deterministic replay records. Credit reservation is a single conditional D1 mutation, followed by settlement or release.
- Prompt evidence is delimited as untrusted content; synthesis without aligned citations returns `INSUFFICIENT_EVIDENCE`.
- Account deletion requires cancellation of renewing subscriptions before anonymizing the Polar customer, revoking YouTube OAuth, removing private data, and queuing private AI Search instance removal.

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

## Hosted storyboard extraction

General provider operations use the pinned npm extraction library. The processor storyboard operation uses a committed bundle of shared source, verified against source in CI. It checks alternative player clients and the desktop watch page, normalizes WebP sheets to JPEG within byte, pixel and time limits, and logs safe source-selection diagnostics. See [storyboard recovery and diagnostics](../../platform/youtube-processor/STORYBOARDS.md) for error semantics, build commands and log fields.
