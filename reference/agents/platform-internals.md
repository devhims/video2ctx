# Platform internals

Contributor guidance for changing this repository. The published skills under `.agents/skills/` describe how to *consume* video2ctx and deliberately carry no repository paths, so anything about the internal layout belongs here.

## Before changing deployment or architecture

Read the root `README.md`, `docs/open-source/local-development.mdx`, and `reference/engineering/IMPLEMENTATION.md`.

## Layer boundaries

- `platform/` owns authentication, authorization, credit metering, cache policy, and the public HTTP contract.
- `platform/youtube-processor/` owns the rollback outbound provider backend and storyboard calls. By default, with `YOUTUBE_EXTRACTION_BACKEND=worker`, core provider operations run through `platform/src/lib/youtube-worker-extraction.ts` using repository library source, a required Worker proxy transport. Read `reference/engineering/WORKER_EXTRACTION.md` before changing that path. `platform/youtube-frames/` owns agent-only frame extraction and its media traffic. Frame extraction has no public data API route. Route media requests through these private containers. The Worker owns authentication, metering, and response validation.
- For individual-frame extraction, read `reference/engineering/FRAME_EXTRACTION.md`. The new container bundles the shared watch implementation and pins the published library independently.
- `packages/all-things-youtube/` is the extraction library. The processor installs an exact published npm version using its lockfile for general provider calls. Publish library changes before updating that dependency. The storyboard path is the narrow exception: `platform/youtube-processor/storyboard-extractor.mjs` is a committed bundle of the shared storyboard source, checked in CI and deployed with the processor. Regenerate it with `npm --prefix platform/youtube-processor run bundle`; do not edit the generated file. The processor-directory Docker context uses an allowlist that excludes credentials, tests, and local artifacts.
- `packages/video2ctx-cli/` is the independently published hosted-service CLI. Keep authentication and transport behavior compatible with both `video2ctx-platform` branches, and verify the npm tarball before releasing it.

## Shared video evidence

For the DB-first public video catalog, R2 object layout, progressive retrieval, recovery and provisioning, read `reference/engineering/VIDEO_CATALOG.md`.

For Sources history, user DO reference ownership, and restoration from shared assets, read `reference/engineering/SOURCE_HISTORY.md`.

## Agent session evidence

For session evidence reuse, memory, citation versions and deletion invariants, read `reference/engineering/SESSION_EVIDENCE.md`.

## Agent date context

Models otherwise assume the year from their training data. `POST /v1/agent` accepts an optional IANA `timeZone`, which the dashboard fills from the browser. The run row stores it in `agent_runs.time_zone`, and `currentDateGuidance(created_at, time_zone)` in `platform/src/agents/runtime/current-date.ts` renders one date line from the run's admission time. Every phase and recovery of a run therefore agrees on "today". The line is appended to the end of the classifier, research loop, context-gathering and finalizer instructions, never to the untrusted user payload. It carries the date only, so it changes once a day and leaves the cached prompt prefix intact. Missing or older runs use UTC. The visual and transcript analysts do not receive it.

## Agent video length limit

The agent works on videos up to `AGENT_MAX_VIDEO_SECONDS`, a `wrangler.jsonc` var that defaults to 7200 (2 hours) and is bounded to 60 through 86400. A multi-hour transcript with word timings is several megabytes, and the runtime builds a copy of every excerpt for each evidence read and analysis pass. On October 2, 2026 a 6-hour livestream (8,430 segments, about 4 MB stored) exhausted the agent Durable Object's memory, and alarm recovery repeated the same work until the SDK's memory-reset breaker stopped it. The limit is checked at three points. `search_youtube` drops over-limit videos from the whole provider page before its 12-result cap, so long broadcasts cannot crowd out eligible videos in the one search topic research allows, and adds a `VIDEO_DURATION_LIMIT` warning; results without a duration pass. The session provider rejects a fetched transcript whose last segment ends past the limit before saving it, and `get_video_transcript` repeats the check for runs without a session store. `SessionEvidenceStore` refuses to read, analyze or search-index a saved transcript over the limit, judged from its stored `endMs` without loading the blob, which covers sessions saved before the limit existed. Provider reuse checks the same metadata before the lookup reads the blob, and evidence search excludes long transcripts indexed before the limit inside its full-text query, before the 20-row cap, so their many excerpts cannot crowd out short-video matches. Their index rows stay, so raising the limit makes them searchable again. Rejections use the code `VIDEO_TOO_LONG`, and `research_video_transcripts` replaces such a video with the next search candidate, like a video without captions. That includes a saved transcript passed by `assetVersion`, whose video ID comes from session metadata. The public data API is not limited.

## Configuration

Non-secret bindings live in `platform/wrangler.jsonc`; runtime secrets stay outside source control. Local development needs Docker for processor cache misses. Proxy credentials belong in the processor pool secret `OUTBOUND_PROXY_URLS` or the legacy `OUTBOUND_PROXY_URL`, never in logs. See `platform/youtube-processor/README.md` for connection selection and rollout.

Use the fully local path by default. Preview and production migrations and Cloudflare deployments change shared state — confirm scope with the user first.

## Monitors

`platform/src/lib/monitor-check.ts` holds the check and alert path; `platform/src/lib/monitor-scheduler.ts` holds the per-monitor Durable Object schedule. Read both before changing monitor behavior. Preserve the public baseline behavior documented in the `video2ctx-platform` monitoring branch, plus the internal invariants: queue delivery before advancing the cursor, idempotent delivery, and rescheduling from the previous due time.

## After changes

Run the relevant package, platform, and container tests. Regenerate and verify docs when a public route or the OpenAPI contract changes, and re-check the published skills when a route moves between permission tiers.

`npm --prefix platform run build` includes test type checking. Caption recovery integration tests import extraction-library source, so the platform `prebuild` hook installs that package's locked dependencies, including development types, before running TypeScript. `npm run verify` uses the same build path. Cloudflare builds must use `npm run build` from `platform/`, rather than invoking `tsc` directly or disabling npm lifecycle scripts. This setup requires npm registry access or a populated npm cache and does not change the processor's published-library pin.


## Provider retries and latency

The processor timeout setting bounds the entire extraction operation, including response-body reads and retry delays. Production allows four attempts, visiting both configured slots before repeating in the same order. Transcript failures retry regardless of upstream code or retryable flag, except INVALID_INPUT and confirmed AUTH_REQUIRED restrictions. Even NOT_FOUND from both slots receives a second pass within the existing time limit. Other operations retain their explicit retryable-error policy. Partial empty track catalogs only probe each distinct slot once. Retry-After is honored within the total budget. Thirty-second health hints are local to a runtime isolate and may disappear on eviction; processor slots select distinct entries from `OUTBOUND_PROXY_URLS` when a pool is configured. With a single legacy proxy, fallback still shares egress. Verify public exit independence with the provider.

Proxy choice is independent of the processor instance. Each storyboard attempt sends an egress slot from its own rotation over the configured pool, so four attempts visit four proxies even with two processor instances. When the Worker cannot read the pool, the egress slot falls back to the container slot.

Worker extraction gives each route 5 seconds to return its first response, except on the last attempt. The deadline starts with the route's first request and is shared by concurrent requests, such as the player and watch-page calls transcript metadata makes together; any response clears it. A stall latches the route as a retryable `UPSTREAM_ERROR` with failure kind `timeout`, so library retries on it fail at once and the operation moves to the next proxy. Once a route has answered, only the 25-second attempt timeout applies. Residential exits can stall or return 522 independently of YouTube; see `reference/engineering/FRAME_EXTRACTION.md` for the October 2026 measurements.

The `ProxyHealth` Durable Object, bound as `PROXY_HEALTH`, keeps one shared cooldown record per proxy URL for Worker extraction, storyboards and frames. Keys are truncated SHA-256 hashes of the normalized URL, so no URL, host or credential is stored. Before each operation the caller reads the record and orders slots: healthy ones first in a random rotation, cooling ones last by recovery time. No slot is dropped, so a pool that is entirely cooling still gets tried. A route failure (no response, a first-response stall, or an attempt timeout before any response) cools a proxy for 2 minutes, doubling up to 15. A rate limit cools it for 5 minutes, doubling up to 30. Rate limits are read from every place YouTube reports them: an HTTP 429, a metadata bot challenge, a caption bot challenge (HTTP 200, surfaced as `UNAVAILABLE` with the library's structured `reason: 'bot_challenge'`; a bare `UNAVAILABLE` stays ambiguous), storyboard player or sheet 429s in the captured diagnostics (the processor keeps the upstream status on its terminal `request` event), and frame player or media-CDN 429s attributed to the proxy selected before them. The storyboard and frames containers turn a bot-challenge playability reason into `failureReason: 'bot_challenge'`, since the reason text itself is never stored. A frames job that still finishes on its proxy counts as a success. Failures reported while a proxy is already cooling do not escalate, a failure more than 30 minutes after the last one starts over, and one success clears the cooldown. Successes are written only for proxies with strikes, so a healthy pool adds one read and no write per operation. Frames receive the order in an `x-proxy-order` header and report per-slot outcomes through their `proxy` diagnostics. Storyboards record only successes and rate limits, because other processor failures do not say whether the proxy or the video failed. Each isolate reuses a lookup for 10 seconds and applies its own reports locally at once, so most operations make no call to the object. A call gets 500 ms, because a single global object can be a cross-region round trip away and slower again after eviction. A failed or slow lookup falls back to the random rotation, or to the isolate's last known entries, and pauses calls to the object for 10 seconds, so an outage costs one wait per isolate, not one per operation. A lost report never fails extraction. Worker attempt logs carry `healthSource` and `healthLookupMs` for tuning the limit. `GET /v1/admin/proxy-health` shows each slot's host, port, cooldown and counts.

All-comments crawls are capped at five pages, about 100 comments in roughly 6 seconds through a residential proxy. A crawl must finish inside one 25-second attempt, because a timed-out attempt discards its pages and the next attempt restarts from page one; the earlier 100-page cap failed every time. The agent comments tool reads one default-ranked page and pages with `continuation`; it no longer exposes `all`.

`youtube_processor_attempt` logs include an extraction ID, attempt duration, and total elapsed time. The container's `youtube_processor_timing` event uses the same ID and records operation duration, process CPU time, RSS, heap use, uptime, and concurrency at entry. CPU and memory are process-wide, so concurrent operations can contribute. Compare processor duration against container duration to locate binding/startup overhead, and inspect CPU and memory measurements before attributing latency to container size. These measurements do not identify the outbound IP or YouTube's challenge criteria.

### Caption metadata recovery

Caption retrieval classifies missing or malformed URLs in existing upstream tracks as retryable `INVALID_RESPONSE`. Fresh player metadata is requested inside the bounded library retry loop, preserving source language/track selection and desired output language. Invalid caller video IDs remain terminal. The Worker retains its existing processor attempt and total-time limits.

Transcript attempt diagnostics cross the request-coordinator RPC alongside results or failures, then attach to the agent tool call. They are not written into the shared content cache or replayed on cache/session hits. Records contain safe stages and error codes, never signed caption URLs. The library release must be published before advancing the processor's exact npm pin; local source changes alone do not update the container backend. The default Worker backend bundles repository source and needs no npm release.
