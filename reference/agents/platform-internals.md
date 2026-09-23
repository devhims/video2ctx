# Platform internals

Contributor guidance for changing this repository. The published skills under `.agents/skills/` describe how to *consume* video2ctx and deliberately carry no repository paths, so anything about the internal layout belongs here.

## Before changing deployment or architecture

Read the root `README.md`, `docs/open-source/local-development.mdx`, and `reference/engineering/IMPLEMENTATION.md`.

## Layer boundaries

- `platform/` owns authentication, authorization, credit metering, cache policy, and the public HTTP contract.
- `platform/youtube-processor/` owns outbound provider and storyboard calls. `platform/youtube-frames/` owns agent-only frame extraction and its media traffic. Frame extraction has no public data API route. Reach YouTube through these private containers. The Worker owns authentication, metering, and response validation.
- For individual-frame extraction, read `reference/engineering/FRAME_EXTRACTION.md`. The new container bundles the shared watch implementation and pins the published library independently.
- `packages/all-things-youtube/` is the extraction library. The processor installs an exact published npm version using its lockfile for general provider calls. Publish library changes before updating that dependency. The storyboard path is the narrow exception: `platform/youtube-processor/storyboard-extractor.mjs` is a committed bundle of the shared storyboard source, checked in CI and deployed with the processor. Regenerate it with `npm --prefix platform/youtube-processor run bundle`; do not edit the generated file. The processor-directory Docker context uses an allowlist that excludes credentials, tests, and local artifacts.
- `packages/video2ctx-cli/` is the independently published hosted-service CLI. Keep authentication and transport behavior compatible with both `video2ctx-platform` branches, and verify the npm tarball before releasing it.

## Agent session evidence

For session evidence reuse, memory, citation versions and deletion invariants, read `reference/engineering/SESSION_EVIDENCE.md`.

## Configuration

Non-secret bindings live in `platform/wrangler.jsonc`; runtime secrets stay outside source control. Local development needs Docker for processor cache misses. Proxy credentials belong in `OUTBOUND_PROXY_URL` and never in logs.

Use the fully local path by default. Preview and production migrations and Cloudflare deployments change shared state — confirm scope with the user first.

## Monitors

`platform/src/lib/monitor-check.ts` holds the check and alert path; `platform/src/lib/monitor-scheduler.ts` holds the per-monitor Durable Object schedule. Read both before changing monitor behavior. Preserve the public baseline behavior documented in the `video2ctx-platform` monitoring branch, plus the internal invariants: queue delivery before advancing the cursor, idempotent delivery, and rescheduling from the previous due time.

## After changes

Run the relevant package, platform, and container tests. Regenerate and verify docs when a public route or the OpenAPI contract changes, and re-check the published skills when a route moves between permission tiers.

`npm --prefix platform run build` includes test type checking. Caption recovery integration tests import extraction-library source, so the platform `prebuild` hook installs that package's locked dependencies, including development types, before running TypeScript. `npm run verify` uses the same build path. Cloudflare builds must use `npm run build` from `platform/`, rather than invoking `tsc` directly or disabling npm lifecycle scripts. This setup requires npm registry access or a populated npm cache and does not change the processor's published-library pin.


## Provider retries and latency

The processor timeout setting bounds the entire extraction operation, including response-body reads and retry delays. Production allows four attempts, visiting both configured slots before repeating in the same order. Transcript failures retry regardless of upstream code or retryable flag, except INVALID_INPUT. Even NOT_FOUND from both slots receives a second pass within the existing time limit. Other operations retain their explicit retryable-error policy. Partial empty track catalogs only probe each distinct slot once. Retry-After is honored within the total budget. Thirty-second health hints are local to a runtime isolate and may disappear on eviction; both processor slots share the configured outbound proxy, so fallback does not promise independent egress.

`youtube_processor_attempt` logs include an extraction ID, attempt duration, and total elapsed time. The container's `youtube_processor_timing` event uses the same ID and records operation duration, process CPU time, RSS, heap use, uptime, and concurrency at entry. CPU and memory are process-wide, so concurrent operations can contribute. Compare processor duration against container duration to locate binding/startup overhead, and inspect CPU and memory measurements before attributing latency to container size. These measurements do not identify the outbound IP or YouTube's challenge criteria.

### Caption metadata recovery

Caption retrieval classifies missing or malformed URLs in existing upstream tracks as retryable `INVALID_RESPONSE`. Fresh player metadata is requested inside the bounded library retry loop, preserving source language/track selection and desired output language. Invalid caller video IDs remain terminal. The Worker retains its existing processor attempt and total-time limits.

Transcript attempt diagnostics cross the request-coordinator RPC alongside results or failures, then attach to the agent tool call. They are not written into the shared content cache or replayed on cache/session hits. Records contain safe stages and error codes, never signed caption URLs. The library release must be published before advancing the processor's exact npm pin; local source changes alone do not update hosted extraction.
